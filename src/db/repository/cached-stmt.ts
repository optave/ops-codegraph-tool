import type { BetterSqlite3Database, SqliteStatement, StmtCache } from '../../types.js';

/**
 * Resolve a cached prepared statement, compiling on first use per db.
 * Each `cache` WeakMap must always be called with the same `sql` —
 * the sql argument is only used on the first compile; subsequent calls
 * return the cached statement regardless of the sql passed.
 */
export function cachedStmt<TRow = unknown>(
  cache: StmtCache<TRow>,
  db: BetterSqlite3Database,
  sql: string,
): SqliteStatement<TRow> {
  let stmt = cache.get(db);
  if (!stmt) {
    stmt = db.prepare<TRow>(sql);
    cache.set(db, stmt);
  }
  return stmt;
}
