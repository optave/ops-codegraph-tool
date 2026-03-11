/**
 * Re-export all query CLI wrappers from queries-cli.js.
 * This barrel file provides the standard src/commands/ import path.
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
  moduleMap,
  queryName,
  roles,
  stats,
  symbolPath,
  where,
} from '../queries-cli.js';
