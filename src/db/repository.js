import { EVERY_SYMBOL_KIND, VALID_ROLES } from '../kinds.js';
import { NodeQuery } from './query-builder.js';

/**
 * Find nodes matching a name pattern, with fan-in count.
 * Used by findMatchingNodes in queries.js.
 *
 * @param {object} db - Database instance
 * @param {string} namePattern - LIKE pattern (already wrapped with %)
 * @param {object} [opts]
 * @param {string[]} [opts.kinds] - Node kinds to match
 * @param {string} [opts.file] - File filter (partial match)
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
 * Used by triageData in triage.js.
 *
 * @param {object} db
 * @param {object} [opts]
 * @returns {object[]}
 */
export function findNodesForTriage(db, opts = {}) {
  if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
    throw new Error(`Invalid kind: ${opts.kind} (expected one of ${EVERY_SYMBOL_KIND.join(', ')})`);
  }
  if (opts.role && !VALID_ROLES.includes(opts.role)) {
    throw new Error(`Invalid role: ${opts.role} (expected one of ${VALID_ROLES.join(', ')})`);
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
 * Used by listFunctionsData in queries.js.
 *
 * @param {object} db
 * @param {object} [opts]
 * @returns {object[]}
 */
export function listFunctionNodes(db, opts = {}) {
  return _functionNodeQuery(opts).all(db);
}

/**
 * Iterator version of listFunctionNodes for memory efficiency.
 * Used by iterListFunctions in queries.js.
 *
 * @param {object} db
 * @param {object} [opts]
 * @returns {IterableIterator}
 */
export function iterateFunctionNodes(db, opts = {}) {
  return _functionNodeQuery(opts).iterate(db);
}

/**
 * Count total nodes.
 * @param {object} db
 * @returns {number}
 */
export function countNodes(db) {
  return db.prepare('SELECT COUNT(*) AS cnt FROM nodes').get().cnt;
}

/**
 * Count total edges.
 * @param {object} db
 * @returns {number}
 */
export function countEdges(db) {
  return db.prepare('SELECT COUNT(*) AS cnt FROM edges').get().cnt;
}

/**
 * Count distinct files.
 * @param {object} db
 * @returns {number}
 */
export function countFiles(db) {
  return db.prepare('SELECT COUNT(DISTINCT file) AS cnt FROM nodes').get().cnt;
}
