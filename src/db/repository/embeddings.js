/**
 * Check whether the embeddings table has data.
 * @param {object} db
 * @returns {boolean}
 */
export function hasEmbeddings(db) {
  try {
    return !!db.prepare('SELECT 1 FROM embeddings LIMIT 1').get();
  } catch {
    return false;
  }
}

/**
 * Get the count of embeddings.
 * @param {object} db
 * @returns {number}
 */
export function getEmbeddingCount(db) {
  try {
    return db.prepare('SELECT COUNT(*) AS c FROM embeddings').get().c;
  } catch {
    return 0;
  }
}

/**
 * Get a single embedding metadata value by key.
 * @param {object} db
 * @param {string} key
 * @returns {string|undefined}
 */
export function getEmbeddingMeta(db, key) {
  try {
    const row = db.prepare('SELECT value FROM embedding_meta WHERE key = ?').get(key);
    return row?.value;
  } catch {
    return undefined;
  }
}
