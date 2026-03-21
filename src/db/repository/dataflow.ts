import type { BetterSqlite3Database, StmtCache } from '../../types.js';
import { cachedStmt } from './cached-stmt.js';

// ─── Statement caches (one prepared statement per db instance) ────────────
const _hasDataflowTableStmt: StmtCache<{ c: number }> = new WeakMap();

/**
 * Check whether the dataflow table exists and has data.
 */
export function hasDataflowTable(db: BetterSqlite3Database): boolean {
  try {
    return (
      (cachedStmt(_hasDataflowTableStmt, db, 'SELECT COUNT(*) AS c FROM dataflow').get()?.c ?? 0) >
      0
    );
  } catch {
    return false;
  }
}
