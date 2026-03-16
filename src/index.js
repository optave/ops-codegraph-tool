/**
 * codegraph — Programmatic API
 *
 * Curated public surface: *Data() query functions, graph building,
 * export formats, and essential constants. CLI formatters and internal
 * utilities are not exported — import them directly if needed.
 *
 * Usage:
 *   import { buildGraph, queryNameData, findCycles, exportDOT } from '@optave/codegraph';
 */

export { loadConfig } from './infrastructure/config.js';
export { EXTENSIONS, IGNORE_DIRS } from './shared/constants.js';
export { buildGraph } from './domain/graph/builder.js';
export { findCycles } from './domain/graph/cycles.js';
export {
  childrenData,
  contextData,
  diffImpactData,
  explainData,
  exportsData,
  fileDepsData,
  fnDepsData,
  fnImpactData,
  impactAnalysisData,
  moduleMapData,
  pathData,
  queryNameData,
  rolesData,
  statsData,
  whereData,
} from './domain/queries.js';
export {
  buildEmbeddings,
  hybridSearchData,
  multiSearchData,
  searchData,
} from './domain/search/index.js';
export {
  AnalysisError,
  BoundaryError,
  CodegraphError,
  ConfigError,
  DbError,
  EngineError,
  ParseError,
  ResolutionError,
} from './shared/errors.js';
export { astQueryData } from './features/ast.js';
export { auditData } from './features/audit.js';
export { batchData } from './features/batch.js';
export { branchCompareData } from './features/branch-compare.js';
export { cfgData } from './features/cfg.js';
export { checkData } from './features/check.js';
export { coChangeData } from './features/cochange.js';
export { communitiesData } from './features/communities.js';
export { complexityData } from './features/complexity.js';
export { dataflowData } from './features/dataflow.js';
export { exportDOT, exportJSON, exportMermaid } from './features/export.js';
export { flowData, listEntryPointsData } from './features/flow.js';
export { manifestoData } from './features/manifesto.js';
export { ownersData } from './features/owners.js';
export { sequenceData } from './features/sequence.js';
export { hotspotsData, moduleBoundariesData, structureData } from './features/structure.js';
export { triageData } from './features/triage.js';
export { EVERY_EDGE_KIND, EVERY_SYMBOL_KIND } from './shared/kinds.js';
