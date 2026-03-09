/**
 * Stored queryable AST nodes — build-time extraction + query functions.
 *
 * Persists selected AST nodes (calls, new, string, regex, throw, await) in the
 * `ast_nodes` table during build. Queryable via CLI (`codegraph ast`), MCP
 * (`ast_query`), and programmatic API.
 */

import path from 'node:path';
import { openReadonlyOrFail } from './db.js';
import { debug } from './logger.js';
import { paginateResult } from './paginate.js';
import { LANGUAGE_REGISTRY } from './parser.js';
import { outputResult } from './result-formatter.js';

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

/** Max length for the `text` column. */
const TEXT_MAX = 200;

/** tree-sitter node types that map to our AST node kinds (JS/TS/TSX). */
const JS_TS_AST_TYPES = {
  new_expression: 'new',
  throw_statement: 'throw',
  await_expression: 'await',
  string: 'string',
  template_string: 'string',
  regex: 'regex',
};

/** Extensions that support full AST walk (new/throw/await/string/regex). */
const WALK_EXTENSIONS = new Set();
for (const lang of Object.values(LANGUAGE_REGISTRY)) {
  if (['javascript', 'typescript', 'tsx'].includes(lang.id)) {
    for (const ext of lang.extensions) WALK_EXTENSIONS.add(ext);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function truncate(s, max = TEXT_MAX) {
  if (!s) return null;
  return s.length <= max ? s : `${s.slice(0, max - 1)}\u2026`;
}

/**
 * Extract the constructor name from a `new_expression` node.
 * Handles `new Foo()`, `new a.Foo()`, `new Foo.Bar()`.
 */
function extractNewName(node) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'identifier') return child.text;
    if (child.type === 'member_expression') {
      // e.g. new a.Foo() → "a.Foo"
      return child.text;
    }
  }
  return node.text?.split('(')[0]?.replace('new ', '').trim() || '?';
}

/**
 * Extract the expression text from a throw/await node.
 */
function extractExpressionText(node) {
  // Skip keyword child, take the rest
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type !== 'throw' && child.type !== 'await') {
      return truncate(child.text);
    }
  }
  return truncate(node.text);
}

/**
 * Extract a meaningful name from throw/await nodes.
 * For throw: the constructor or expression type.
 * For await: the called function name.
 */
function extractName(kind, node) {
  if (kind === 'throw') {
    // throw new Error(...) → "Error"; throw x → "x"
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'new_expression') return extractNewName(child);
      if (child.type === 'call_expression') {
        const fn = child.childForFieldName('function');
        return fn ? fn.text : child.text?.split('(')[0] || '?';
      }
      if (child.type === 'identifier') return child.text;
    }
    return truncate(node.text);
  }
  if (kind === 'await') {
    // await fetch(...) → "fetch"; await this.foo() → "this.foo"
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'call_expression') {
        const fn = child.childForFieldName('function');
        return fn ? fn.text : child.text?.split('(')[0] || '?';
      }
      if (child.type === 'identifier' || child.type === 'member_expression') {
        return child.text;
      }
    }
    return truncate(node.text);
  }
  return truncate(node.text);
}

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

  // Bulk-fetch all node IDs per file (replaces per-def getNodeId calls)
  const bulkGetNodeIds = db.prepare('SELECT id, name, kind, line FROM nodes WHERE file = ?');

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
    for (const row of bulkGetNodeIds.all(relPath)) {
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
 */
function walkAst(node, defs, relPath, rows, nodeIdMap) {
  const kind = JS_TS_AST_TYPES[node.type];
  if (kind) {
    // tree-sitter lines are 0-indexed, our DB uses 1-indexed
    const line = node.startPosition.row + 1;

    let name;
    let text = null;

    if (kind === 'new') {
      name = extractNewName(node);
      text = truncate(node.text);
    } else if (kind === 'throw') {
      name = extractName('throw', node);
      text = extractExpressionText(node);
    } else if (kind === 'await') {
      name = extractName('await', node);
      text = extractExpressionText(node);
    } else if (kind === 'string') {
      // Skip trivial strings (length < 2 after removing quotes)
      const content = node.text?.replace(/^['"`]|['"`]$/g, '') || '';
      if (content.length < 2) {
        // Still recurse children
        for (let i = 0; i < node.childCount; i++) {
          walkAst(node.child(i), defs, relPath, rows, nodeIdMap);
        }
        return;
      }
      name = truncate(content, 100);
      text = truncate(node.text);
    } else if (kind === 'regex') {
      name = node.text || '?';
      text = truncate(node.text);
    }

    const parentDef = findParentDef(defs, line);
    let parentNodeId = null;
    if (parentDef) {
      parentNodeId = nodeIdMap.get(`${parentDef.name}|${parentDef.kind}|${parentDef.line}`) || null;
    }

    rows.push({
      file: relPath,
      line,
      kind,
      name,
      text,
      receiver: null,
      parentNodeId,
    });

    // Don't recurse into the children of matched nodes for new/throw/await
    // (we already extracted what we need, and nested strings inside them are noise)
    if (kind !== 'string' && kind !== 'regex') return;
  }

  for (let i = 0; i < node.childCount; i++) {
    walkAst(node.child(i), defs, relPath, rows, nodeIdMap);
  }
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

  if (file) {
    where += ' AND a.file LIKE ?';
    params.push(`%${file}%`);
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
