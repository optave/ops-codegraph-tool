import { ConfigError } from '../../shared/errors.js';
import { EVERY_SYMBOL_KIND, VALID_ROLES } from '../../shared/kinds.js';
import { buildFileConditionSQL, NodeQuery } from '../query-builder.js';
import { cachedStmt } from './cached-stmt.js';

// ─── Query-builder based lookups (moved from src/db/repository.js) ─────

/**
 * Find nodes matching a name pattern, with fan-in count.
 * @param {object} db
 * @param {string} namePattern - LIKE pattern (already wrapped with %)
 * @param {object} [opts]
 * @param {string[]} [opts.kinds]
 * @param {string} [opts.file]
 * @returns {object[]}
 */
export function findNodesWithFanIn(db, namePattern, opts = {}) {
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
 * @param {object} db
 * @param {object} [opts]
 * @returns {object[]}
 */
export function findNodesForTriage(db, opts = {}) {
  if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
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
      `n.id, n.name, n.kind, n.file, n.line, n.end_line, n.role,
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
 * @param {object} [opts]
 * @returns {NodeQuery}
 */
function _functionNodeQuery(opts = {}) {
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
 * @param {object} db
 * @param {object} [opts]
 * @returns {object[]}
 */
export function listFunctionNodes(db, opts = {}) {
  return _functionNodeQuery(opts).all(db);
}

/**
 * Iterator version of listFunctionNodes for memory efficiency.
 * @param {object} db
 * @param {object} [opts]
 * @returns {IterableIterator}
 */
export function iterateFunctionNodes(db, opts = {}) {
  return _functionNodeQuery(opts).iterate(db);
}

// ─── Statement caches (one prepared statement per db instance) ────────────
// WeakMap keys on the db object so statements are GC'd when the db closes.
const _countNodesStmt = new WeakMap();
const _countEdgesStmt = new WeakMap();
const _countFilesStmt = new WeakMap();
const _findNodeByIdStmt = new WeakMap();
const _findNodesByFileStmt = new WeakMap();
const _findFileNodesStmt = new WeakMap();
const _getNodeIdStmt = new WeakMap();
const _getFunctionNodeIdStmt = new WeakMap();
const _bulkNodeIdsByFileStmt = new WeakMap();
const _findNodeChildrenStmt = new WeakMap();
const _findNodeByQualifiedNameStmt = new WeakMap();

/**
 * Count total nodes.
 * @param {object} db
 * @returns {number}
 */
export function countNodes(db) {
  return cachedStmt(_countNodesStmt, db, 'SELECT COUNT(*) AS cnt FROM nodes').get().cnt;
}

/**
 * Count total edges.
 * @param {object} db
 * @returns {number}
 */
export function countEdges(db) {
  return cachedStmt(_countEdgesStmt, db, 'SELECT COUNT(*) AS cnt FROM edges').get().cnt;
}

/**
 * Count distinct files.
 * @param {object} db
 * @returns {number}
 */
export function countFiles(db) {
  return cachedStmt(_countFilesStmt, db, 'SELECT COUNT(DISTINCT file) AS cnt FROM nodes').get().cnt;
}

// ─── Shared node lookups ───────────────────────────────────────────────

/**
 * Find a single node by ID.
 * @param {object} db
 * @param {number} id
 * @returns {object|undefined}
 */
export function findNodeById(db, id) {
  return cachedStmt(_findNodeByIdStmt, db, 'SELECT * FROM nodes WHERE id = ?').get(id);
}

/**
 * Find non-file nodes for a given file path (exact match), ordered by line.
 * @param {object} db
 * @param {string} file - Exact file path
 * @returns {object[]}
 */
export function findNodesByFile(db, file) {
  return cachedStmt(
    _findNodesByFileStmt,
    db,
    "SELECT * FROM nodes WHERE file = ? AND kind != 'file' ORDER BY line",
  ).all(file);
}

/**
 * Find file-kind nodes matching a LIKE pattern.
 * @param {object} db
 * @param {string} fileLike - LIKE pattern (caller wraps with %)
 * @returns {object[]}
 */
export function findFileNodes(db, fileLike) {
  return cachedStmt(
    _findFileNodesStmt,
    db,
    "SELECT * FROM nodes WHERE file LIKE ? AND kind = 'file'",
  ).all(fileLike);
}

/**
 * Look up a node's ID by its unique (name, kind, file, line) tuple.
 * Shared by builder, watcher, structure, complexity, cfg, engine.
 * @param {object} db
 * @param {string} name
 * @param {string} kind
 * @param {string} file
 * @param {number} line
 * @returns {number|undefined}
 */
export function getNodeId(db, name, kind, file, line) {
  return cachedStmt(
    _getNodeIdStmt,
    db,
    'SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ? AND line = ?',
  ).get(name, kind, file, line)?.id;
}

/**
 * Look up a function/method node's ID (kind-restricted variant of getNodeId).
 * Used by complexity.js, cfg.js where only function/method kinds are expected.
 * @param {object} db
 * @param {string} name
 * @param {string} file
 * @param {number} line
 * @returns {number|undefined}
 */
export function getFunctionNodeId(db, name, file, line) {
  return cachedStmt(
    _getFunctionNodeIdStmt,
    db,
    "SELECT id FROM nodes WHERE name = ? AND kind IN ('function','method') AND file = ? AND line = ?",
  ).get(name, file, line)?.id;
}

/**
 * Bulk-fetch all node IDs for a file in one query.
 * Returns rows suitable for building a `name|kind|line -> id` lookup map.
 * Shared by builder, ast.js, ast-analysis/engine.js.
 * @param {object} db
 * @param {string} file
 * @returns {{ id: number, name: string, kind: string, line: number }[]}
 */
export function bulkNodeIdsByFile(db, file) {
  return cachedStmt(
    _bulkNodeIdsByFileStmt,
    db,
    'SELECT id, name, kind, line FROM nodes WHERE file = ?',
  ).all(file);
}

/**
 * Find child nodes (parameters, properties, constants) of a parent.
 * @param {object} db
 * @param {number} parentId
 * @returns {{ name: string, kind: string, line: number, end_line: number|null, qualified_name: string|null, scope: string|null, visibility: string|null }[]}
 */
export function findNodeChildren(db, parentId) {
  return cachedStmt(
    _findNodeChildrenStmt,
    db,
    'SELECT name, kind, line, end_line, qualified_name, scope, visibility FROM nodes WHERE parent_id = ? ORDER BY line',
  ).all(parentId);
}

/**
 * Find all nodes that belong to a given scope (by scope column).
 * Enables "all methods of class X" without traversing edges.
 * @param {object} db
 * @param {string} scopeName - The scope to search for (e.g., class name)
 * @param {object} [opts]
 * @param {string} [opts.kind] - Filter by node kind
 * @param {string} [opts.file] - Filter by file path (LIKE match)
 * @returns {object[]}
 */
export function findNodesByScope(db, scopeName, opts = {}) {
  let sql = 'SELECT * FROM nodes WHERE scope = ?';
  const params = [scopeName];
  if (opts.kind) {
    sql += ' AND kind = ?';
    params.push(opts.kind);
  }
  const fc = buildFileConditionSQL(opts.file, 'file');
  sql += fc.sql;
  params.push(...fc.params);
  sql += ' ORDER BY file, line';
  return db.prepare(sql).all(...params);
}

/**
 * Find nodes by qualified name. Returns all matches since the same
 * qualified_name can exist in different files (e.g., two classes named
 * `DateHelper.format` in separate modules). Pass `opts.file` to narrow.
 * @param {object} db
 * @param {string} qualifiedName - e.g., 'DateHelper.format'
 * @param {object} [opts]
 * @param {string} [opts.file] - Filter by file path (LIKE match)
 * @returns {object[]}
 */
export function findNodeByQualifiedName(db, qualifiedName, opts = {}) {
  const fc = buildFileConditionSQL(opts.file, 'file');
  if (fc.sql) {
    return db
      .prepare(`SELECT * FROM nodes WHERE qualified_name = ?${fc.sql} ORDER BY file, line`)
      .all(qualifiedName, ...fc.params);
  }
  return cachedStmt(
    _findNodeByQualifiedNameStmt,
    db,
    'SELECT * FROM nodes WHERE qualified_name = ? ORDER BY file, line',
  ).all(qualifiedName);
}
