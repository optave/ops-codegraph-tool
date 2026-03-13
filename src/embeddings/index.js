/**
 * Embeddings subsystem — public API barrel.
 *
 * Re-exports everything consumers previously imported from `../embedder.js`.
 */

export { buildEmbeddings, estimateTokens } from './generator.js';
export { DEFAULT_MODEL, disposeModel, EMBEDDING_STRATEGIES, embed, MODELS } from './models.js';
export { search } from './search/cli-formatter.js';
export { hybridSearchData } from './search/hybrid.js';
export { ftsSearchData } from './search/keyword.js';
export { multiSearchData, searchData } from './search/semantic.js';
export { cosineSim } from './stores/sqlite-blob.js';
