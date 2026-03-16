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
import { DATAFLOW_RULES } from './ast-analysis/rules/index.js';
import {
  makeDataflowRules as _makeDataflowRules,
  buildExtensionSet,
  buildExtToLangMap,
} from './ast-analysis/shared.js';
import { walkWithVisitors } from './ast-analysis/visitor.js';
import { createDataflowVisitor } from './ast-analysis/visitors/dataflow-visitor.js';
import { hasDataflowTable, openReadonlyOrFail } from './db.js';
import { isTestFile } from './infrastructure/test-filter.js';
import { info } from './logger.js';
import { paginateResult } from './paginate.js';
import { ALL_SYMBOL_KINDS, normalizeSymbol } from './queries.js';

// Re-export for backward compatibility
export { _makeDataflowRules as makeDataflowRules, DATAFLOW_RULES };

export const DATAFLOW_EXTENSIONS = buildExtensionSet(DATAFLOW_RULES);

// ── AST helpers (now in ast-analysis/visitor-utils.js, kept as re-exports) ──

// ── extractDataflow ──────────────────────────────────────────────────────────

/**
 * Extract dataflow information from a parsed AST.
 * Delegates to the dataflow visitor via the unified walker.
 *
 * @param {object} tree - tree-sitter parse tree
 * @param {string} filePath - relative file path
 * @param {object[]} definitions - symbol definitions from the parser
 * @param {string} [langId='javascript'] - language identifier for rules lookup
 * @returns {{ parameters, returns, assignments, argFlows, mutations }}
 */
export function extractDataflow(tree, _filePath, _definitions, langId = 'javascript') {
  const rules = DATAFLOW_RULES.get(langId);
  if (!rules) return { parameters: [], returns: [], assignments: [], argFlows: [], mutations: [] };

  const visitor = createDataflowVisitor(rules);
  const results = walkWithVisitors(tree.rootNode, [visitor], langId, {
    functionNodeTypes: rules.functionNodes,
    getFunctionName: () => null, // dataflow visitor handles its own name extraction
  });

  return results.dataflow;
}

// ── buildDataflowEdges ──────────────────────────────────────────────────────

/**
 * Build dataflow edges and insert them into the database.
 * Called during graph build when --dataflow is enabled.
 *
 * @param {object} db - better-sqlite3 database instance
 * @param {Map<string, object>} fileSymbols - map of relPath → symbols
 * @param {string} rootDir - absolute root directory
 * @param {object} engineOpts - engine options
 */
export async function buildDataflowEdges(db, fileSymbols, rootDir, _engineOpts) {
  // Lazily init WASM parsers if needed
  let parsers = null;
  let needsFallback = false;

  // Always build ext→langId map so native-only builds (where _langId is unset)
  // can still derive the language from the file extension.
  const extToLang = buildExtToLangMap();

  for (const [relPath, symbols] of fileSymbols) {
    if (!symbols._tree && !symbols.dataflow) {
      const ext = path.extname(relPath).toLowerCase();
      if (DATAFLOW_EXTENSIONS.has(ext)) {
        needsFallback = true;
        break;
      }
    }
  }

  if (needsFallback) {
    const { createParsers } = await import('./parser.js');
    parsers = await createParsers();
  }

  let getParserFn = null;
  if (parsers) {
    const mod = await import('./parser.js');
    getParserFn = mod.getParser;
  }

  const insert = db.prepare(
    `INSERT INTO dataflow (source_id, target_id, kind, param_index, expression, line, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  // MVP scope: only resolve function/method nodes for dataflow edges.
  // Future expansion: add 'parameter', 'property', 'constant' kinds to track
  // data flow through property accessors or constant references.
  const getNodeByNameAndFile = db.prepare(
    `SELECT id, name, kind, file, line FROM nodes
     WHERE name = ? AND file = ? AND kind IN ('function', 'method')`,
  );

  const getNodeByName = db.prepare(
    `SELECT id, name, kind, file, line FROM nodes
     WHERE name = ? AND kind IN ('function', 'method')
     ORDER BY file, line LIMIT 10`,
  );

  let totalEdges = 0;

  const tx = db.transaction(() => {
    for (const [relPath, symbols] of fileSymbols) {
      const ext = path.extname(relPath).toLowerCase();
      if (!DATAFLOW_EXTENSIONS.has(ext)) continue;

      // Use native dataflow data if available — skip WASM extraction
      let data = symbols.dataflow;
      if (!data) {
        let tree = symbols._tree;
        let langId = symbols._langId;

        // WASM fallback if no cached tree
        if (!tree) {
          if (!getParserFn) continue;
          langId = extToLang.get(ext);
          if (!langId || !DATAFLOW_RULES.has(langId)) continue;

          const absPath = path.join(rootDir, relPath);
          let code;
          try {
            code = fs.readFileSync(absPath, 'utf-8');
          } catch {
            continue;
          }

          const parser = getParserFn(parsers, absPath);
          if (!parser) continue;

          try {
            tree = parser.parse(code);
          } catch {
            continue;
          }
        }

        if (!langId) {
          langId = extToLang.get(ext);
          if (!langId) continue;
        }

        if (!DATAFLOW_RULES.has(langId)) continue;

        data = extractDataflow(tree, relPath, symbols.definitions, langId);
      }

      // Resolve function names to node IDs in this file first, then globally
      function resolveNode(funcName) {
        const local = getNodeByNameAndFile.all(funcName, relPath);
        if (local.length > 0) return local[0];
        const global = getNodeByName.all(funcName);
        return global.length > 0 ? global[0] : null;
      }

      // flows_to: parameter/variable passed as argument to another function
      for (const flow of data.argFlows) {
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
          totalEdges++;
        }
      }

      // returns: call return value captured in caller
      for (const assignment of data.assignments) {
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
          totalEdges++;
        }
      }

      // mutates: parameter-derived value is mutated
      for (const mut of data.mutations) {
        const mutatorNode = resolveNode(mut.funcName);
        if (mutatorNode && mut.binding?.type === 'param') {
          // The mutation in this function affects the parameter source
          insert.run(
            mutatorNode.id,
            mutatorNode.id,
            'mutates',
            null,
            mut.mutatingExpr,
            mut.line,
            1.0,
          );
          totalEdges++;
        }
      }
    }
  });

  tx();
  info(`Dataflow: ${totalEdges} edges inserted`);
}

// ── Query functions ─────────────────────────────────────────────────────────

/**
 * Look up node(s) by name with optional file/kind/noTests filtering.
 * Similar to findMatchingNodes in queries.js but operates on the dataflow table.
 */
function findNodes(db, name, opts = {}) {
  const kinds = opts.kind ? [opts.kind] : ALL_SYMBOL_KINDS;
  const placeholders = kinds.map(() => '?').join(', ');
  const params = [`%${name}%`, ...kinds];

  let fileCondition = '';
  if (opts.file) {
    fileCondition = ' AND file LIKE ?';
    params.push(`%${opts.file}%`);
  }

  const rows = db
    .prepare(
      `SELECT * FROM nodes
       WHERE name LIKE ? AND kind IN (${placeholders})${fileCondition}
       ORDER BY file, line`,
    )
    .all(...params);

  return opts.noTests ? rows.filter((n) => !isTestFile(n.file)) : rows;
}

/**
 * Return all dataflow edges for a symbol.
 *
 * @param {string} name - symbol name (partial match)
 * @param {string} [customDbPath] - path to graph.db
 * @param {object} [opts] - { noTests, file, kind, limit, offset }
 * @returns {{ name, results: object[] }}
 */
export function dataflowData(name, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
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

    const nodes = findNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    const flowsToOut = db.prepare(
      `SELECT d.*, n.name AS target_name, n.kind AS target_kind, n.file AS target_file, n.line AS target_line
     FROM dataflow d JOIN nodes n ON d.target_id = n.id
     WHERE d.source_id = ? AND d.kind = 'flows_to'`,
    );
    const flowsToIn = db.prepare(
      `SELECT d.*, n.name AS source_name, n.kind AS source_kind, n.file AS source_file, n.line AS source_line
     FROM dataflow d JOIN nodes n ON d.source_id = n.id
     WHERE d.target_id = ? AND d.kind = 'flows_to'`,
    );
    const returnsOut = db.prepare(
      `SELECT d.*, n.name AS target_name, n.kind AS target_kind, n.file AS target_file, n.line AS target_line
     FROM dataflow d JOIN nodes n ON d.target_id = n.id
     WHERE d.source_id = ? AND d.kind = 'returns'`,
    );
    const returnsIn = db.prepare(
      `SELECT d.*, n.name AS source_name, n.kind AS source_kind, n.file AS source_file, n.line AS source_line
     FROM dataflow d JOIN nodes n ON d.source_id = n.id
     WHERE d.target_id = ? AND d.kind = 'returns'`,
    );
    const mutatesOut = db.prepare(
      `SELECT d.*, n.name AS target_name, n.kind AS target_kind, n.file AS target_file, n.line AS target_line
     FROM dataflow d JOIN nodes n ON d.target_id = n.id
     WHERE d.source_id = ? AND d.kind = 'mutates'`,
    );
    const mutatesIn = db.prepare(
      `SELECT d.*, n.name AS source_name, n.kind AS source_kind, n.file AS source_file, n.line AS source_line
     FROM dataflow d JOIN nodes n ON d.source_id = n.id
     WHERE d.target_id = ? AND d.kind = 'mutates'`,
    );

    const hc = new Map();
    const results = nodes.map((node) => {
      const sym = normalizeSymbol(node, db, hc);

      const flowsTo = flowsToOut.all(node.id).map((r) => ({
        target: r.target_name,
        kind: r.target_kind,
        file: r.target_file,
        line: r.line,
        paramIndex: r.param_index,
        expression: r.expression,
        confidence: r.confidence,
      }));

      const flowsFrom = flowsToIn.all(node.id).map((r) => ({
        source: r.source_name,
        kind: r.source_kind,
        file: r.source_file,
        line: r.line,
        paramIndex: r.param_index,
        expression: r.expression,
        confidence: r.confidence,
      }));

      const returnConsumers = returnsOut.all(node.id).map((r) => ({
        consumer: r.target_name,
        kind: r.target_kind,
        file: r.target_file,
        line: r.line,
        expression: r.expression,
      }));

      const returnedBy = returnsIn.all(node.id).map((r) => ({
        producer: r.source_name,
        kind: r.source_kind,
        file: r.source_file,
        line: r.line,
        expression: r.expression,
      }));

      const mutatesTargets = mutatesOut.all(node.id).map((r) => ({
        target: r.target_name,
        expression: r.expression,
        line: r.line,
      }));

      const mutatedBy = mutatesIn.all(node.id).map((r) => ({
        source: r.source_name,
        expression: r.expression,
        line: r.line,
      }));

      if (noTests) {
        const filter = (arr) => arr.filter((r) => !isTestFile(r.file));
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
  } finally {
    db.close();
  }
}

/**
 * BFS through flows_to + returns edges to find how data gets from A to B.
 *
 * @param {string} from - source symbol name
 * @param {string} to - target symbol name
 * @param {string} [customDbPath]
 * @param {object} [opts] - { noTests, maxDepth, limit, offset }
 * @returns {{ from, to, found, hops?, path? }}
 */
export function dataflowPathData(from, to, customDbPath, opts = {}) {
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

    const fromNodes = findNodes(db, from, { noTests, file: opts.fromFile, kind: opts.kind });
    if (fromNodes.length === 0) {
      return { from, to, found: false, error: `No symbol matching "${from}"` };
    }

    const toNodes = findNodes(db, to, { noTests, file: opts.toFile, kind: opts.kind });
    if (toNodes.length === 0) {
      return { from, to, found: false, error: `No symbol matching "${to}"` };
    }

    const sourceNode = fromNodes[0];
    const targetNode = toNodes[0];

    if (sourceNode.id === targetNode.id) {
      const hc = new Map();
      const sym = normalizeSymbol(sourceNode, db, hc);
      return {
        from,
        to,
        found: true,
        hops: 0,
        path: [{ ...sym, edgeKind: null }],
      };
    }

    // BFS through flows_to and returns edges
    const neighborStmt = db.prepare(
      `SELECT n.id, n.name, n.kind, n.file, n.line, d.kind AS edge_kind, d.expression
     FROM dataflow d JOIN nodes n ON d.target_id = n.id
     WHERE d.source_id = ? AND d.kind IN ('flows_to', 'returns')`,
    );

    const visited = new Set([sourceNode.id]);
    const parent = new Map();
    let queue = [sourceNode.id];
    let found = false;

    for (let depth = 1; depth <= maxDepth; depth++) {
      const nextQueue = [];
      for (const currentId of queue) {
        const neighbors = neighborStmt.all(currentId);
        for (const n of neighbors) {
          if (noTests && isTestFile(n.file)) continue;
          if (n.id === targetNode.id) {
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

    if (!found) {
      return { from, to, found: false };
    }

    // Reconstruct path
    const nodeById = db.prepare('SELECT * FROM nodes WHERE id = ?');
    const hc = new Map();
    const pathItems = [];
    let cur = targetNode.id;
    while (cur !== undefined) {
      const nodeRow = nodeById.get(cur);
      const parentInfo = parent.get(cur);
      pathItems.unshift({
        ...normalizeSymbol(nodeRow, db, hc),
        edgeKind: parentInfo?.edgeKind ?? null,
        expression: parentInfo?.expression ?? null,
      });
      cur = parentInfo?.parentId;
      if (cur === sourceNode.id) {
        const srcRow = nodeById.get(cur);
        pathItems.unshift({
          ...normalizeSymbol(srcRow, db, hc),
          edgeKind: null,
          expression: null,
        });
        break;
      }
    }

    return { from, to, found: true, hops: pathItems.length - 1, path: pathItems };
  } finally {
    db.close();
  }
}

/**
 * Forward BFS through returns edges: "if I change this function's return value, what breaks?"
 *
 * @param {string} name - symbol name
 * @param {string} [customDbPath]
 * @param {object} [opts] - { noTests, depth, file, kind, limit, offset }
 * @returns {{ name, results: object[] }}
 */
export function dataflowImpactData(name, customDbPath, opts = {}) {
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

    const nodes = findNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    // Forward BFS: who consumes this function's return value (directly or transitively)?
    const consumersStmt = db.prepare(
      `SELECT DISTINCT n.*
     FROM dataflow d JOIN nodes n ON d.target_id = n.id
     WHERE d.source_id = ? AND d.kind = 'returns'`,
    );

    const hc = new Map();
    const results = nodes.map((node) => {
      const sym = normalizeSymbol(node, db, hc);
      const visited = new Set([node.id]);
      const levels = {};
      let frontier = [node.id];

      for (let d = 1; d <= maxDepth; d++) {
        const nextFrontier = [];
        for (const fid of frontier) {
          const consumers = consumersStmt.all(fid);
          for (const c of consumers) {
            if (!visited.has(c.id) && (!noTests || !isTestFile(c.file))) {
              visited.add(c.id);
              nextFrontier.push(c.id);
              if (!levels[d]) levels[d] = [];
              levels[d].push(normalizeSymbol(c, db, hc));
            }
          }
        }
        frontier = nextFrontier;
        if (frontier.length === 0) break;
      }

      return {
        ...sym,
        levels,
        totalAffected: visited.size - 1,
      };
    });

    const base = { name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}
