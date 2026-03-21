import type { BetterSqlite3Database, StmtCache } from '../../types.js';
import { cachedStmt } from './cached-stmt.js';

// ─── Statement caches (one prepared statement per db instance) ────────────
const _hasCoChangesStmt: StmtCache<{ 1: number }> = new WeakMap();
const _getCoChangeMetaStmt: StmtCache<{ key: string; value: string }> = new WeakMap();
const _upsertCoChangeMetaStmt: StmtCache = new WeakMap();

/**
 * Check whether the co_changes table has data.
 */
export function hasCoChanges(db: BetterSqlite3Database): boolean {
  try {
    return !!cachedStmt(_hasCoChangesStmt, db, 'SELECT 1 FROM co_changes LIMIT 1').get();
  } catch {
    return false;
  }
}

/**
 * Get all co-change metadata as a key-value map.
 */
export function getCoChangeMeta(db: BetterSqlite3Database): Record<string, string> {
  const meta: Record<string, string> = {};
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
 */
export function upsertCoChangeMeta(db: BetterSqlite3Database, key: string, value: string): void {
  cachedStmt(
    _upsertCoChangeMetaStmt,
    db,
    'INSERT INTO co_change_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
