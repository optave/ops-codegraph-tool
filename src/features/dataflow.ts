/**
 * Dataflow analysis — define/use chains and data movement edges.
 *
 * Adds three edge types to track how data moves through functions:
 *   - flows_to:  parameter/variable flows into another function as an argument
 *   - returns:   a call's return value is captured and used in the caller
 *   - mutates:   a parameter-derived value is mutated (e.g. arr.push())
 *
 * Opt-in via `build --dataflow`. Supports all languages with DATAFLOW_RULES.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATAFLOW_RULES } from '../ast-analysis/rules/index.js';
import {
  makeDataflowRules as _makeDataflowRules,
  buildExtensionSet,
  buildExtToLangMap,
} from '../ast-analysis/shared.js';
import { walkWithVisitors } from '../ast-analysis/visitor.js';
import { createDataflowVisitor } from '../ast-analysis/visitors/dataflow-visitor.js';
import { hasDataflowTable, openReadonlyOrFail, openReadonlyWithNative } from '../db/index.js';
import { ALL_SYMBOL_KINDS, normalizeSymbol } from '../domain/queries.js';
import { debug, info } from '../infrastructure/logger.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import { paginateResult } from '../shared/paginate.js';
import type { BetterSqlite3Database, NodeRow, TreeSitterNode } from '../types.js';
import { findNodes } from './shared/find-nodes.js';

// Re-export for backward compatibility
export { _makeDataflowRules as makeDataflowRules, DATAFLOW_RULES };

export const DATAFLOW_EXTENSIONS = buildExtensionSet(DATAFLOW_RULES);

// ── AST helpers (now in ast-analysis/visitor-utils.js, kept as re-exports) ──

// ── extractDataflow ──────────────────────────────────────────────────────────

// Note: This local DataflowResult intentionally differs from the canonical
// DataflowResult in types.ts. The canonical type describes the visitor's raw
// output shape, while this module's insertDataflowEdges casts fields to
// richer local interfaces (ArgFlow, Assignment, Mutation) with additional
// properties populated during resolution. Aligning them requires unifying
// the visitor output and DB-insertion shapes — tracked separately.
interface DataflowResult {
  parameters: unknown[];
  returns: unknown[];
  assignments: unknown[];
  argFlows: unknown[];
  mutations: unknown[];
}

export function extractDataflow(
  tree: { rootNode: TreeSitterNode },
  _filePath: string,
  _definitions: unknown[],
  langId = 'javascript',
): DataflowResult {
  const rules = DATAFLOW_RULES.get(langId);
  if (!rules) return { parameters: [], returns: [], assignments: [], argFlows: [], mutations: [] };

  const visitor = createDataflowVisitor(rules);
  const results = walkWithVisitors(tree.rootNode, [visitor], langId, {
    functionNodeTypes: (rules as { functionNodes: Set<string> }).functionNodes,
    getFunctionName: () => null, // dataflow visitor handles its own name extraction
  });

  return results.dataflow as DataflowResult;
}

// ── Build-Time Helpers ──────────────────────────────────────────────────────

interface FileSymbolsDataflow {
  _tree?: { rootNode: TreeSitterNode } | null;
  _langId?: string | null;
  definitions: Array<{ name: string; kind: string; line: number }>;
  dataflow?: DataflowResult | null;
}

async function initDataflowParsers(
  fileSymbols: Map<string, FileSymbolsDataflow>,
): Promise<{ parsers: unknown; getParserFn: ((parsers: any, absPath: string) => any) | null }> {
  let needsFallback = false;

  for (const [relPath, symbols] of fileSymbols) {
    if (!symbols._tree && !symbols.dataflow) {
      const ext = path.extname(relPath).toLowerCase();
      if (DATAFLOW_EXTENSIONS.has(ext)) {
        needsFallback = true;
        break;
      }
    }
  }

  let parsers: unknown = null;
  let getParserFn: ((parsers: any, absPath: string) => any) | null = null;

  if (needsFallback) {
    const { createParsers } = await import('../domain/parser.js');
    parsers = await createParsers();
    const mod = await import('../domain/parser.js');
    getParserFn = mod.getParser;
  }

  return { parsers, getParserFn };
}

function getDataflowForFile(
  symbols: FileSymbolsDataflow,
  relPath: string,
  rootDir: string,
  extToLang: Map<string, string>,
  parsers: unknown,
  getParserFn: ((parsers: any, absPath: string) => any) | null,
): DataflowResult | null {
  if (symbols.dataflow) return symbols.dataflow;

  let tree = symbols._tree;
  let langId = symbols._langId;

  if (!tree) {
    if (!getParserFn) return null;
    const ext = path.extname(relPath).toLowerCase();
    langId = extToLang.get(ext);
    if (!langId || !DATAFLOW_RULES.has(langId)) return null;

    const absPath = path.join(rootDir, relPath);
    let code: string;
    try {
      code = fs.readFileSync(absPath, 'utf-8');
    } catch (e: unknown) {
      debug(`dataflow: cannot read ${relPath}: ${(e as Error).message}`);
      return null;
    }

    const parser = getParserFn(parsers, absPath);
    if (!parser) return null;

    try {
      tree = parser.parse(code);
    } catch (e: unknown) {
      debug(`dataflow: parse failed for ${relPath}: ${(e as Error).message}`);
      return null;
    }
  }

  if (!langId) {
    const ext = path.extname(relPath).toLowerCase();
    langId = extToLang.get(ext);
    if (!langId) return null;
  }

  if (!DATAFLOW_RULES.has(langId)) return null;

  return extractDataflow(
    tree as { rootNode: TreeSitterNode },
    relPath,
    symbols.definitions,
    langId,
  );
}

interface ArgFlow {
  callerFunc: string;
  calleeName: string;
  argIndex: number;
  expression: string;
  line: number;
  confidence: number;
}

interface Assignment {
  sourceCallName: string;
  callerFunc: string;
  expression: string;
  line: number;
}

interface Mutation {
  funcName: string;
  binding?: { type: string };
  mutatingExpr: string;
  line: number;
}

function insertDataflowEdges(
  insert: { run(...params: unknown[]): unknown },
  data: DataflowResult,
  resolveNode: (name: string) => { id: number } | null,
): number {
  let edgeCount = 0;

  for (const flow of data.argFlows as ArgFlow[]) {
    const sourceNode = resolveNode(flow.callerFunc);
    const targetNode = resolveNode(flow.calleeName);
    if (sourceNode && targetNode) {
      insert.run(
        sourceNode.id,
        targetNode.id,
        'flows_to',
        flow.argIndex,
        flow.expression,
        flow.line,
        flow.confidence,
      );
      edgeCount++;
    }
  }

  for (const assignment of data.assignments as Assignment[]) {
    const producerNode = resolveNode(assignment.sourceCallName);
    const consumerNode = resolveNode(assignment.callerFunc);
    if (producerNode && consumerNode) {
      insert.run(
        producerNode.id,
        consumerNode.id,
        'returns',
        null,
        assignment.expression,
        assignment.line,
        1.0,
      );
      edgeCount++;
    }
  }

  for (const mut of data.mutations as Mutation[]) {
    const mutatorNode = resolveNode(mut.funcName);
    if (mutatorNode && mut.binding?.type === 'param') {
      insert.run(mutatorNode.id, mutatorNode.id, 'mutates', null, mut.mutatingExpr, mut.line, 1.0);
      edgeCount++;
    }
  }

  return edgeCount;
}

// ── buildDataflowEdges ──────────────────────────────────────────────────────

export async function buildDataflowEdges(
  db: BetterSqlite3Database,
  fileSymbols: Map<string, FileSymbolsDataflow>,
  rootDir: string,
  engineOpts?: {
    nativeDb?: { bulkInsertDataflow?(edges: Array<Record<string, unknown>>): number };
  },
): Promise<void> {
  const extToLang = buildExtToLangMap();

  // ── Native bulk-insert fast path ──────────────────────────────────────
  const nativeDb = engineOpts?.nativeDb;
  if (nativeDb?.bulkInsertDataflow) {
    let needsJsFallback = false;
    const nativeEdges: Array<Record<string, unknown>> = [];

    const getNodeByNameAndFile = db.prepare<{
      id: number;
      name: string;
      kind: string;
      file: string;
      line: number;
    }>(
      `SELECT id, name, kind, file, line FROM nodes
       WHERE name = ? AND file = ? AND kind IN ('function', 'method')`,
    );
    const getNodeByName = db.prepare<{
      id: number;
      name: string;
      kind: string;
      file: string;
      line: number;
    }>(
      `SELECT id, name, kind, file, line FROM nodes
       WHERE name = ? AND kind IN ('function', 'method')
       ORDER BY file, line LIMIT 10`,
    );

    for (const [relPath, symbols] of fileSymbols) {
      const ext = path.extname(relPath).toLowerCase();
      if (!DATAFLOW_EXTENSIONS.has(ext)) continue;
      if (!symbols.dataflow) {
        needsJsFallback = true;
        break;
      }

      const resolveNode = (funcName: string): { id: number } | null => {
        const local = getNodeByNameAndFile.all(funcName, relPath);
        if (local.length > 0) return local[0]!;
        const global = getNodeByName.all(funcName);
        return global.length > 0 ? global[0]! : null;
      };

      const data = symbols.dataflow;
      for (const flow of data.argFlows as ArgFlow[]) {
        const sourceNode = resolveNode(flow.callerFunc);
        const targetNode = resolveNode(flow.calleeName);
        if (sourceNode && targetNode) {
          nativeEdges.push({
            sourceId: sourceNode.id,
            targetId: targetNode.id,
            kind: 'flows_to',
            paramIndex: flow.argIndex,
            expression: flow.expression,
            line: flow.line,
            confidence: flow.confidence,
          });
        }
      }
      for (const assignment of data.assignments as Assignment[]) {
        const producerNode = resolveNode(assignment.sourceCallName);
        const consumerNode = resolveNode(assignment.callerFunc);
        if (producerNode && consumerNode) {
          nativeEdges.push({
            sourceId: producerNode.id,
            targetId: consumerNode.id,
            kind: 'returns',
            paramIndex: null,
            expression: assignment.expression,
            line: assignment.line,
            confidence: 1.0,
          });
        }
      }
      for (const mut of data.mutations as Mutation[]) {
        const mutatorNode = resolveNode(mut.funcName);
        if (mutatorNode && mut.binding?.type === 'param') {
          nativeEdges.push({
            sourceId: mutatorNode.id,
            targetId: mutatorNode.id,
            kind: 'mutates',
            paramIndex: null,
            expression: mut.mutatingExpr,
            line: mut.line,
            confidence: 1.0,
          });
        }
      }
    }

    if (!needsJsFallback) {
      if (nativeEdges.length > 0) {
        const inserted = nativeDb.bulkInsertDataflow(nativeEdges);
        info(`Dataflow (native bulk): ${inserted} edges inserted`);
      }
      return;
    }
    debug('Dataflow: some files lack pre-computed data — falling back to JS');
  }

  // ── JS fallback path ─────────────────────────────────────────────────
  const { parsers, getParserFn } = await initDataflowParsers(fileSymbols);

  const insert = db.prepare(
    `INSERT INTO dataflow (source_id, target_id, kind, param_index, expression, line, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const getNodeByNameAndFile = db.prepare<{
    id: number;
    name: string;
    kind: string;
    file: string;
    line: number;
  }>(
    `SELECT id, name, kind, file, line FROM nodes
     WHERE name = ? AND file = ? AND kind IN ('function', 'method')`,
  );

  const getNodeByName = db.prepare<{
    id: number;
    name: string;
    kind: string;
    file: string;
    line: number;
  }>(
    `SELECT id, name, kind, file, line FROM nodes
     WHERE name = ? AND kind IN ('function', 'method')
     ORDER BY file, line LIMIT 10`,
  );

  let totalEdges = 0;

  const tx = db.transaction(() => {
    for (const [relPath, symbols] of fileSymbols) {
      const ext = path.extname(relPath).toLowerCase();
      if (!DATAFLOW_EXTENSIONS.has(ext)) continue;

      const data = getDataflowForFile(symbols, relPath, rootDir, extToLang, parsers, getParserFn);
      if (!data) continue;

      const resolveNode = (funcName: string): { id: number } | null => {
        const local = getNodeByNameAndFile.all(funcName, relPath);
        if (local.length > 0) return local[0]!;
        const global = getNodeByName.all(funcName);
        return global.length > 0 ? global[0]! : null;
      };

      totalEdges += insertDataflowEdges(insert, data, resolveNode);
    }
  });

  tx();
  info(`Dataflow: ${totalEdges} edges inserted`);
}

// ── Query functions ─────────────────────────────────────────────────────────

// findNodes imported from ./shared/find-nodes.js

interface DataflowStmts {
  flowsToOut: ReturnType<BetterSqlite3Database['prepare']>;
  flowsToIn: ReturnType<BetterSqlite3Database['prepare']>;
  returnsOut: ReturnType<BetterSqlite3Database['prepare']>;
  returnsIn: ReturnType<BetterSqlite3Database['prepare']>;
  mutatesOut: ReturnType<BetterSqlite3Database['prepare']>;
  mutatesIn: ReturnType<BetterSqlite3Database['prepare']>;
}

function prepareDataflowStmts(db: BetterSqlite3Database): DataflowStmts {
  return {
    flowsToOut: db.prepare(
      `SELECT d.*, n.name AS target_name, n.kind AS target_kind, n.file AS target_file, n.line AS target_line
     FROM dataflow d JOIN nodes n ON d.target_id = n.id
     WHERE d.source_id = ? AND d.kind = 'flows_to'`,
    ),
    flowsToIn: db.prepare(
      `SELECT d.*, n.name AS source_name, n.kind AS source_kind, n.file AS source_file, n.line AS source_line
     FROM dataflow d JOIN nodes n ON d.source_id = n.id
     WHERE d.target_id = ? AND d.kind = 'flows_to'`,
    ),
    returnsOut: db.prepare(
      `SELECT d.*, n.name AS target_name, n.kind AS target_kind, n.file AS target_file, n.line AS target_line
     FROM dataflow d JOIN nodes n ON d.target_id = n.id
     WHERE d.source_id = ? AND d.kind = 'returns'`,
    ),
    returnsIn: db.prepare(
      `SELECT d.*, n.name AS source_name, n.kind AS source_kind, n.file AS source_file, n.line AS source_line
     FROM dataflow d JOIN nodes n ON d.source_id = n.id
     WHERE d.target_id = ? AND d.kind = 'returns'`,
    ),
    mutatesOut: db.prepare(
      `SELECT d.*, n.name AS target_name, n.kind AS target_kind, n.file AS target_file, n.line AS target_line
     FROM dataflow d JOIN nodes n ON d.target_id = n.id
     WHERE d.source_id = ? AND d.kind = 'mutates'`,
    ),
    mutatesIn: db.prepare(
      `SELECT d.*, n.name AS source_name, n.kind AS source_kind, n.file AS source_file, n.line AS source_line
     FROM dataflow d JOIN nodes n ON d.source_id = n.id
     WHERE d.target_id = ? AND d.kind = 'mutates'`,
    ),
  };
}

function buildNodeDataflowResult(
  node: NodeRow,
  stmts: DataflowStmts,
  db: BetterSqlite3Database,
  hc: Map<string, string | null>,
  noTests: boolean,
): Record<string, unknown> {
  const sym = normalizeSymbol(node, db, hc);

  const flowsTo = stmts.flowsToOut.all(node.id).map((r: any) => ({
    target: r.target_name,
    kind: r.target_kind,
    file: r.target_file,
    line: r.line,
    paramIndex: r.param_index,
    expression: r.expression,
    confidence: r.confidence,
  }));

  const flowsFrom = stmts.flowsToIn.all(node.id).map((r: any) => ({
    source: r.source_name,
    kind: r.source_kind,
    file: r.source_file,
    line: r.line,
    paramIndex: r.param_index,
    expression: r.expression,
    confidence: r.confidence,
  }));

  const returnConsumers = stmts.returnsOut.all(node.id).map((r: any) => ({
    consumer: r.target_name,
    kind: r.target_kind,
    file: r.target_file,
    line: r.line,
    expression: r.expression,
  }));

  const returnedBy = stmts.returnsIn.all(node.id).map((r: any) => ({
    producer: r.source_name,
    kind: r.source_kind,
    file: r.source_file,
    line: r.line,
    expression: r.expression,
  }));

  const mutatesTargets = stmts.mutatesOut.all(node.id).map((r: any) => ({
    target: r.target_name,
    expression: r.expression,
    line: r.line,
  }));

  const mutatedBy = stmts.mutatesIn.all(node.id).map((r: any) => ({
    source: r.source_name,
    expression: r.expression,
    line: r.line,
  }));

  if (noTests) {
    const filter = (arr: any[]) => arr.filter((r: any) => !isTestFile(r.file));
    return {
      ...sym,
      flowsTo: filter(flowsTo),
      flowsFrom: filter(flowsFrom),
      returns: returnConsumers.filter((r) => !isTestFile(r.file)),
      returnedBy: returnedBy.filter((r) => !isTestFile(r.file)),
      mutates: mutatesTargets,
      mutatedBy,
    };
  }

  return {
    ...sym,
    flowsTo,
    flowsFrom,
    returns: returnConsumers,
    returnedBy,
    mutates: mutatesTargets,
    mutatedBy,
  };
}

export function dataflowData(
  name: string,
  customDbPath?: string,
  opts: { noTests?: boolean; file?: string; kind?: string; limit?: number; offset?: number } = {},
): Record<string, unknown> {
  const { db, nativeDb, close } = openReadonlyWithNative(customDbPath);
  try {
    const noTests = opts.noTests || false;

    if (!hasDataflowTable(db)) {
      return {
        name,
        results: [],
        warning:
          'No dataflow data found. Rebuild with `codegraph build` (dataflow is now included by default).',
      };
    }

    const nodes = findNodes(
      db,
      name,
      { noTests, file: opts.file, kind: opts.kind },
      ALL_SYMBOL_KINDS as unknown as string[],
    );
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    // ── Native fast path: 6 queries per node → 1 napi call per node ──
    if (nativeDb?.getDataflowEdges) {
      const hc = new Map<string, string | null>();
      const results = nodes.map((node: NodeRow) => {
        const sym = normalizeSymbol(node, db, hc);
        const d = nativeDb.getDataflowEdges!(node.id);

        const flowsTo = d.flowsToOut.map((r) => ({
          target: r.name,
          kind: r.kind,
          file: r.file,
          line: r.line,
          paramIndex: r.paramIndex,
          expression: r.expression,
          confidence: r.confidence,
        }));
        const flowsFrom = d.flowsToIn.map((r) => ({
          source: r.name,
          kind: r.kind,
          file: r.file,
          line: r.line,
          paramIndex: r.paramIndex,
          expression: r.expression,
          confidence: r.confidence,
        }));
        const returnConsumers = d.returnsOut.map((r) => ({
          consumer: r.name,
          kind: r.kind,
          file: r.file,
          line: r.line,
          expression: r.expression,
        }));
        const returnedBy = d.returnsIn.map((r) => ({
          producer: r.name,
          kind: r.kind,
          file: r.file,
          line: r.line,
          expression: r.expression,
        }));
        const mutatesTargets = d.mutatesOut.map((r) => ({
          target: r.name,
          expression: r.expression,
          line: r.line,
        }));
        const mutatedBy = d.mutatesIn.map((r) => ({
          source: r.name,
          expression: r.expression,
          line: r.line,
        }));

        if (noTests) {
          const filter = (arr: any[]) => arr.filter((r: any) => !isTestFile(r.file));
          return {
            ...sym,
            flowsTo: filter(flowsTo),
            flowsFrom: filter(flowsFrom),
            returns: returnConsumers.filter((r) => !isTestFile(r.file)),
            returnedBy: returnedBy.filter((r) => !isTestFile(r.file)),
            mutates: mutatesTargets,
            mutatedBy,
          };
        }
        return {
          ...sym,
          flowsTo,
          flowsFrom,
          returns: returnConsumers,
          returnedBy,
          mutates: mutatesTargets,
          mutatedBy,
        };
      });
      const base = { name, results };
      return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
    }

    // ── JS fallback ───────────────────────────────────────────────────
    const stmts = prepareDataflowStmts(db);
    const hc = new Map<string, string | null>();
    const results = nodes.map((node: NodeRow) =>
      buildNodeDataflowResult(node, stmts, db, hc, noTests),
    );

    const base = { name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    close();
  }
}

interface BfsParentEntry {
  parentId: number;
  edgeKind: string;
  expression: string;
}

/** BFS through dataflow edges to find a path from source to target. */
function bfsDataflowPath(
  db: BetterSqlite3Database,
  sourceId: number,
  targetId: number,
  maxDepth: number,
  noTests: boolean,
): Map<number, BfsParentEntry> | null {
  const neighborStmt = db.prepare(
    `SELECT n.id, n.name, n.kind, n.file, n.line, d.kind AS edge_kind, d.expression
     FROM dataflow d JOIN nodes n ON d.target_id = n.id
     WHERE d.source_id = ? AND d.kind IN ('flows_to', 'returns')`,
  );

  const visited = new Set<number>([sourceId]);
  const parent = new Map<number, BfsParentEntry>();
  let queue = [sourceId];
  let found = false;

  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextQueue: number[] = [];
    for (const currentId of queue) {
      const neighbors = neighborStmt.all(currentId) as Array<{
        id: number;
        file: string;
        edge_kind: string;
        expression: string;
      }>;
      for (const n of neighbors) {
        if (noTests && isTestFile(n.file)) continue;
        if (n.id === targetId) {
          if (!found) {
            found = true;
            parent.set(n.id, {
              parentId: currentId,
              edgeKind: n.edge_kind,
              expression: n.expression,
            });
          }
          continue;
        }
        if (!visited.has(n.id)) {
          visited.add(n.id);
          parent.set(n.id, {
            parentId: currentId,
            edgeKind: n.edge_kind,
            expression: n.expression,
          });
          nextQueue.push(n.id);
        }
      }
    }
    if (found) break;
    queue = nextQueue;
    if (queue.length === 0) break;
  }

  return found ? parent : null;
}

/** Reconstruct a path from BFS parent map. */
function reconstructDataflowPath(
  db: BetterSqlite3Database,
  parent: Map<number, BfsParentEntry>,
  sourceId: number,
  targetId: number,
): Array<Record<string, unknown>> {
  const nodeById = db.prepare('SELECT * FROM nodes WHERE id = ?');
  const hc = new Map<string, string | null>();
  const pathItems: Array<Record<string, unknown>> = [];
  let cur: number | undefined = targetId;
  while (cur !== undefined) {
    const nodeRow = nodeById.get(cur) as NodeRow;
    const parentInfo = parent.get(cur);
    pathItems.unshift({
      ...normalizeSymbol(nodeRow, db, hc),
      edgeKind: parentInfo?.edgeKind ?? null,
      expression: parentInfo?.expression ?? null,
    });
    cur = parentInfo?.parentId;
    if (cur === sourceId) {
      const srcRow = nodeById.get(cur) as NodeRow;
      pathItems.unshift({
        ...normalizeSymbol(srcRow, db, hc),
        edgeKind: null,
        expression: null,
      });
      break;
    }
  }
  return pathItems;
}

export function dataflowPathData(
  from: string,
  to: string,
  customDbPath?: string,
  opts: {
    noTests?: boolean;
    maxDepth?: number;
    fromFile?: string;
    toFile?: string;
    kind?: string;
    limit?: number;
    offset?: number;
  } = {},
): Record<string, unknown> {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const maxDepth = opts.maxDepth || 10;

    if (!hasDataflowTable(db)) {
      return {
        from,
        to,
        found: false,
        warning:
          'No dataflow data found. Rebuild with `codegraph build` (dataflow is now included by default).',
      };
    }

    const fromNodes = findNodes(
      db,
      from,
      { noTests, file: opts.fromFile, kind: opts.kind },
      ALL_SYMBOL_KINDS as unknown as string[],
    );
    if (fromNodes.length === 0) {
      return { from, to, found: false, error: `No symbol matching "${from}"` };
    }

    const toNodes = findNodes(
      db,
      to,
      { noTests, file: opts.toFile, kind: opts.kind },
      ALL_SYMBOL_KINDS as unknown as string[],
    );
    if (toNodes.length === 0) {
      return { from, to, found: false, error: `No symbol matching "${to}"` };
    }

    const sourceNode = fromNodes[0] as NodeRow;
    const targetNode = toNodes[0] as NodeRow;

    if (sourceNode.id === targetNode.id) {
      const hc = new Map<string, string | null>();
      const sym = normalizeSymbol(sourceNode, db, hc);
      return { from, to, found: true, hops: 0, path: [{ ...sym, edgeKind: null }] };
    }

    const parent = bfsDataflowPath(db, sourceNode.id, targetNode.id, maxDepth, noTests);
    if (!parent) {
      return { from, to, found: false };
    }

    const pathItems = reconstructDataflowPath(db, parent, sourceNode.id, targetNode.id);
    return { from, to, found: true, hops: pathItems.length - 1, path: pathItems };
  } finally {
    db.close();
  }
}

/** BFS forward through return-value consumers to build impact levels. */
function bfsReturnConsumers(
  node: NodeRow,
  consumersStmt: ReturnType<BetterSqlite3Database['prepare']>,
  db: BetterSqlite3Database,
  hc: Map<string, string | null>,
  maxDepth: number,
  noTests: boolean,
): { levels: Record<number, unknown[]>; totalAffected: number } {
  const visited = new Set<number>([node.id]);
  const levels: Record<number, unknown[]> = {};
  let frontier = [node.id];

  for (let d = 1; d <= maxDepth; d++) {
    const nextFrontier: number[] = [];
    for (const fid of frontier) {
      const consumers = consumersStmt.all(fid) as NodeRow[];
      for (const c of consumers) {
        if (!visited.has(c.id) && (!noTests || !isTestFile(c.file))) {
          visited.add(c.id);
          nextFrontier.push(c.id);
          if (!levels[d]) levels[d] = [];
          levels[d]!.push(normalizeSymbol(c, db, hc));
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return { levels, totalAffected: visited.size - 1 };
}

export function dataflowImpactData(
  name: string,
  customDbPath?: string,
  opts: {
    noTests?: boolean;
    depth?: number;
    file?: string;
    kind?: string;
    limit?: number;
    offset?: number;
  } = {},
): Record<string, unknown> {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const maxDepth = opts.depth || 5;
    const noTests = opts.noTests || false;

    if (!hasDataflowTable(db)) {
      return {
        name,
        results: [],
        warning:
          'No dataflow data found. Rebuild with `codegraph build` (dataflow is now included by default).',
      };
    }

    const nodes = findNodes(
      db,
      name,
      { noTests, file: opts.file, kind: opts.kind },
      ALL_SYMBOL_KINDS as unknown as string[],
    );
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    const consumersStmt = db.prepare(
      `SELECT DISTINCT n.*
     FROM dataflow d JOIN nodes n ON d.target_id = n.id
     WHERE d.source_id = ? AND d.kind = 'returns'`,
    );

    const hc = new Map<string, string | null>();
    const results = nodes.map((node: NodeRow) => {
      const sym = normalizeSymbol(node, db, hc);
      const { levels, totalAffected } = bfsReturnConsumers(
        node,
        consumersStmt,
        db,
        hc,
        maxDepth,
        noTests,
      );
      return { ...sym, levels, totalAffected };
    });

    const base = { name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}
