import { cachedStmt } from './cached-stmt.js';

// ─── Statement caches (one prepared statement per db instance) ────────────
const _getComplexityForNodeStmt = new WeakMap();

/**
 * Get complexity metrics for a node.
 * Used by contextData and explainFunctionImpl in queries.js.
 * @param {object} db
 * @param {number} nodeId
 * @returns {{ cognitive: number, cyclomatic: number, max_nesting: number, maintainability_index: number, halstead_volume: number }|undefined}
 */
export function getComplexityForNode(db, nodeId) {
  return cachedStmt(
    _getComplexityForNodeStmt,
    db,
    `SELECT cognitive, cyclomatic, max_nesting, maintainability_index, halstead_volume
     FROM function_complexity WHERE node_id = ?`,
  ).get(nodeId);
}
