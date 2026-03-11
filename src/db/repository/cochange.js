import { cachedStmt } from './cached-stmt.js';

// ─── Statement caches (one prepared statement per db instance) ────────────
const _hasCoChangesStmt = new WeakMap();
const _getCoChangeMetaStmt = new WeakMap();
const _upsertCoChangeMetaStmt = new WeakMap();

/**
 * Check whether the co_changes table has data.
 * @param {object} db
 * @returns {boolean}
 */
export function hasCoChanges(db) {
  try {
    return !!cachedStmt(_hasCoChangesStmt, db, 'SELECT 1 FROM co_changes LIMIT 1').get();
  } catch {
    return false;
  }
}

/**
 * Get all co-change metadata as a key-value map.
 * @param {object} db
 * @returns {Record<string, string>}
 */
export function getCoChangeMeta(db) {
  const meta = {};
  try {
    for (const row of cachedStmt(
      _getCoChangeMetaStmt,
      db,
      'SELECT key, value FROM co_change_meta',
    ).all()) {
      meta[row.key] = row.value;
    }
  } catch {
    /* table may not exist */
  }
  return meta;
}

/**
 * Upsert a co-change metadata key-value pair.
 * @param {object} db
 * @param {string} key
 * @param {string} value
 */
export function upsertCoChangeMeta(db, key, value) {
  cachedStmt(
    _upsertCoChangeMetaStmt,
    db,
    'INSERT INTO co_change_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
