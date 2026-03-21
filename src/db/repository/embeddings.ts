import type { BetterSqlite3Database, StmtCache } from '../../types.js';
import { cachedStmt } from './cached-stmt.js';

// ─── Statement caches (one prepared statement per db instance) ────────────
const _hasEmbeddingsStmt: StmtCache<{ 1: number }> = new WeakMap();
const _getEmbeddingCountStmt: StmtCache<{ c: number }> = new WeakMap();
const _getEmbeddingMetaStmt: StmtCache<{ value: string }> = new WeakMap();

/**
 * Check whether the embeddings table has data.
 */
export function hasEmbeddings(db: BetterSqlite3Database): boolean {
  try {
    return !!cachedStmt(_hasEmbeddingsStmt, db, 'SELECT 1 FROM embeddings LIMIT 1').get();
  } catch {
    return false;
  }
}

/**
 * Get the count of embeddings.
 */
export function getEmbeddingCount(db: BetterSqlite3Database): number {
  try {
    return (
      cachedStmt(_getEmbeddingCountStmt, db, 'SELECT COUNT(*) AS c FROM embeddings').get()?.c ?? 0
    );
  } catch {
    return 0;
  }
}

/**
 * Get a single embedding metadata value by key.
 */
export function getEmbeddingMeta(db: BetterSqlite3Database, key: string): string | undefined {
  try {
    const row = cachedStmt(
      _getEmbeddingMetaStmt,
      db,
      'SELECT value FROM embedding_meta WHERE key = ?',
    ).get(key);
    return row?.value;
  } catch {
    return undefined;
  }
}
