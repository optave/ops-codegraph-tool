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

// ── Query Data Functions ────────────────────────────────────────────────
export { astQueryData } from './ast.js';
export { auditData } from './audit.js';
export { batchData } from './batch.js';
export { branchCompareData } from './branch-compare.js';
// ── Graph Building & Search ─────────────────────────────────────────────
export { buildGraph } from './builder.js';
export { cfgData } from './cfg.js';
export { checkData } from './check.js';
export { coChangeData } from './cochange.js';
export { communitiesData } from './communities.js';
export { complexityData } from './complexity.js';
export { loadConfig } from './config.js';
// ── Constants ───────────────────────────────────────────────────────────
export { EXTENSIONS, IGNORE_DIRS } from './constants.js';
export { findCycles } from './cycles.js';
export { dataflowData } from './dataflow.js';
export { buildEmbeddings, hybridSearchData, multiSearchData, searchData } from './embedder.js';
// ── Export Formats ──────────────────────────────────────────────────────
export { exportDOT, exportJSON, exportMermaid } from './export.js';
export { flowData, listEntryPointsData } from './flow.js';
export { EVERY_EDGE_KIND, EVERY_SYMBOL_KIND } from './kinds.js';
export { manifestoData } from './manifesto.js';
export { ownersData } from './owners.js';
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
} from './queries.js';
export { sequenceData } from './sequence.js';
export { hotspotsData, moduleBoundariesData, structureData } from './structure.js';
export { triageData } from './triage.js';
