/**
 * codegraph — Programmatic API
 *
 * Usage:
 *   import { buildGraph, queryNameData, findCycles, exportDOT } from 'codegraph';
 */

// AST node queries
export { AST_NODE_KINDS, astQuery, astQueryData } from './ast.js';
// Audit (composite report)
export { audit, auditData } from './audit.js';
// Batch querying
export {
  BATCH_COMMANDS,
  batch,
  batchData,
  batchQuery,
  multiBatchData,
  splitTargets,
} from './batch.js';
// Architecture boundary rules
export { evaluateBoundaries, PRESETS, validateBoundaryConfig } from './boundaries.js';
// Branch comparison
export { branchCompareData, branchCompareMermaid } from './branch-compare.js';
// Graph building
export { buildGraph, collectFiles, loadPathAliases, resolveImportPath } from './builder.js';
// Control flow graph (intraprocedural)
export {
  buildCFGData,
  buildFunctionCFG,
  CFG_RULES,
  cfg,
  cfgData,
  cfgToDOT,
  cfgToMermaid,
} from './cfg.js';
// Check (CI validation predicates)
export { check, checkData } from './check.js';
// Co-change analysis
export {
  analyzeCoChanges,
  coChangeData,
  coChangeForFiles,
  coChangeTopData,
  computeCoChanges,
  scanGitHistory,
} from './cochange.js';
// Community detection
export { communities, communitiesData, communitySummaryForStats } from './communities.js';
// Complexity metrics
export {
  COMPLEXITY_RULES,
  complexity,
  complexityData,
  computeFunctionComplexity,
  computeHalsteadMetrics,
  computeLOCMetrics,
  computeMaintainabilityIndex,
  findFunctionNode,
  HALSTEAD_RULES,
  iterComplexity,
} from './complexity.js';
// Configuration
export { loadConfig } from './config.js';
// Shared constants
export { EXTENSIONS, IGNORE_DIRS, normalizePath } from './constants.js';
// Circular dependency detection
export { findCycles, formatCycles } from './cycles.js';
// Dataflow analysis
export {
  buildDataflowEdges,
  dataflow,
  dataflowData,
  dataflowImpactData,
  dataflowPathData,
  extractDataflow,
} from './dataflow.js';
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
  ftsSearchData,
  hybridSearchData,
  MODELS,
  multiSearchData,
  search,
  searchData,
} from './embedder.js';
// Export (DOT/Mermaid/JSON)
export { exportDOT, exportJSON, exportMermaid } from './export.js';
// Execution flow tracing
export { entryPointType, flowData, listEntryPointsData } from './flow.js';
// Logger
export { setVerbose } from './logger.js';
// Manifesto rule engine
export { manifesto, manifestoData, RULE_DEFS } from './manifesto.js';
// Native engine
export { isNativeAvailable } from './native.js';
// Ownership (CODEOWNERS)
export { matchOwners, owners, ownersData, ownersForFiles, parseCodeowners } from './owners.js';
// Pagination utilities
export { MCP_DEFAULTS, MCP_MAX_LIMIT, paginate, paginateResult, printNdjson } from './paginate.js';

// Unified parser API
export { getActiveEngine, parseFileAuto, parseFilesAuto } from './parser.js';
// Query functions (data-returning)
export {
  ALL_SYMBOL_KINDS,
  CORE_EDGE_KINDS,
  CORE_SYMBOL_KINDS,
  childrenData,
  contextData,
  diffImpactData,
  diffImpactMermaid,
  EVERY_EDGE_KIND,
  EVERY_SYMBOL_KIND,
  EXTENDED_SYMBOL_KINDS,
  explainData,
  exportsData,
  FALSE_POSITIVE_CALLER_THRESHOLD,
  FALSE_POSITIVE_NAMES,
  fileDepsData,
  fileExports,
  fnDepsData,
  fnImpactData,
  impactAnalysisData,
  iterListFunctions,
  iterRoles,
  iterWhere,
  kindIcon,
  moduleMapData,
  normalizeSymbol,
  pathData,
  queryNameData,
  rolesData,
  STRUCTURAL_EDGE_KINDS,
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
// Snapshot management
export {
  snapshotDelete,
  snapshotList,
  snapshotRestore,
  snapshotSave,
  snapshotsDir,
  validateSnapshotName,
} from './snapshot.js';
// Structure analysis
export {
  buildStructure,
  classifyNodeRoles,
  FRAMEWORK_ENTRY_PREFIXES,
  formatHotspots,
  formatModuleBoundaries,
  formatStructure,
  hotspotsData,
  moduleBoundariesData,
  structureData,
} from './structure.js';
// Triage — composite risk audit
export { triage, triageData } from './triage.js';
// Watch mode
export { watchProject } from './watcher.js';
