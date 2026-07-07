import type {
  BetterSqlite3Database,
  ChunkStmtCache,
  SqliteStatement,
  StmtCache,
} from '../../types.js';

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

/**
 * Resolve a cached prepared statement for a multi-value INSERT/UPDATE whose
 * SQL text depends on a chunk size (e.g. the number of `?` placeholders in
 * an `IN (...)` clause), compiling on first use per db + chunk size.
 *
 * `buildSql` is only invoked on a cache miss; subsequent calls with the same
 * `db`/`chunkSize` pair return the cached statement without re-invoking it.
 */
export function cachedChunkStmt<TRow = unknown>(
  cache: ChunkStmtCache<TRow>,
  db: BetterSqlite3Database,
  chunkSize: number,
  buildSql: (chunkSize: number) => string,
): SqliteStatement<TRow> {
  let perDb = cache.get(db);
  if (!perDb) {
    perDb = new Map();
    cache.set(db, perDb);
  }
  let stmt = perDb.get(chunkSize);
  if (!stmt) {
    stmt = db.prepare<TRow>(buildSql(chunkSize));
    perDb.set(chunkSize, stmt);
  }
  return stmt;
}
