/**
 * codegraph — Programmatic API
 *
 * Usage:
 *   import { buildGraph, queryNameData, findCycles, exportDOT } from 'codegraph';
 */

// Graph building
export { buildGraph, collectFiles, loadPathAliases, resolveImportPath } from './builder.js';
// Co-change analysis
export {
  analyzeCoChanges,
  coChangeData,
  coChangeForFiles,
  coChangeTopData,
  computeCoChanges,
  scanGitHistory,
} from './cochange.js';
// Configuration
export { loadConfig } from './config.js';
// Shared constants
export { EXTENSIONS, IGNORE_DIRS, normalizePath } from './constants.js';
// Circular dependency detection
export { findCycles, formatCycles } from './cycles.js';
// Database utilities
export {
  findDbPath,
  getBuildMeta,
  initSchema,
  openDb,
  openReadonlyOrFail,
  setBuildMeta,
} from './db.js';

// Embeddings
export {
  buildEmbeddings,
  cosineSim,
  DEFAULT_MODEL,
  disposeModel,
  EMBEDDING_STRATEGIES,
  embed,
  estimateTokens,
  MODELS,
  multiSearchData,
  search,
  searchData,
} from './embedder.js';
// Export (DOT/Mermaid/JSON)
export { exportDOT, exportJSON, exportMermaid } from './export.js';
// Logger
export { setVerbose } from './logger.js';
// Native engine
export { isNativeAvailable } from './native.js';

// Unified parser API
export { getActiveEngine, parseFileAuto, parseFilesAuto } from './parser.js';
// Query functions (data-returning)
export {
  ALL_SYMBOL_KINDS,
  contextData,
  diffImpactData,
  diffImpactMermaid,
  explainData,
  FALSE_POSITIVE_CALLER_THRESHOLD,
  FALSE_POSITIVE_NAMES,
  fileDepsData,
  fnDepsData,
  fnImpactData,
  impactAnalysisData,
  moduleMapData,
  queryNameData,
  rolesData,
  statsData,
  VALID_ROLES,
  whereData,
} from './queries.js';
// Registry (multi-repo)
export {
  listRepos,
  loadRegistry,
  pruneRegistry,
  REGISTRY_PATH,
  registerRepo,
  resolveRepoDbPath,
  saveRegistry,
  unregisterRepo,
} from './registry.js';
// Structure analysis
export {
  buildStructure,
  classifyNodeRoles,
  formatHotspots,
  formatModuleBoundaries,
  formatStructure,
  hotspotsData,
  moduleBoundariesData,
  structureData,
} from './structure.js';
// Watch mode
export { watchProject } from './watcher.js';
