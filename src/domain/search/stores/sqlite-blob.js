/**
 * @typedef {object} VectorStore
 * @property {(queryVec: Float32Array, rows: Array<{vector: Buffer}>) => Array<{index: number, score: number}>} search
 *   Score every row against a query vector and return scored indices.
 *
 * Future implementations (e.g. HNSW via `hnsw.js`) implement this same shape
 * for approximate nearest-neighbor search.
 */

/**
 * Cosine similarity between two Float32Arrays.
 */
export function cosineSim(a, b) {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
