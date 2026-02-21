/**
 * codegraph — Programmatic API
 *
 * Usage:
 *   import { buildGraph, queryNameData, findCycles, exportDOT } from 'codegraph';
 */

// Graph building
export { buildGraph, resolveImportPath, collectFiles, loadPathAliases } from './builder.js';

// Query functions (data-returning)
export {
  queryNameData, impactAnalysisData, moduleMapData,
  fileDepsData, fnDepsData, fnImpactData, diffImpactData
} from './queries.js';

// Watch mode
export { watchProject } from './watcher.js';

// Export (DOT/Mermaid/JSON)
export { exportDOT, exportMermaid, exportJSON } from './export.js';

// Circular dependency detection
export { findCycles, formatCycles } from './cycles.js';

// Embeddings
export { buildEmbeddings, search, searchData, multiSearchData, embed, cosineSim, MODELS, DEFAULT_MODEL } from './embedder.js';

// Database utilities
export { openDb, initSchema, findDbPath, openReadonlyOrFail } from './db.js';

// Configuration
export { loadConfig } from './config.js';

// Shared constants
export { EXTENSIONS, IGNORE_DIRS, normalizePath } from './constants.js';

// Logger
export { setVerbose } from './logger.js';
