/**
 * codegraph — Programmatic API
 *
 * Usage:
 *   import { buildGraph, queryNameData, findCycles, exportDOT } from 'codegraph';
 */

// AST node queries
export { AST_NODE_KINDS, astQuery, astQueryData } from './ast.js';
// Audit (composite report)
export { auditData } from './audit.js';
// Batch querying
export {
  BATCH_COMMANDS,
  batchData,
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
  cfgData,
  cfgToDOT,
  cfgToMermaid,
} from './cfg.js';
// Check (CI validation predicates)
export { checkData } from './check.js';
// Co-change analysis
export {
  analyzeCoChanges,
  coChangeData,
  coChangeForFiles,
  coChangeTopData,
  computeCoChanges,
  scanGitHistory,
} from './cochange.js';
export { audit } from './commands/audit.js';
export { batch, batchQuery } from './commands/batch.js';
export { cfg } from './commands/cfg.js';
export { check } from './commands/check.js';
export { communities } from './commands/communities.js';
export { complexity } from './commands/complexity.js';
export { dataflow } from './commands/dataflow.js';
export { manifesto } from './commands/manifesto.js';
export { owners } from './commands/owners.js';
export { sequence } from './commands/sequence.js';
export { formatHotspots, formatModuleBoundaries, formatStructure } from './commands/structure.js';
export { triage } from './commands/triage.js';
// Community detection
export { communitiesData, communitySummaryForStats } from './communities.js';
// Complexity metrics
export {
  COMPLEXITY_RULES,
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
  dataflowData,
  dataflowImpactData,
  dataflowPathData,
  extractDataflow,
} from './dataflow.js';
// Database utilities
export {
  countEdges,
  countFiles,
  countNodes,
  fanInJoinSQL,
  fanOutJoinSQL,
  findDbPath,
  findNodesForTriage,
  findNodesWithFanIn,
  getBuildMeta,
  initSchema,
  iterateFunctionNodes,
  kindInClause,
  listFunctionNodes,
  NodeQuery,
  openDb,
  openReadonlyOrFail,
  setBuildMeta,
  testFilterSQL,
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
// Export (DOT/Mermaid/JSON/GraphML/GraphSON/Neo4j CSV)
export {
  exportDOT,
  exportGraphML,
  exportGraphSON,
  exportJSON,
  exportMermaid,
  exportNeo4jCSV,
} from './export.js';
// Execution flow tracing
export { entryPointType, flowData, listEntryPointsData } from './flow.js';
// Result formatting
export { outputResult } from './infrastructure/result-formatter.js';
// Test file detection
export { isTestFile, TEST_PATTERN } from './infrastructure/test-filter.js';
// Logger
export { setVerbose } from './logger.js';
// Manifesto rule engine
export { manifestoData, RULE_DEFS } from './manifesto.js';
// Native engine
export { isNativeAvailable } from './native.js';
// Ownership (CODEOWNERS)
export { matchOwners, ownersData, ownersForFiles, parseCodeowners } from './owners.js';
// Pagination utilities
export { MCP_DEFAULTS, MCP_MAX_LIMIT, paginate, paginateResult, printNdjson } from './paginate.js';
// Unified parser API
export { getActiveEngine, isWasmAvailable, parseFileAuto, parseFilesAuto } from './parser.js';
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
// Query CLI display wrappers
export {
  children,
  context,
  diffImpact,
  explain,
  fileDeps,
  fileExports,
  fnDeps,
  fnImpact,
  impactAnalysis,
  moduleMap,
  queryName,
  roles,
  stats,
  symbolPath,
  where,
} from './queries-cli.js';
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
// Sequence diagram generation
export { sequenceData, sequenceToMermaid } from './sequence.js';
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
  hotspotsData,
  moduleBoundariesData,
  structureData,
} from './structure.js';
// Triage — composite risk audit
export { triageData } from './triage.js';
// Interactive HTML viewer
export { generatePlotHTML, loadPlotConfig } from './viewer.js';
// Watch mode
export { watchProject } from './watcher.js';
