/**
 * Stored queryable AST nodes — build-time extraction + query functions.
 *
 * Persists selected AST nodes (calls, new, string, regex, throw, await) in the
 * `ast_nodes` table during build. Queryable via CLI (`codegraph ast`), MCP
 * (`ast_query`), and programmatic API.
 */

import path from 'node:path';
import { AST_TYPE_MAPS } from '../ast-analysis/rules/index.js';
import { buildExtensionSet } from '../ast-analysis/shared.js';
import { walkWithVisitors } from '../ast-analysis/visitor.js';
import { createAstStoreVisitor } from '../ast-analysis/visitors/ast-store-visitor.js';
import { bulkNodeIdsByFile, openReadonlyOrFail } from '../db/index.js';
import { buildFileConditionSQL } from '../db/query-builder.js';
import { debug } from '../infrastructure/logger.js';
import { outputResult } from '../infrastructure/result-formatter.js';
import { paginateResult } from '../shared/paginate.js';

// ─── Constants ────────────────────────────────────────────────────────

export const AST_NODE_KINDS = ['call', 'new', 'string', 'regex', 'throw', 'await'];

const KIND_ICONS = {
  call: '\u0192', // ƒ
  new: '\u2295', // ⊕
  string: '"',
  regex: '/',
  throw: '\u2191', // ↑
  await: '\u22B3', // ⊳
};

/** tree-sitter node types that map to our AST node kinds — imported from rules. */
const JS_TS_AST_TYPES = AST_TYPE_MAPS.get('javascript');

/** Extensions that support full AST walk (new/throw/await/string/regex). */
const WALK_EXTENSIONS = buildExtensionSet(AST_TYPE_MAPS);

// ─── Helpers ──────────────────────────────────────────────────────────
// Node extraction helpers (extractNewName, extractName, etc.) moved to
// ast-analysis/visitors/ast-store-visitor.js as part of the visitor framework.

/**
 * Find the narrowest enclosing definition for a given line.
 */
function findParentDef(defs, line) {
  let best = null;
  for (const def of defs) {
    if (def.line <= line && (def.endLine == null || def.endLine >= line)) {
      if (!best || def.endLine - def.line < best.endLine - best.line) {
        best = def;
      }
    }
  }
  return best;
}

// ─── Build ────────────────────────────────────────────────────────────

/**
 * Extract AST nodes from parsed files and persist to the ast_nodes table.
 *
 * @param {object} db - open better-sqlite3 database (read-write)
 * @param {Map<string, object>} fileSymbols - Map<relPath, { definitions, calls, _tree, _langId }>
 * @param {string} rootDir - absolute project root path
 * @param {object} [_engineOpts] - engine options (unused)
 */
export async function buildAstNodes(db, fileSymbols, _rootDir, _engineOpts) {
  // Ensure table exists (migration may not have run on older DBs)
  let insertStmt;
  try {
    insertStmt = db.prepare(
      'INSERT INTO ast_nodes (file, line, kind, name, text, receiver, parent_node_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
  } catch {
    debug('ast_nodes table not found — skipping AST extraction');
    return;
  }

  const tx = db.transaction((rows) => {
    for (const r of rows) {
      insertStmt.run(r.file, r.line, r.kind, r.name, r.text, r.receiver, r.parentNodeId);
    }
  });

  const allRows = [];

  for (const [relPath, symbols] of fileSymbols) {
    const defs = symbols.definitions || [];

    // Pre-load all node IDs for this file into a map (read-only, fast)
    const nodeIdMap = new Map();
    for (const row of bulkNodeIdsByFile(db, relPath)) {
      nodeIdMap.set(`${row.name}|${row.kind}|${row.line}`, row.id);
    }

    // 1. Call nodes from symbols.calls (all languages)
    if (symbols.calls) {
      for (const call of symbols.calls) {
        const parentDef = findParentDef(defs, call.line);
        let parentNodeId = null;
        if (parentDef) {
          parentNodeId =
            nodeIdMap.get(`${parentDef.name}|${parentDef.kind}|${parentDef.line}`) || null;
        }
        allRows.push({
          file: relPath,
          line: call.line,
          kind: 'call',
          name: call.name,
          text: call.dynamic ? `[dynamic] ${call.name}` : null,
          receiver: call.receiver || null,
          parentNodeId,
        });
      }
    }

    // 2. Non-call AST nodes (new, throw, await, string, regex)
    if (symbols.astNodes?.length) {
      // Native path: use pre-extracted AST nodes from Rust (all languages)
      for (const n of symbols.astNodes) {
        const parentDef = findParentDef(defs, n.line);
        let parentNodeId = null;
        if (parentDef) {
          parentNodeId =
            nodeIdMap.get(`${parentDef.name}|${parentDef.kind}|${parentDef.line}`) || null;
        }
        allRows.push({
          file: relPath,
          line: n.line,
          kind: n.kind,
          name: n.name,
          text: n.text || null,
          receiver: n.receiver || null,
          parentNodeId,
        });
      }
    } else {
      // WASM fallback: walk the tree-sitter AST (JS/TS/TSX only)
      const ext = path.extname(relPath).toLowerCase();
      if (WALK_EXTENSIONS.has(ext) && symbols._tree) {
        const astRows = [];
        walkAst(symbols._tree.rootNode, defs, relPath, astRows, nodeIdMap);
        allRows.push(...astRows);
      }
    }
  }

  if (allRows.length > 0) {
    tx(allRows);
  }

  debug(`AST extraction: ${allRows.length} nodes stored`);
}

/**
 * Walk a tree-sitter AST and collect new/throw/await/string/regex nodes.
 * Delegates to the ast-store visitor via the unified walker.
 */
function walkAst(rootNode, defs, relPath, rows, nodeIdMap) {
  const visitor = createAstStoreVisitor(JS_TS_AST_TYPES, defs, relPath, nodeIdMap);
  const results = walkWithVisitors(rootNode, [visitor], 'javascript');
  const collected = results['ast-store'] || [];
  rows.push(...collected);
}

// ─── Query ────────────────────────────────────────────────────────────

/**
 * Query AST nodes — data-returning function.
 *
 * @param {string} [pattern] - GLOB pattern for node name (auto-wrapped in *..*)
 * @param {string} [customDbPath] - path to graph.db
 * @param {object} [opts]
 * @returns {{ pattern, kind, count, results, _pagination? }}
 */
export function astQueryData(pattern, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const { kind, file, noTests, limit, offset } = opts;

  let where = 'WHERE 1=1';
  const params = [];

  // Pattern matching
  if (pattern && pattern !== '*') {
    // If user already uses wildcards, use as-is; otherwise wrap in *..* for substring
    const globPattern = pattern.includes('*') ? pattern : `*${pattern}*`;
    where += ' AND a.name GLOB ?';
    params.push(globPattern);
  }

  if (kind) {
    where += ' AND a.kind = ?';
    params.push(kind);
  }

  {
    const fc = buildFileConditionSQL(file, 'a.file');
    where += fc.sql;
    params.push(...fc.params);
  }

  if (noTests) {
    where += ` AND a.file NOT LIKE '%.test.%'
       AND a.file NOT LIKE '%.spec.%'
       AND a.file NOT LIKE '%__test__%'
       AND a.file NOT LIKE '%__tests__%'
       AND a.file NOT LIKE '%.stories.%'`;
  }

  const sql = `
    SELECT a.kind, a.name, a.file, a.line, a.text, a.receiver, a.parent_node_id,
           p.name AS parent_name, p.kind AS parent_kind, p.file AS parent_file
    FROM ast_nodes a
    LEFT JOIN nodes p ON a.parent_node_id = p.id
    ${where}
    ORDER BY a.file, a.line
  `;

  let rows;
  try {
    rows = db.prepare(sql).all(...params);
  } finally {
    db.close();
  }

  const results = rows.map((r) => ({
    kind: r.kind,
    name: r.name,
    file: r.file,
    line: r.line,
    text: r.text,
    receiver: r.receiver,
    parent: r.parent_node_id
      ? { name: r.parent_name, kind: r.parent_kind, file: r.parent_file }
      : null,
  }));

  const data = {
    pattern: pattern || '*',
    kind: kind || null,
    count: results.length,
    results,
  };

  return paginateResult(data, 'results', { limit, offset });
}

/**
 * Query AST nodes — display function (human/json/ndjson output).
 */
export function astQuery(pattern, customDbPath, opts = {}) {
  const data = astQueryData(pattern, customDbPath, opts);

  if (outputResult(data, 'results', opts)) return;

  // Human-readable output
  if (data.results.length === 0) {
    console.log(`No AST nodes found${pattern ? ` matching "${pattern}"` : ''}.`);
    return;
  }

  const kindLabel = opts.kind ? ` (kind: ${opts.kind})` : '';
  console.log(`\n${data.count} AST nodes${pattern ? ` matching "${pattern}"` : ''}${kindLabel}:\n`);

  for (const r of data.results) {
    const icon = KIND_ICONS[r.kind] || '?';
    const parentInfo = r.parent ? `  (in ${r.parent.name})` : '';
    console.log(`  ${icon} ${r.name}  -- ${r.file}:${r.line}${parentInfo}`);
  }

  if (data._pagination?.hasMore) {
    console.log(
      `\n  ... ${data._pagination.total - data._pagination.offset - data._pagination.returned} more (use --offset ${data._pagination.offset + data._pagination.limit})`,
    );
  }
  console.log();
}
