import path from 'node:path';
import {
  AST_STRING_CONFIGS,
  AST_TYPE_MAPS,
  astStopRecurseKinds,
} from '../ast-analysis/rules/index.js';
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

export const AST_NODE_KINDS: ASTNodeKind[] = ['new', 'string', 'regex', 'throw', 'await'];

const KIND_ICONS: Record<string, string> = {
  new: '\u2295', // ⊕
  string: '"',
  regex: '/',
  throw: '\u2191', // ↑
  await: '\u22B3', // ⊳
};

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

// ─── Build helpers ───────────────────────────────────────────────────

interface NativeDbHandle {
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
}

interface EngineOpts {
  nativeDb?: NativeDbHandle;
  suspendJsDb?: () => void;
  resumeJsDb?: () => void;
}

/**
 * Attempt native bulk-insert of AST nodes.
 * Returns `true` if all nodes were inserted natively, `false` if JS fallback is needed.
 */
function tryNativeBulkInsert(
  fileSymbols: Map<string, FileSymbols>,
  engineOpts: EngineOpts | undefined,
): boolean {
  const nativeDb = engineOpts?.nativeDb;
  if (!nativeDb?.bulkInsertAstNodes) return false;

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
          receiver: n.receiver ?? '',
        })),
      });
    } else if (symbols._tree) {
      return false; // has WASM tree not yet processed — needs JS fallback
    }
  }

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
    return true;
  }
  debug(
    `AST extraction (native bulk): expected ${expectedNodes}, got ${inserted} — falling back to JS`,
  );
  return false;
}

/** Collect AST rows for a single file, resolving parent node IDs. */
function collectFileAstRows(
  db: BetterSqlite3Database,
  relPath: string,
  symbols: FileSymbols,
): AstRow[] {
  const defs = symbols.definitions || [];
  const nodeIdMap = new Map<string, number>();
  for (const row of bulkNodeIdsByFile(db, relPath)) {
    nodeIdMap.set(`${row.name}|${row.kind}|${row.line}`, row.id);
  }

  if (Array.isArray(symbols.astNodes)) {
    return symbols.astNodes.map((n) => {
      const parentDef = findParentDef(defs, n.line);
      const parentNodeId = parentDef
        ? nodeIdMap.get(`${parentDef.name}|${parentDef.kind}|${parentDef.line}`) || null
        : null;
      return {
        file: relPath,
        line: n.line,
        kind: n.kind,
        name: n.name,
        text: n.text || null,
        receiver: n.receiver || null,
        parentNodeId,
      };
    });
  }

  // WASM fallback — walk tree if available
  const ext = path.extname(relPath).toLowerCase();
  const langId = symbols._langId || '';
  if ((WALK_EXTENSIONS.has(ext) || AST_TYPE_MAPS.has(langId)) && symbols._tree) {
    const rows: AstRow[] = [];
    walkAst(symbols._tree.rootNode, defs, relPath, rows, nodeIdMap, langId);
    return rows;
  }

  return [];
}

// ─── Build ────────────────────────────────────────────────────────────

export async function buildAstNodes(
  db: BetterSqlite3Database,
  fileSymbols: Map<string, FileSymbols>,
  _rootDir: string,
  engineOpts?: EngineOpts,
): Promise<void> {
  // Native bulk-insert fast path (Phase 6.15+)
  if (tryNativeBulkInsert(fileSymbols, engineOpts)) return;

  // JS fallback path
  let insertStmt: ReturnType<BetterSqlite3Database['prepare']>;
  try {
    insertStmt = db.prepare(
      'INSERT INTO ast_nodes (file, line, kind, name, text, receiver, parent_node_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
  } catch {
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
    allRows.push(...collectFileAstRows(db, relPath, symbols));
  }

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
  langId: string,
): void {
  const astTypeMap = AST_TYPE_MAPS.get(langId);
  if (!astTypeMap) {
    debug(`ast-store: no astTypes for langId=${langId} — skipping walk`);
    return;
  }
  const stringConfig = AST_STRING_CONFIGS.get(langId);
  const visitor = createAstStoreVisitor(
    astTypeMap,
    defs,
    relPath,
    nodeIdMap,
    stringConfig,
    astStopRecurseKinds(langId),
  );
  const results = walkWithVisitors(rootNode, [visitor], langId);
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
    process.stdout.write(`No AST nodes found${pattern ? ` matching "${pattern}"` : ''}.\n`);
    return;
  }

  const kindLabel = opts.kind ? ` (kind: ${opts.kind})` : '';
  process.stdout.write(
    `\n${data.count} AST nodes${pattern ? ` matching "${pattern}"` : ''}${kindLabel}:\n\n`,
  );

  for (const r of data.results) {
    const icon = KIND_ICONS[r.kind] || '?';
    const parentInfo = r.parent ? `  (in ${r.parent.name})` : '';
    process.stdout.write(`  ${icon} ${r.name}  -- ${r.file}:${r.line}${parentInfo}\n`);
  }

  if (data._pagination?.hasMore) {
    process.stdout.write(
      `\n  ... ${data._pagination.total - data._pagination.offset - data._pagination.returned} more (use --offset ${data._pagination.offset + data._pagination.limit})\n`,
    );
  }
  process.stdout.write('\n');
}
