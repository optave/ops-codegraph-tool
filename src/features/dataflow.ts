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
import type { NormalizedSymbol } from '../shared/normalize.js';
import { paginateResult } from '../shared/paginate.js';
import type { BetterSqlite3Database, NativeDatabase, NodeRow, TreeSitterNode } from '../types.js';
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

// ── P1: Visitor internal shapes ───────────────────────────────────────────────
// The visitor's finish() emits DataflowResultInternal with richer types than
// the public DataflowResult in types.ts. We cast here to access paramName,
// paramIndex, and referencedNames which the public type omits.

interface VisitorParam {
  funcName: string;
  paramName: string;
  paramIndex: number;
  line: number;
}

interface VisitorReturn {
  funcName: string;
  expression: string;
  referencedNames: string[];
  line: number;
}

interface VisitorAssignment {
  varName: string;
  callerFunc: string;
  sourceCallName: string;
  line: number;
}

interface VisitorArgFlow {
  callerFunc: string;
  calleeName: string;
  argIndex: number;
  argName: string;
  binding: { type: string; index?: number };
  confidence: number;
  expression: string;
  line: number;
}

interface VisitorMutation {
  funcName: string;
  binding: { type: string; index?: number };
}

// ── P2: interprocedural stitch data collected during per-file processing ──

/** A resolved argFlow candidate for the inter-procedural stitch post-pass. */
interface StitchCandidate {
  callerFuncId: number;
  calleeFuncId: number;
  argIndex: number;
  bindingType: string;
  bindingIndex?: number;
  argName: string;
  expression: string;
  line: number;
  confidence: number;
}

/** An assignment that captures a function's return value into a local. */
interface ReturnCapture {
  callerFuncId: number;
  calleeFuncId: number;
  varName: string;
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

// ── P1: dataflow_vertices + intra def_use edges ───────────────────────────────

function prepareVertexStmts(db: BetterSqlite3Database): {
  insertVertex: ReturnType<BetterSqlite3Database['prepare']>;
  insertIntraEdge: ReturnType<BetterSqlite3Database['prepare']>;
  available: boolean;
} {
  try {
    return {
      insertVertex: db.prepare(
        `INSERT INTO dataflow_vertices (func_id, kind, name, param_index, line, node_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      insertIntraEdge: db.prepare(
        `INSERT INTO dataflow
           (source_id, target_id, kind, source_vertex, target_vertex, scope, expression, line, confidence)
         VALUES (?, ?, 'def_use', ?, ?, 'intra', ?, ?, 1.0)`,
      ),
      available: true,
    };
  } catch {
    return {
      insertVertex: db.prepare('SELECT 1'),
      insertIntraEdge: db.prepare('SELECT 1'),
      available: false,
    };
  }
}

/**
 * Build dataflow_vertices, intra def_use edges, and summaries for one file.
 * Called alongside insertDataflowEdges in the same transaction.
 *
 * Returns stitch candidates and return captures for the P2 inter-procedural
 * post-pass (run after all files are processed).
 */
function buildDataflowVerticesAndEdges(
  db: BetterSqlite3Database,
  vstmts: ReturnType<typeof prepareVertexStmts>,
  data: DataflowResult,
  resolveNode: (name: string) => { id: number } | null,
): { candidates: StitchCandidate[]; captures: ReturnCapture[] } {
  const empty: { candidates: StitchCandidate[]; captures: ReturnCapture[] } = {
    candidates: [],
    captures: [],
  };
  if (!vstmts.available) return empty;

  const params = data.parameters as unknown as VisitorParam[];
  const returns = data.returns as unknown as VisitorReturn[];
  const assignments = data.assignments as unknown as VisitorAssignment[];
  const argFlows = data.argFlows as unknown as VisitorArgFlow[];
  const mutations = data.mutations as unknown as VisitorMutation[];

  // 1. param vertices
  const paramVertexIds = new Map<string, number>(); // "funcName:paramName" → vertex id
  const paramIndexByFuncAndIndex = new Map<string, number>(); // "funcId:paramIndex" → vertex id
  for (const p of params) {
    const fn = resolveNode(p.funcName);
    if (!fn) continue;
    const result = vstmts.insertVertex.run(fn.id, 'param', p.paramName, p.paramIndex, p.line, null);
    const vid = (result as { lastInsertRowid: number }).lastInsertRowid;
    paramVertexIds.set(`${p.funcName}:${p.paramName}`, vid);
    paramIndexByFuncAndIndex.set(`${fn.id}:${p.paramIndex}`, vid);
  }

  // 2. return vertices (one per function that has a return statement)
  const returnVertexIds = new Map<string, number>(); // funcName → vertex id
  const returnFuncsSeen = new Set<string>();
  for (const r of returns) {
    if (returnFuncsSeen.has(r.funcName)) continue;
    returnFuncsSeen.add(r.funcName);
    const fn = resolveNode(r.funcName);
    if (!fn) continue;
    const result = vstmts.insertVertex.run(fn.id, 'return', null, null, r.line, null);
    returnVertexIds.set(r.funcName, (result as { lastInsertRowid: number }).lastInsertRowid);
  }

  // 3. local vertices (from call-return assignments)
  const localVertexIds = new Map<string, number>(); // "funcName:varName" → vertex id
  const localsSeen = new Set<string>();
  for (const a of assignments) {
    const key = `${a.callerFunc}:${a.varName}`;
    if (localsSeen.has(key)) continue;
    localsSeen.add(key);
    const fn = resolveNode(a.callerFunc);
    if (!fn) continue;
    const result = vstmts.insertVertex.run(fn.id, 'local', a.varName, null, a.line, null);
    localVertexIds.set(key, (result as { lastInsertRowid: number }).lastInsertRowid);
  }

  // 4. intra def_use edges: param/local → return
  for (const r of returns) {
    const fn = resolveNode(r.funcName);
    if (!fn) continue;
    const returnVid = returnVertexIds.get(r.funcName);
    if (!returnVid) continue;
    for (const name of r.referencedNames) {
      const paramVid = paramVertexIds.get(`${r.funcName}:${name}`);
      if (paramVid) {
        vstmts.insertIntraEdge.run(fn.id, fn.id, paramVid, returnVid, r.expression, r.line);
      }
      const localVid = localVertexIds.get(`${r.funcName}:${name}`);
      if (localVid) {
        vstmts.insertIntraEdge.run(fn.id, fn.id, localVid, returnVid, r.expression, r.line);
      }
    }
  }

  // 5. summaries: flows_to_return = direct def_use from param to function's return
  const checkDefUse = db.prepare(
    `SELECT 1 FROM dataflow WHERE source_vertex = ? AND target_vertex = ? AND kind = 'def_use' LIMIT 1`,
  );
  const insertSummary = db.prepare(
    `INSERT OR REPLACE INTO dataflow_summary (func_id, param_index, flows_to_return, is_mutated) VALUES (?, ?, ?, ?)`,
  );

  for (const p of params) {
    const fn = resolveNode(p.funcName);
    if (!fn) continue;
    const paramVid = paramVertexIds.get(`${p.funcName}:${p.paramName}`);
    if (!paramVid) continue;
    const returnVid = returnVertexIds.get(p.funcName);
    const flowsToReturn = returnVid ? (checkDefUse.get(paramVid, returnVid) ? 1 : 0) : 0;
    const isMutated = mutations.some(
      (m) =>
        m.funcName === p.funcName &&
        m.binding?.type === 'param' &&
        m.binding?.index === p.paramIndex,
    )
      ? 1
      : 0;
    insertSummary.run(fn.id, p.paramIndex, flowsToReturn, isMutated);
  }

  // 6. collect stitch candidates for P2 inter-procedural post-pass
  const candidates: StitchCandidate[] = [];
  for (const af of argFlows) {
    const callerFn = resolveNode(af.callerFunc);
    const calleeFn = resolveNode(af.calleeName);
    if (!callerFn || !calleeFn) continue;
    candidates.push({
      callerFuncId: callerFn.id,
      calleeFuncId: calleeFn.id,
      argIndex: af.argIndex,
      bindingType: af.binding.type,
      bindingIndex: af.binding.index,
      argName: af.argName,
      expression: af.expression,
      line: af.line,
      confidence: af.confidence,
    });
  }

  // 7. collect return captures (locals that hold a callee's return value)
  const captures: ReturnCapture[] = [];
  for (const a of assignments) {
    const callerFn = resolveNode(a.callerFunc);
    const calleeFn = resolveNode(a.sourceCallName);
    if (!callerFn || !calleeFn) continue;
    captures.push({ callerFuncId: callerFn.id, calleeFuncId: calleeFn.id, varName: a.varName });
  }

  return { candidates, captures };
}

// ── P2: interprocedural stitching ─────────────────────────────────────────────

/**
 * Post-pass: connect arg-flow candidates to vertex-level inter-procedural edges.
 * Runs after all per-file vertices + summaries have been committed.
 *
 * For each resolved argFlow (A calls B with arg x → B.param[j]):
 *  - Emits 'arg_in' inter edge: A's source vertex → B.param[j] vertex
 *  - If B's summary shows B.param[j] reaches B's return: emits 'return_out'
 *    inter edge: B.return → A's capture local (if any)
 */
function buildInterproceduralStitch(
  db: BetterSqlite3Database,
  candidates: StitchCandidate[],
  captures: ReturnCapture[],
): number {
  if (candidates.length === 0) return 0;

  const getParamVertex = db.prepare(
    `SELECT id FROM dataflow_vertices WHERE func_id = ? AND kind = 'param' AND param_index = ? LIMIT 1`,
  );
  const getLocalVertex = db.prepare(
    `SELECT id FROM dataflow_vertices WHERE func_id = ? AND kind = 'local' AND name = ? LIMIT 1`,
  );
  const getReturnVertex = db.prepare(
    `SELECT id FROM dataflow_vertices WHERE func_id = ? AND kind = 'return' LIMIT 1`,
  );
  const getCallEdge = db.prepare(
    `SELECT id FROM edges WHERE source_id = ? AND target_id = ? AND kind = 'calls' LIMIT 1`,
  );
  const getSummary = db.prepare(
    `SELECT flows_to_return FROM dataflow_summary WHERE func_id = ? AND param_index = ?`,
  );
  const insertInterEdge = db.prepare(
    `INSERT INTO dataflow
       (source_id, target_id, kind, source_vertex, target_vertex, scope, call_edge_id, expression, line, confidence)
     VALUES (?, ?, ?, ?, ?, 'inter', ?, ?, ?, ?)`,
  );

  // Build capture map: "callerFuncId:calleeFuncId" → varName (first match wins)
  const captureMap = new Map<string, string>();
  for (const cap of captures) {
    const key = `${cap.callerFuncId}:${cap.calleeFuncId}`;
    if (!captureMap.has(key)) captureMap.set(key, cap.varName);
  }

  let count = 0;
  const tx = db.transaction(() => {
    for (const cand of candidates) {
      // Resolve call edge for this site
      const callEdge = getCallEdge.get(cand.callerFuncId, cand.calleeFuncId) as {
        id: number;
      } | null;
      const callEdgeId = callEdge?.id ?? null;

      // Find source vertex x in caller
      let srcVertexId: number | null = null;
      if (cand.bindingType === 'param' && cand.bindingIndex != null) {
        const v = getParamVertex.get(cand.callerFuncId, cand.bindingIndex) as { id: number } | null;
        srcVertexId = v?.id ?? null;
      } else if (cand.bindingType === 'local') {
        const v = getLocalVertex.get(cand.callerFuncId, cand.argName) as { id: number } | null;
        srcVertexId = v?.id ?? null;
      }

      if (!srcVertexId) continue;

      // Find callee's param[argIndex] vertex
      const calleeParam = getParamVertex.get(cand.calleeFuncId, cand.argIndex) as {
        id: number;
      } | null;
      if (!calleeParam) continue;

      // arg_in: A's source → B.param[j]
      insertInterEdge.run(
        cand.callerFuncId,
        cand.calleeFuncId,
        'arg_in',
        srcVertexId,
        calleeParam.id,
        callEdgeId,
        cand.expression,
        cand.line,
        cand.confidence,
      );
      count++;

      // return_out: if B.param[j] reaches B's return, emit B.return → A's capture
      const summary = getSummary.get(cand.calleeFuncId, cand.argIndex) as {
        flows_to_return: number;
      } | null;
      if (summary?.flows_to_return) {
        const calleeReturn = getReturnVertex.get(cand.calleeFuncId) as { id: number } | null;
        if (calleeReturn) {
          const captureVarName = captureMap.get(`${cand.callerFuncId}:${cand.calleeFuncId}`);
          const captureVertex = captureVarName
            ? (getLocalVertex.get(cand.callerFuncId, captureVarName) as { id: number } | null)
            : null;
          if (captureVertex) {
            insertInterEdge.run(
              cand.calleeFuncId,
              cand.callerFuncId,
              'return_out',
              calleeReturn.id,
              captureVertex.id,
              callEdgeId,
              cand.expression,
              cand.line,
              cand.confidence,
            );
            count++;
          }
        }
      }
    }
  });

  tx();
  return count;
}

// ── buildDataflowEdges ──────────────────────────────────────────────────────

// ── P4 helpers ───────────────────────────────────────────────────────────────

/** Return IDs of all function/method nodes in the given relative file paths. */
export function collectFuncIdsForFiles(
  db: BetterSqlite3Database,
  relPaths: Iterable<string>,
): number[] {
  const stmt = db.prepare(`SELECT id FROM nodes WHERE file = ? AND kind IN ('function', 'method')`);
  const ids: number[] = [];
  for (const p of relPaths) {
    for (const row of stmt.all(p) as { id: number }[]) ids.push(row.id);
  }
  return ids;
}

/**
 * P4: Re-collect stitch candidates from caller files that were NOT in the
 * changed set but contain calls to functions that WERE changed.
 *
 * During an incremental build the changed files' param vertices are purged
 * and recreated, but the callers' files are never re-parsed — so their
 * arg_in edges (pointing to the old param vertices) are deleted and never
 * replaced. This function reads those caller files from disk and rebuilds
 * the StitchCandidate list so buildInterproceduralStitch can reconnect them.
 */
export async function collectCallerStitchCandidates(
  db: BetterSqlite3Database,
  changedFuncIds: number[],
  changedRelPaths: Set<string>,
  rootDir: string,
  extToLang: Map<string, string>,
  parsers: unknown,
  getParserFn: ((parsers: any, absPath: string) => any) | null,
): Promise<{ candidates: StitchCandidate[]; captures: ReturnCapture[] }> {
  if (changedFuncIds.length === 0) return { candidates: [], captures: [] };

  // Find distinct caller files that have flows_to edges targeting any changed
  // function and are NOT already in the changed file set (those are handled by
  // the main per-file loop).
  //
  // Chunk the query to avoid exceeding SQLite's SQLITE_MAX_VARIABLE_NUMBER
  // (999 on older builds, 32766 on SQLite ≥ 3.32).  500 is a safe batch size
  // that works across all SQLite versions.
  const CHUNK_SIZE = 500;
  const callerFileSet = new Set<string>();
  for (let i = 0; i < changedFuncIds.length; i += CHUNK_SIZE) {
    const chunk = changedFuncIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT DISTINCT n.file AS caller_file
         FROM dataflow d
         JOIN nodes n ON n.id = d.source_id
         WHERE d.target_id IN (${placeholders})
           AND d.kind = 'flows_to'`,
      )
      .all(...chunk) as { caller_file: string }[];
    for (const r of rows) callerFileSet.add(r.caller_file);
  }
  const callerFileRows = [...callerFileSet].map((f) => ({ caller_file: f }));

  const callerFiles = callerFileRows
    .map((r) => r.caller_file)
    .filter((f) => !changedRelPaths.has(f));

  if (callerFiles.length === 0) return { candidates: [], captures: [] };

  // Ensure parsers are available — the main loop may have skipped loading them
  // if all changed files came through the native bulk-insert path.
  let activeParsers = parsers;
  let activeGetParserFn = getParserFn;
  if (!activeGetParserFn) {
    const { createParsers, getParser } = await import('../domain/parser.js');
    activeParsers = await createParsers();
    activeGetParserFn = getParser;
  }

  const changedFuncIdSet = new Set(changedFuncIds);
  const stmts = prepareNodeResolvers(db);
  const candidates: StitchCandidate[] = [];
  const captures: ReturnCapture[] = [];

  for (const callerFile of callerFiles) {
    // Read the caller file from disk without touching its existing DB rows.
    // definitions: [] is an intentional stub — P4 only needs argFlow/assignment
    // data from the visitor, not pre-loaded symbol definitions.  extractDataflow
    // does not currently use _definitions, so this is safe.  If that changes,
    // the stub must be replaced with the actual symbol list for the caller file.
    const stub: FileSymbolsDataflow = { definitions: [], _langId: null, _tree: null };
    const data = getDataflowForFile(
      stub,
      callerFile,
      rootDir,
      extToLang,
      activeParsers,
      activeGetParserFn,
    );
    if (!data) continue;

    const resolver = makeNodeResolver(stmts, callerFile);
    const argFlows = data.argFlows as unknown as VisitorArgFlow[];
    const assignments = data.assignments as unknown as VisitorAssignment[];

    for (const af of argFlows) {
      const callerFn = resolver(af.callerFunc);
      const calleeFn = resolver(af.calleeName);
      if (!callerFn || !calleeFn) continue;
      if (!changedFuncIdSet.has(calleeFn.id)) continue; // only re-stitch calls to changed callees
      candidates.push({
        callerFuncId: callerFn.id,
        calleeFuncId: calleeFn.id,
        argIndex: af.argIndex,
        bindingType: af.binding.type,
        bindingIndex: af.binding.index,
        argName: af.argName,
        expression: af.expression,
        line: af.line,
        confidence: af.confidence,
      });
    }

    for (const a of assignments) {
      const callerFn = resolver(a.callerFunc);
      const calleeFn = resolver(a.sourceCallName);
      if (!callerFn || !calleeFn) continue;
      if (!changedFuncIdSet.has(calleeFn.id)) continue;
      captures.push({ callerFuncId: callerFn.id, calleeFuncId: calleeFn.id, varName: a.varName });
    }
  }

  debug(
    `Dataflow P4: re-stitched ${candidates.length} candidate(s) from ${callerFiles.length} caller file(s)`,
  );
  return { candidates, captures };
}

function prepareNodeResolvers(db: BetterSqlite3Database): {
  getNodeByNameAndFile: ReturnType<BetterSqlite3Database['prepare']>;
  getNodeByName: ReturnType<BetterSqlite3Database['prepare']>;
} {
  return {
    getNodeByNameAndFile: db.prepare(
      `SELECT id, name, kind, file, line FROM nodes
       WHERE name = ? AND file = ? AND kind IN ('function', 'method')`,
    ),
    getNodeByName: db.prepare(
      `SELECT id, name, kind, file, line FROM nodes
       WHERE name = ? AND kind IN ('function', 'method')
       ORDER BY file, line LIMIT 10`,
    ),
  };
}

function makeNodeResolver(
  stmts: ReturnType<typeof prepareNodeResolvers>,
  relPath: string,
): (funcName: string) => { id: number } | null {
  return (funcName: string): { id: number } | null => {
    const local = stmts.getNodeByNameAndFile.all(funcName, relPath) as { id: number }[];
    if (local.length > 0) return local[0]!;
    const global = stmts.getNodeByName.all(funcName) as { id: number }[];
    return global.length > 0 ? global[0]! : null;
  };
}

function collectNativeEdges(
  data: DataflowResult,
  resolveNode: (name: string) => { id: number } | null,
  edges: Array<Record<string, unknown>>,
): void {
  for (const flow of data.argFlows as ArgFlow[]) {
    const sourceNode = resolveNode(flow.callerFunc);
    const targetNode = resolveNode(flow.calleeName);
    if (sourceNode && targetNode) {
      edges.push({
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
      edges.push({
        sourceId: producerNode.id,
        targetId: consumerNode.id,
        kind: 'returns',
        paramIndex: undefined,
        expression: assignment.expression,
        line: assignment.line,
        confidence: 1.0,
      });
    }
  }
  for (const mut of data.mutations as Mutation[]) {
    const mutatorNode = resolveNode(mut.funcName);
    if (mutatorNode && mut.binding?.type === 'param') {
      edges.push({
        sourceId: mutatorNode.id,
        targetId: mutatorNode.id,
        kind: 'mutates',
        paramIndex: undefined,
        expression: mut.mutatingExpr,
        line: mut.line,
        confidence: 1.0,
      });
    }
  }
}

/**
 * P6 vertex-only pass for the native orchestrator path.
 *
 * When the Rust orchestrator runs with analysisComplete=true it inserts
 * flows_to/returns/mutates edges directly into the DB but never writes to
 * dataflow_vertices or dataflow_summary. This function takes pre-extracted
 * DataflowResult objects (from native.extractDataflowAnalysis) and builds
 * the missing vertex rows and inter-procedural edges — without touching the
 * already-correct function-level edges.
 */
export function buildDataflowVerticesFromMap(
  db: BetterSqlite3Database,
  dataflowMap: Map<string, DataflowResult>,
  extraCandidates?: StitchCandidate[],
  extraCaptures?: ReturnCapture[],
): number {
  const vstmts = prepareVertexStmts(db);
  if (!vstmts.available || dataflowMap.size === 0) return 0;

  const stmts = prepareNodeResolvers(db);
  const allCandidates: StitchCandidate[] = [];
  const allCaptures: ReturnCapture[] = [];

  const tx = db.transaction(() => {
    for (const [relPath, data] of dataflowMap) {
      const resolver = makeNodeResolver(stmts, relPath);
      const { candidates, captures } = buildDataflowVerticesAndEdges(db, vstmts, data, resolver);
      allCandidates.push(...candidates);
      allCaptures.push(...captures);
    }
  });
  tx();

  // P4: merge in stitch candidates from unchanged caller files if provided.
  if (extraCandidates && extraCandidates.length > 0) allCandidates.push(...extraCandidates);
  if (extraCaptures && extraCaptures.length > 0) allCaptures.push(...extraCaptures);

  return buildInterproceduralStitch(db, allCandidates, allCaptures);
}

export async function buildDataflowEdges(
  db: BetterSqlite3Database,
  fileSymbols: Map<string, FileSymbolsDataflow>,
  rootDir: string,
  engineOpts?: {
    nativeDb?: { bulkInsertDataflow?(edges: Array<Record<string, unknown>>): number };
    suspendJsDb?: () => void;
    resumeJsDb?: () => void;
  },
): Promise<void> {
  const extToLang = buildExtToLangMap();

  // ── Native bulk-insert fast path ──────────────────────────────────────
  const nativeDb = engineOpts?.nativeDb;
  if (nativeDb?.bulkInsertDataflow) {
    let needsJsFallback = false;
    const nativeEdges: Array<Record<string, unknown>> = [];
    const stmts = prepareNodeResolvers(db);

    for (const [relPath, symbols] of fileSymbols) {
      const ext = path.extname(relPath).toLowerCase();
      if (!DATAFLOW_EXTENSIONS.has(ext)) continue;
      if (!symbols.dataflow) {
        needsJsFallback = true;
        break;
      }

      collectNativeEdges(symbols.dataflow, makeNodeResolver(stmts, relPath), nativeEdges);
    }

    if (!needsJsFallback) {
      if (nativeEdges.length > 0) {
        let inserted: number;
        try {
          engineOpts?.suspendJsDb?.();
          inserted = nativeDb.bulkInsertDataflow(nativeEdges);
        } finally {
          engineOpts?.resumeJsDb?.();
        }
        info(`Dataflow (native bulk): ${inserted} edges inserted`);
      }

      // P6: vertex extraction on the native path.
      // Rust DataflowResult already contains parameters/returns — no re-parse needed.
      const vstmts = prepareVertexStmts(db);
      if (vstmts.available) {
        const allCandidates: StitchCandidate[] = [];
        const allCaptures: ReturnCapture[] = [];

        const txVertex = db.transaction(() => {
          for (const [relPath, symbols] of fileSymbols) {
            if (!symbols.dataflow) continue;
            const ext = path.extname(relPath).toLowerCase();
            if (!DATAFLOW_EXTENSIONS.has(ext)) continue;
            const resolver = makeNodeResolver(stmts, relPath);
            const { candidates, captures } = buildDataflowVerticesAndEdges(
              db,
              vstmts,
              symbols.dataflow,
              resolver,
            );
            allCandidates.push(...candidates);
            allCaptures.push(...captures);
          }
        });
        txVertex();

        // P4: Incremental re-stitch — unchanged caller files are not in
        // fileSymbols so their arg_in edges to the old param vertices were
        // deleted by the purge and never recreated. Re-collect stitch
        // candidates from those caller files by parsing them from disk.
        //
        // Skip on full builds: fileSymbols covers every file in the DB, so
        // there are no unchanged callers to re-stitch.
        const totalFilesInDb = (
          db.prepare(`SELECT COUNT(DISTINCT file) AS n FROM nodes`).get() as { n: number }
        ).n;
        let p4CallerCount = 0;
        if (fileSymbols.size < totalFilesInDb) {
          const changedRelPaths = new Set<string>(fileSymbols.keys());
          const changedFuncIds = collectFuncIdsForFiles(db, changedRelPaths);
          const extra = await collectCallerStitchCandidates(
            db,
            changedFuncIds,
            changedRelPaths,
            rootDir,
            extToLang,
            null,
            null,
          );
          allCandidates.push(...extra.candidates);
          allCaptures.push(...extra.captures);
          p4CallerCount = extra.candidates.length;
        }

        const interCount = buildInterproceduralStitch(db, allCandidates, allCaptures);
        info(
          `Dataflow (native): ${interCount} inter-procedural edges inserted${p4CallerCount > 0 ? ` (P4: ${p4CallerCount} re-stitch candidate(s) from unchanged callers)` : ''}`,
        );
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

  const stmts = prepareNodeResolvers(db);
  const vstmts = prepareVertexStmts(db);
  let totalEdges = 0;

  const allCandidates: StitchCandidate[] = [];
  const allCaptures: ReturnCapture[] = [];

  const tx = db.transaction(() => {
    for (const [relPath, symbols] of fileSymbols) {
      const ext = path.extname(relPath).toLowerCase();
      if (!DATAFLOW_EXTENSIONS.has(ext)) continue;

      const data = getDataflowForFile(symbols, relPath, rootDir, extToLang, parsers, getParserFn);
      if (!data) continue;

      const resolver = makeNodeResolver(stmts, relPath);
      totalEdges += insertDataflowEdges(insert, data, resolver);
      const { candidates, captures } = buildDataflowVerticesAndEdges(db, vstmts, data, resolver);
      allCandidates.push(...candidates);
      allCaptures.push(...captures);
    }
  });

  tx();

  // P4: Incremental re-stitch — if only a subset of files changed, callers of
  // the changed functions were not in fileSymbols, so their arg_in edges were
  // deleted by the purge but never reconstructed. Re-collect stitch candidates
  // from those caller files now (read from disk, no DB writes).
  //
  // Skip P4 on full builds: when fileSymbols covers every file in the DB there
  // are no unchanged callers, and collectFuncIdsForFiles would issue one SELECT
  // per file for nothing.  A single COUNT query is cheaper than N per-file SELECTs.
  const totalFilesInDb = (
    db.prepare(`SELECT COUNT(DISTINCT file) AS n FROM nodes`).get() as { n: number }
  ).n;
  if (vstmts.available && fileSymbols.size < totalFilesInDb) {
    const changedRelPaths = new Set<string>(fileSymbols.keys());
    const changedFuncIds = collectFuncIdsForFiles(db, changedRelPaths);
    const extra = await collectCallerStitchCandidates(
      db,
      changedFuncIds,
      changedRelPaths,
      rootDir,
      extToLang,
      parsers,
      getParserFn,
    );
    allCandidates.push(...extra.candidates);
    allCaptures.push(...extra.captures);
  }

  // P2: inter-procedural stitch — runs after all per-file vertices + summaries committed
  const interCount = vstmts.available
    ? buildInterproceduralStitch(db, allCandidates, allCaptures)
    : 0;

  info(`Dataflow: ${totalEdges} fn-level edges, ${interCount} inter-procedural edges inserted`);
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

// ─── Shared dataflow result builder ──────────────────────────────────

/** Pre-mapped raw dataflow edge arrays shared between SQL and native paths. */
interface RawDataflowEdges {
  flowsTo: {
    target: string;
    kind: string;
    file: string;
    line: number;
    paramIndex: number;
    expression: string;
    confidence: number;
  }[];
  flowsFrom: {
    source: string;
    kind: string;
    file: string;
    line: number;
    paramIndex: number;
    expression: string;
    confidence: number;
  }[];
  returnConsumers: {
    consumer: string;
    kind: string;
    file: string;
    line: number;
    expression: string;
  }[];
  returnedBy: { producer: string; kind: string; file: string; line: number; expression: string }[];
  mutatesTargets: { target: string; expression: string; line: number }[];
  mutatedBy: { source: string; expression: string; line: number }[];
}

/**
 * Build a unified dataflow result from pre-mapped edge data.
 * Shared between the SQL and native code paths.
 */
function buildDataflowResult(
  sym: NormalizedSymbol,
  edges: RawDataflowEdges,
  noTests: boolean,
): Record<string, unknown> {
  if (noTests) {
    const filter = (arr: any[]) => arr.filter((r: any) => !isTestFile(r.file));
    return {
      ...sym,
      flowsTo: filter(edges.flowsTo),
      flowsFrom: filter(edges.flowsFrom),
      returns: edges.returnConsumers.filter((r: any) => !isTestFile(r.file)),
      returnedBy: edges.returnedBy.filter((r: any) => !isTestFile(r.file)),
      mutates: edges.mutatesTargets,
      mutatedBy: edges.mutatedBy,
    };
  }

  return {
    ...sym,
    flowsTo: edges.flowsTo,
    flowsFrom: edges.flowsFrom,
    returns: edges.returnConsumers,
    returnedBy: edges.returnedBy,
    mutates: edges.mutatesTargets,
    mutatedBy: edges.mutatedBy,
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
  const edges: RawDataflowEdges = {
    flowsTo: stmts.flowsToOut.all(node.id).map((r: any) => ({
      target: r.target_name,
      kind: r.target_kind,
      file: r.target_file,
      line: r.line,
      paramIndex: r.param_index,
      expression: r.expression,
      confidence: r.confidence,
    })),
    flowsFrom: stmts.flowsToIn.all(node.id).map((r: any) => ({
      source: r.source_name,
      kind: r.source_kind,
      file: r.source_file,
      line: r.line,
      paramIndex: r.param_index,
      expression: r.expression,
      confidence: r.confidence,
    })),
    returnConsumers: stmts.returnsOut.all(node.id).map((r: any) => ({
      consumer: r.target_name,
      kind: r.target_kind,
      file: r.target_file,
      line: r.line,
      expression: r.expression,
    })),
    returnedBy: stmts.returnsIn.all(node.id).map((r: any) => ({
      producer: r.source_name,
      kind: r.source_kind,
      file: r.source_file,
      line: r.line,
      expression: r.expression,
    })),
    mutatesTargets: stmts.mutatesOut.all(node.id).map((r: any) => ({
      target: r.target_name,
      expression: r.expression,
      line: r.line,
    })),
    mutatedBy: stmts.mutatesIn.all(node.id).map((r: any) => ({
      source: r.source_name,
      expression: r.expression,
      line: r.line,
    })),
  };
  return buildDataflowResult(sym, edges, noTests);
}

function buildNativeDataflowResult(
  node: NodeRow,
  nativeDb: NativeDatabase,
  db: BetterSqlite3Database,
  hc: Map<string, string | null>,
  noTests: boolean,
): Record<string, unknown> {
  const sym = normalizeSymbol(node, db, hc);
  const d = nativeDb.getDataflowEdges!(node.id);
  const edges: RawDataflowEdges = {
    flowsTo: d.flowsToOut.map((r: any) => ({
      target: r.name,
      kind: r.kind,
      file: r.file,
      line: r.line,
      paramIndex: r.paramIndex,
      expression: r.expression,
      confidence: r.confidence,
    })),
    flowsFrom: d.flowsToIn.map((r: any) => ({
      source: r.name,
      kind: r.kind,
      file: r.file,
      line: r.line,
      paramIndex: r.paramIndex,
      expression: r.expression,
      confidence: r.confidence,
    })),
    returnConsumers: d.returnsOut.map((r: any) => ({
      consumer: r.name,
      kind: r.kind,
      file: r.file,
      line: r.line,
      expression: r.expression,
    })),
    returnedBy: d.returnsIn.map((r: any) => ({
      producer: r.name,
      kind: r.kind,
      file: r.file,
      line: r.line,
      expression: r.expression,
    })),
    mutatesTargets: d.mutatesOut.map((r: any) => ({
      target: r.name,
      expression: r.expression,
      line: r.line,
    })),
    mutatedBy: d.mutatesIn.map((r: any) => ({
      source: r.name,
      expression: r.expression,
      line: r.line,
    })),
  };
  return buildDataflowResult(sym, edges, noTests);
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
      const results = nodes.map((node: NodeRow) =>
        buildNativeDataflowResult(node, nativeDb, db, hc, noTests),
      );
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

type DataflowNeighbor = {
  id: number;
  file: string;
  edge_kind: string;
  expression: string;
};

interface DataflowBfsState {
  visited: Set<number>;
  parent: Map<number, BfsParentEntry>;
  nextQueue: number[];
  found: boolean;
}

/**
 * Process a single neighbor in the dataflow BFS. Returns true once the target
 * has been reached so the caller can stop expanding.
 */
function processDataflowNeighbor(
  n: DataflowNeighbor,
  currentId: number,
  targetId: number,
  noTests: boolean,
  state: DataflowBfsState,
): boolean {
  if (noTests && isTestFile(n.file)) return false;
  const entry: BfsParentEntry = {
    parentId: currentId,
    edgeKind: n.edge_kind,
    expression: n.expression,
  };
  if (n.id === targetId) {
    if (!state.found) {
      state.found = true;
      state.parent.set(n.id, entry);
    }
    return true;
  }
  if (state.visited.has(n.id)) return false;
  state.visited.add(n.id);
  state.parent.set(n.id, entry);
  state.nextQueue.push(n.id);
  return false;
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

  const state: DataflowBfsState = {
    visited: new Set<number>([sourceId]),
    parent: new Map<number, BfsParentEntry>(),
    nextQueue: [],
    found: false,
  };
  let queue = [sourceId];

  for (let depth = 1; depth <= maxDepth; depth++) {
    state.nextQueue = [];
    for (const currentId of queue) {
      const neighbors = neighborStmt.all(currentId) as DataflowNeighbor[];
      for (const n of neighbors) {
        processDataflowNeighbor(n, currentId, targetId, noTests, state);
      }
    }
    if (state.found) break;
    queue = state.nextQueue;
    if (queue.length === 0) break;
  }

  return state.found ? state.parent : null;
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
