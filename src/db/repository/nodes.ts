import { ConfigError } from '../../shared/errors.js';
import { EVERY_SYMBOL_KIND, VALID_ROLES } from '../../shared/kinds.js';
import type {
  BetterSqlite3Database,
  ChildNodeRow,
  ListFunctionOpts,
  NodeIdRow,
  NodeRow,
  NodeRowWithFanIn,
  QueryOpts,
  StmtCache,
  TriageNodeRow,
  TriageQueryOpts,
} from '../../types.js';
import { buildFileConditionSQL, NodeQuery } from '../query-builder.js';
import { cachedStmt } from './cached-stmt.js';

// ─── Query-builder based lookups (moved from src/db/repository.js) ─────

/**
 * Find nodes matching a name pattern, with fan-in count.
 */
export function findNodesWithFanIn(
  db: BetterSqlite3Database,
  namePattern: string,
  opts: QueryOpts = {},
): NodeRowWithFanIn[] {
  const q = new NodeQuery()
    .select('n.*, COALESCE(fi.cnt, 0) AS fan_in')
    .withFanIn()
    .where('n.name LIKE ?', namePattern);

  if (opts.kinds) {
    q.kinds(opts.kinds);
  }
  if (opts.file) {
    q.fileFilter(opts.file);
  }

  return q.all(db);
}

/**
 * Fetch nodes for triage scoring: fan-in + complexity + churn.
 */
export function findNodesForTriage(
  db: BetterSqlite3Database,
  opts: TriageQueryOpts = {},
): TriageNodeRow[] {
  if (opts.kind && !(EVERY_SYMBOL_KIND as readonly string[]).includes(opts.kind)) {
    throw new ConfigError(
      `Invalid kind: ${opts.kind} (expected one of ${EVERY_SYMBOL_KIND.join(', ')})`,
    );
  }
  if (opts.role && !VALID_ROLES.includes(opts.role)) {
    throw new ConfigError(`Invalid role: ${opts.role} (expected one of ${VALID_ROLES.join(', ')})`);
  }

  const kindsToUse = opts.kind ? [opts.kind] : ['function', 'method', 'class'];
  const q = new NodeQuery()
    .select(
      `n.id, n.name, n.kind, n.file, n.line, n.end_line,
              n.parent_id, n.exported, n.qualified_name, n.scope, n.visibility, n.role,
              COALESCE(fi.cnt, 0) AS fan_in,
              COALESCE(fc.cognitive, 0) AS cognitive,
              COALESCE(fc.maintainability_index, 0) AS mi,
              COALESCE(fc.cyclomatic, 0) AS cyclomatic,
              COALESCE(fc.max_nesting, 0) AS max_nesting,
              COALESCE(fcc.commit_count, 0) AS churn`,
    )
    .kinds(kindsToUse)
    .withFanIn()
    .withComplexity()
    .withChurn()
    .excludeTests(opts.noTests)
    .fileFilter(opts.file)
    .roleFilter(opts.role)
    .orderBy('n.file, n.line');

  return q.all(db);
}

/**
 * Shared query builder for function/method/class node listing.
 */
function _functionNodeQuery(opts: ListFunctionOpts = {}): InstanceType<typeof NodeQuery> {
  return new NodeQuery()
    .select('name, kind, file, line, end_line, role')
    .kinds(['function', 'method', 'class'])
    .fileFilter(opts.file)
    .nameLike(opts.pattern)
    .excludeTests(opts.noTests)
    .orderBy('file, line');
}

/**
 * List function/method/class nodes with basic info.
 */
export function listFunctionNodes(
  db: BetterSqlite3Database,
  opts: ListFunctionOpts = {},
): NodeRow[] {
  return _functionNodeQuery(opts).all(db);
}

/**
 * Iterator version of listFunctionNodes for memory efficiency.
 */
export function iterateFunctionNodes(
  db: BetterSqlite3Database,
  opts: ListFunctionOpts = {},
): IterableIterator<NodeRow> {
  return _functionNodeQuery(opts).iterate(db);
}

// ─── Statement caches (one prepared statement per db instance) ────────────
// WeakMap keys on the db object so statements are GC'd when the db closes.
const _countNodesStmt: StmtCache<{ cnt: number }> = new WeakMap();
const _countEdgesStmt: StmtCache<{ cnt: number }> = new WeakMap();
const _countFilesStmt: StmtCache<{ cnt: number }> = new WeakMap();
const _findNodeByIdStmt: StmtCache<NodeRow> = new WeakMap();
const _findNodesByFileStmt: StmtCache<NodeRow> = new WeakMap();
const _findFileNodesStmt: StmtCache<NodeRow> = new WeakMap();
const _getNodeIdStmt: StmtCache<{ id: number }> = new WeakMap();
const _getFunctionNodeIdStmt: StmtCache<{ id: number }> = new WeakMap();
const _bulkNodeIdsByFileStmt: StmtCache<NodeIdRow> = new WeakMap();
const _findNodeChildrenStmt: StmtCache<ChildNodeRow> = new WeakMap();
const _findNodeByQualifiedNameStmt: StmtCache<NodeRow> = new WeakMap();

/**
 * Count total nodes.
 */
export function countNodes(db: BetterSqlite3Database): number {
  return cachedStmt(_countNodesStmt, db, 'SELECT COUNT(*) AS cnt FROM nodes').get()?.cnt ?? 0;
}

/**
 * Count total edges.
 */
export function countEdges(db: BetterSqlite3Database): number {
  return cachedStmt(_countEdgesStmt, db, 'SELECT COUNT(*) AS cnt FROM edges').get()?.cnt ?? 0;
}

/**
 * Count distinct files.
 */
export function countFiles(db: BetterSqlite3Database): number {
  return (
    cachedStmt(_countFilesStmt, db, 'SELECT COUNT(DISTINCT file) AS cnt FROM nodes').get()?.cnt ?? 0
  );
}

// ─── Shared node lookups ───────────────────────────────────────────────

/**
 * Find a single node by ID.
 */
export function findNodeById(db: BetterSqlite3Database, id: number): NodeRow | undefined {
  return cachedStmt(_findNodeByIdStmt, db, 'SELECT * FROM nodes WHERE id = ?').get(id);
}

/**
 * Find non-file nodes for a given file path (exact match), ordered by line.
 */
export function findNodesByFile(db: BetterSqlite3Database, file: string): NodeRow[] {
  return cachedStmt(
    _findNodesByFileStmt,
    db,
    "SELECT * FROM nodes WHERE file = ? AND kind != 'file' ORDER BY line",
  ).all(file);
}

/**
 * Find file-kind nodes matching a LIKE pattern.
 */
export function findFileNodes(db: BetterSqlite3Database, fileLike: string): NodeRow[] {
  return cachedStmt(
    _findFileNodesStmt,
    db,
    "SELECT * FROM nodes WHERE file LIKE ? AND kind = 'file'",
  ).all(fileLike);
}

/**
 * Look up a node's ID by its unique (name, kind, file, line) tuple.
 */
export function getNodeId(
  db: BetterSqlite3Database,
  name: string,
  kind: string,
  file: string,
  line: number,
): number | undefined {
  return cachedStmt(
    _getNodeIdStmt,
    db,
    'SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ? AND line = ?',
  ).get(name, kind, file, line)?.id;
}

/**
 * Look up a function/method node's ID (kind-restricted variant of getNodeId).
 */
export function getFunctionNodeId(
  db: BetterSqlite3Database,
  name: string,
  file: string,
  line: number,
): number | undefined {
  return cachedStmt(
    _getFunctionNodeIdStmt,
    db,
    "SELECT id FROM nodes WHERE name = ? AND kind IN ('function','method') AND file = ? AND line = ?",
  ).get(name, file, line)?.id;
}

/**
 * Bulk-fetch all node IDs for a file in one query.
 */
export function bulkNodeIdsByFile(db: BetterSqlite3Database, file: string): NodeIdRow[] {
  return cachedStmt(
    _bulkNodeIdsByFileStmt,
    db,
    'SELECT id, name, kind, line FROM nodes WHERE file = ?',
  ).all(file);
}

/**
 * Find child nodes (parameters, properties, constants) of a parent.
 */
export function findNodeChildren(db: BetterSqlite3Database, parentId: number): ChildNodeRow[] {
  return cachedStmt(
    _findNodeChildrenStmt,
    db,
    'SELECT name, kind, line, end_line, qualified_name, scope, visibility FROM nodes WHERE parent_id = ? ORDER BY line',
  ).all(parentId);
}

/**
 * Find all nodes that belong to a given scope (by scope column).
 */
export function findNodesByScope(
  db: BetterSqlite3Database,
  scopeName: string,
  opts: QueryOpts = {},
): NodeRow[] {
  let sql = 'SELECT * FROM nodes WHERE scope = ?';
  const params: unknown[] = [scopeName];
  if (opts.kind) {
    sql += ' AND kind = ?';
    params.push(opts.kind);
  }
  const fc = buildFileConditionSQL(opts.file ?? '', 'file');
  sql += fc.sql;
  params.push(...fc.params);
  sql += ' ORDER BY file, line';
  return db.prepare<NodeRow>(sql).all(...params);
}

/**
 * Find nodes by qualified name.
 */
export function findNodeByQualifiedName(
  db: BetterSqlite3Database,
  qualifiedName: string,
  opts: { file?: string } = {},
): NodeRow[] {
  const fc = buildFileConditionSQL(opts.file ?? '', 'file');
  if (fc.sql) {
    return db
      .prepare<NodeRow>(`SELECT * FROM nodes WHERE qualified_name = ?${fc.sql} ORDER BY file, line`)
      .all(qualifiedName, ...fc.params);
  }
  return cachedStmt(
    _findNodeByQualifiedNameStmt,
    db,
    'SELECT * FROM nodes WHERE qualified_name = ? ORDER BY file, line',
  ).all(qualifiedName);
}

// ─── Metric helpers ──────────────────────────────────────────────────────

const _getLineCountForNodeStmt: StmtCache<{ line_count: number }> = new WeakMap();

/**
 * Get line_count from node_metrics for a given node.
 * @param {object} db
 * @param {number} nodeId
 * @returns {{ line_count: number } | undefined}
 */
export function getLineCountForNode(db: BetterSqlite3Database, nodeId: number) {
  return cachedStmt(
    _getLineCountForNodeStmt,
    db,
    'SELECT line_count FROM node_metrics WHERE node_id = ?',
  ).get(nodeId);
}

const _getMaxEndLineForFileStmt: StmtCache<{ max_end: number | null }> = new WeakMap();

/**
 * Get the maximum end_line across all nodes in a file.
 * @param {object} db
 * @param {string} file
 * @returns {{ max_end: number | null } | undefined}
 */
export function getMaxEndLineForFile(db: BetterSqlite3Database, file: string) {
  return cachedStmt(
    _getMaxEndLineForFileStmt,
    db,
    'SELECT MAX(end_line) as max_end FROM nodes WHERE file = ?',
  ).get(file);
}
