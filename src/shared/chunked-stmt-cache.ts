/**
 * Chunk-size-keyed prepared-statement cache.
 *
 * Many call sites build a multi-value SQL statement (`INSERT ... VALUES
 * (?,?,?),(?,?,?),...` or `UPDATE ... WHERE id IN (?,?,?)`) sized to a batch
 * of rows, then re-run that exact statement for every batch of the same size.
 * Recompiling the statement per batch is wasteful — this module memoizes the
 * prepared statement by chunk size so it is built once per distinct size.
 *
 * Extracted from a duplicate between the node/edge/export batch-insert
 * helpers in `domain/graph/builder/helpers.ts` and the node-role batch-update
 * in `features/structure.ts`, which each re-implemented this exact
 * check-cache/prepare/cache-set shape independently.
 */
import type { BetterSqlite3Database, SqliteStatement } from '../types.js';

/**
 * Get (or lazily prepare + cache) a SQL statement for a given chunk size,
 * memoized in `cache`. `buildSql` is only invoked on a cache miss.
 */
export function getOrCreateChunkStmt<TRow = unknown>(
  cache: Map<number, SqliteStatement<TRow>>,
  db: BetterSqlite3Database,
  chunkSize: number,
  buildSql: (chunkSize: number) => string,
): SqliteStatement<TRow> {
  let stmt = cache.get(chunkSize);
  if (!stmt) {
    stmt = db.prepare<TRow>(buildSql(chunkSize));
    cache.set(chunkSize, stmt);
  }
  return stmt;
}

/**
 * Per-database variant of {@link getOrCreateChunkStmt}: resolves (or lazily
 * creates) the chunk-size cache scoped to `db` inside `dbCache`, then
 * delegates to it.
 *
 * Use this when the cache must persist across many calls (e.g. repeated
 * batch inserts over the lifetime of a build) and needs to be keyed per
 * database instance — so independent connections (such as isolated test
 * databases) never collide, and cached statements are released once `db` is
 * garbage collected.
 */
export function getOrCreatePerDbChunkStmt<TRow = unknown>(
  dbCache: WeakMap<BetterSqlite3Database, Map<number, SqliteStatement<TRow>>>,
  db: BetterSqlite3Database,
  chunkSize: number,
  buildSql: (chunkSize: number) => string,
): SqliteStatement<TRow> {
  let perDb = dbCache.get(db);
  if (!perDb) {
    perDb = new Map();
    dbCache.set(db, perDb);
  }
  return getOrCreateChunkStmt(perDb, db, chunkSize, buildSql);
}
