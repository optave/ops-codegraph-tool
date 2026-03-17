/**
 * queries.js — Barrel re-export file.
 *
 * All query logic lives in the sub-modules under src/analysis/ and src/shared/.
 * This file exists purely for backward compatibility so that all existing
 * importers continue to work without changes.
 */

// ── Re-export from dedicated module for backward compat ───────────────────
export { isTestFile, TEST_PATTERN } from '../infrastructure/test-filter.js';
export { iterListFunctions, iterRoles, iterWhere } from '../shared/generators.js';
// ── Kind/edge constants (canonical source: kinds.js) ─────────────────────
export {
  ALL_SYMBOL_KINDS,
  CORE_EDGE_KINDS,
  CORE_SYMBOL_KINDS,
  EVERY_EDGE_KIND,
  EVERY_SYMBOL_KIND,
  EXTENDED_SYMBOL_KINDS,
  STRUCTURAL_EDGE_KINDS,
  VALID_ROLES,
} from '../shared/kinds.js';
// ── Shared utilities ─────────────────────────────────────────────────────
export { kindIcon, normalizeSymbol } from '../shared/normalize.js';
export { briefData } from './analysis/brief.js';
export { contextData, explainData } from './analysis/context.js';
export { fileDepsData, fnDepsData, pathData } from './analysis/dependencies.js';
export { exportsData } from './analysis/exports.js';
export {
  diffImpactData,
  diffImpactMermaid,
  fnImpactData,
  impactAnalysisData,
} from './analysis/impact.js';
export {
  FALSE_POSITIVE_CALLER_THRESHOLD,
  FALSE_POSITIVE_NAMES,
  moduleMapData,
  statsData,
} from './analysis/module-map.js';
export { rolesData } from './analysis/roles.js';
// ── Analysis modules ─────────────────────────────────────────────────────
export {
  childrenData,
  findMatchingNodes,
  listFunctionsData,
  queryNameData,
  whereData,
} from './analysis/symbol-lookup.js';
