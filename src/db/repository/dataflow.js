import { cachedStmt } from './cached-stmt.js';

// ─── Statement caches (one prepared statement per db instance) ────────────
const _hasDataflowTableStmt = new WeakMap();

/**
 * Check whether the dataflow table exists and has data.
 * @param {object} db
 * @returns {boolean}
 */
export function hasDataflowTable(db) {
  try {
    return cachedStmt(_hasDataflowTableStmt, db, 'SELECT COUNT(*) AS c FROM dataflow').get().c > 0;
  } catch {
    return false;
  }
}
