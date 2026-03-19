/**
 * queries-cli.js — barrel re-export for backward compatibility.
 *
 * The actual implementations live in queries-cli/ split by concern:
 *   path.js     — symbolPath
 *   overview.js — stats, moduleMap, roles
 *   inspect.js  — where, queryName, context, children, explain, implementations, interfaces
 *   impact.js   — fileDeps, fnDeps, impactAnalysis, fnImpact, diffImpact
 *   exports.js  — fileExports
 */
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
  implementations,
  interfaces,
  moduleMap,
  queryName,
  roles,
  stats,
  symbolPath,
  where,
} from './queries-cli/index.js';
