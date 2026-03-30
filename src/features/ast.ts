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
import type { ASTNodeKind, BetterSqlite3Database, Definition, TreeSitterNode } from '../types.js';

// ─── Constants ────────────────────────────────────────────────────────

export const AST_NODE_KINDS: ASTNodeKind[] = ['call', 'new', 'string', 'regex', 'throw', 'await'];

const KIND_ICONS: Record<string, string> = {
  call: '\u0192', // ƒ
  new: '\u2295', // ⊕
  string: '"',
  regex: '/',
  throw: '\u2191', // ↑
  await: '\u22B3', // ⊳
};

const JS_TS_AST_TYPES = AST_TYPE_MAPS.get('javascript');

const WALK_EXTENSIONS = buildExtensionSet(AST_TYPE_MAPS);

// ─── Helpers ──────────────────────────────────────────────────────────

interface AstRow {
  file: string;
  line: number;
  kind: string;
  name: string;
  text: string | null;
  receiver: string | null;
  parentNodeId: number | null;
}

interface FileSymbols {
  definitions: Definition[];
  calls?: Array<{ line: number; name: string; dynamic?: boolean; receiver?: string }>;
  astNodes?: Array<{ line: number; kind: string; name: string; text?: string; receiver?: string }>;
  _tree?: { rootNode: TreeSitterNode };
  _langId?: string;
}

function findParentDef(defs: Definition[], line: number): Definition | null {
  let best: Definition | null = null;
  for (const def of defs) {
    if (def.line <= line && (def.endLine == null || def.endLine >= line)) {
      if (!best || (def.endLine ?? 0) - def.line < (best.endLine ?? 0) - best.line) {
        best = def;
      }
    }
  }
  return best;
}

// ─── Build ────────────────────────────────────────────────────────────

export async function buildAstNodes(
  db: BetterSqlite3Database,
  fileSymbols: Map<string, FileSymbols>,
  _rootDir: string,
  engineOpts?: {
    nativeDb?: {
      bulkInsertAstNodes(
        batches: Array<{
          file: string;
          nodes: Array<{
            line: number;
            kind: string;
            name: string;
            text?: string | null;
            receiver?: string | null;
          }>;
        }>,
      ): number;
    };
    suspendJsDb?: () => void;
    resumeJsDb?: () => void;
  },
): Promise<void> {
  console.error(
    `[parity-diag:buildAstEntry] nativeDb=${!!engineOpts?.nativeDb}, bulkInsert=${!!engineOpts?.nativeDb?.bulkInsertAstNodes}, files=${fileSymbols.size}`,
  );

  // ── Native bulk-insert fast path ──────────────────────────────────────
  // Uses NativeDatabase persistent connection (Phase 6.15+).
  // Standalone napi functions were removed in 6.17.
  const nativeDb = engineOpts?.nativeDb;
  if (nativeDb?.bulkInsertAstNodes) {
    let needsJsFallback = false;
    const batches: Array<{
      file: string;
      nodes: Array<{
        line: number;
        kind: string;
        name: string;
        text?: string | null;
        receiver?: string | null;
      }>;
    }> = [];

    for (const [relPath, symbols] of fileSymbols) {
      if (Array.isArray(symbols.astNodes)) {
        batches.push({
          file: relPath,
          nodes: symbols.astNodes.map((n) => ({
            line: n.line,
            kind: n.kind,
            name: n.name,
            text: n.text,
            receiver: n.receiver,
          })),
        });
      } else if (symbols.calls || symbols._tree) {
        needsJsFallback = true;
        break;
      }
    }

    if (!needsJsFallback) {
      const expectedNodes = batches.reduce((s, b) => s + b.nodes.length, 0);
      let inserted: number;
      try {
        engineOpts?.suspendJsDb?.();
        inserted = nativeDb.bulkInsertAstNodes(batches);
      } finally {
        engineOpts?.resumeJsDb?.();
      }
      if (inserted === expectedNodes) {
        debug(`AST extraction (native bulk): ${inserted} nodes stored`);
        return;
      }
      debug(
        `AST extraction (native bulk): expected ${expectedNodes}, got ${inserted} — falling back to JS`,
      );
      // fall through to JS path
    }
  }

  // ── JS fallback path ──────────────────────────────────────────────────
  console.error('[parity-diag:buildAst] entering JS fallback path');
  let insertStmt: ReturnType<BetterSqlite3Database['prepare']>;
  try {
    insertStmt = db.prepare(
      'INSERT INTO ast_nodes (file, line, kind, name, text, receiver, parent_node_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
  } catch (e) {
    console.error(`[parity-diag:buildAst] prepare failed: ${(e as Error).message}`);
    debug('ast_nodes table not found — skipping AST extraction');
    return;
  }

  const tx = db.transaction((rows: AstRow[]) => {
    for (const r of rows) {
      insertStmt.run(r.file, r.line, r.kind, r.name, r.text, r.receiver, r.parentNodeId);
    }
  });

  const allRows: AstRow[] = [];

  for (const [relPath, symbols] of fileSymbols) {
    const defs = symbols.definitions || [];

    const nodeIdMap = new Map<string, number>();
    for (const row of bulkNodeIdsByFile(db, relPath)) {
      nodeIdMap.set(`${row.name}|${row.kind}|${row.line}`, row.id);
    }

    console.error(
      `[parity-diag:buildAst] ${relPath}: astNodes=${Array.isArray(symbols.astNodes) ? symbols.astNodes.length : 'undefined'}, _tree=${!!symbols._tree}`,
    );

    if (Array.isArray(symbols.astNodes)) {
      // Native engine provided AST nodes (may be empty for files with no AST content)
      for (const n of symbols.astNodes) {
        const parentDef = findParentDef(defs, n.line);
        let parentNodeId: number | null = null;
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
      // WASM fallback — walk tree if available
      const ext = path.extname(relPath).toLowerCase();
      if (WALK_EXTENSIONS.has(ext) && symbols._tree) {
        const astRows: AstRow[] = [];
        walkAst(symbols._tree.rootNode, defs, relPath, astRows, nodeIdMap);
        allRows.push(...astRows);
      }
    }
  }

  console.error(`[parity-diag:buildAst] total allRows=${allRows.length}`);
  if (allRows.length > 0) {
    tx(allRows);
  }

  debug(`AST extraction: ${allRows.length} nodes stored`);
}

function walkAst(
  rootNode: TreeSitterNode,
  defs: Definition[],
  relPath: string,
  rows: AstRow[],
  nodeIdMap: Map<string, number>,
): void {
  if (!JS_TS_AST_TYPES) {
    debug('ast-store: JS_TS_AST_TYPES not available — skipping walk');
    return;
  }
  const visitor = createAstStoreVisitor(JS_TS_AST_TYPES, defs, relPath, nodeIdMap);
  const results = walkWithVisitors(rootNode, [visitor], 'javascript');
  const collected = (results['ast-store'] || []) as AstRow[];
  rows.push(...collected);
}

// ─── Query ────────────────────────────────────────────────────────────

interface AstQueryRow {
  kind: string;
  name: string;
  file: string;
  line: number;
  text: string | null;
  receiver: string | null;
  parent_node_id: number | null;
  parent_name: string | null;
  parent_kind: string | null;
  parent_file: string | null;
}

interface AstQueryResult {
  kind: string;
  name: string;
  file: string;
  line: number;
  text: string | null;
  receiver: string | null;
  parent: { name: string | null; kind: string | null; file: string | null } | null;
}

interface AstQueryOpts {
  kind?: string;
  file?: string | string[];
  noTests?: boolean;
  limit?: number;
  offset?: number;
  json?: boolean;
  ndjson?: boolean;
}

export function astQueryData(
  pattern: string | undefined,
  customDbPath: string | undefined,
  opts: AstQueryOpts = {},
): {
  pattern: string;
  kind: string | null;
  count: number;
  results: AstQueryResult[];
  _pagination?: {
    hasMore: boolean;
    total: number;
    offset: number;
    returned: number;
    limit: number;
  };
} {
  const db = openReadonlyOrFail(customDbPath);
  const { kind, file, noTests, limit, offset } = opts;

  let where = 'WHERE 1=1';
  const params: unknown[] = [];

  if (pattern && pattern !== '*') {
    const globPattern = pattern.includes('*') ? pattern : `*${pattern}*`;
    where += ' AND a.name GLOB ?';
    params.push(globPattern);
  }

  if (kind) {
    where += ' AND a.kind = ?';
    params.push(kind);
  }

  {
    const fc = buildFileConditionSQL(file ?? [], 'a.file');
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

  let rows: AstQueryRow[];
  try {
    rows = db.prepare(sql).all(...params) as AstQueryRow[];
  } finally {
    db.close();
  }

  const results: AstQueryResult[] = rows.map((r) => ({
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

export function astQuery(
  pattern: string | undefined,
  customDbPath: string | undefined,
  opts: AstQueryOpts = {},
): void {
  const data = astQueryData(pattern, customDbPath, opts);

  if (outputResult(data, 'results', opts)) return;

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
