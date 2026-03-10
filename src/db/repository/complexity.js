/**
 * Get complexity metrics for a node.
 * Used by contextData and explainFunctionImpl in queries.js.
 * @param {object} db
 * @param {number} nodeId
 * @returns {{ cognitive: number, cyclomatic: number, max_nesting: number, maintainability_index: number, halstead_volume: number }|undefined}
 */
export function getComplexityForNode(db, nodeId) {
  return db
    .prepare(
      `SELECT cognitive, cyclomatic, max_nesting, maintainability_index, halstead_volume
       FROM function_complexity WHERE node_id = ?`,
    )
    .get(nodeId);
}
