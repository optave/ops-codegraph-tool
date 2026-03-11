/**
 * Resolve a cached prepared statement, compiling on first use per db.
 * Each `cache` WeakMap must always be called with the same `sql` —
 * the sql argument is only used on the first compile; subsequent calls
 * return the cached statement regardless of the sql passed.
 *
 * @param {WeakMap} cache  - WeakMap keyed by db instance
 * @param {object}  db     - better-sqlite3 database instance
 * @param {string}  sql    - SQL to compile on first use
 * @returns {object} prepared statement
 */
export function cachedStmt(cache, db, sql) {
  let stmt = cache.get(db);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(db, stmt);
  }
  return stmt;
}
