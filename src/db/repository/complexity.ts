import type { BetterSqlite3Database, ComplexityMetrics, StmtCache } from '../../types.js';
import { cachedStmt } from './cached-stmt.js';

// ─── Statement caches (one prepared statement per db instance) ────────────
const _getComplexityForNodeStmt: StmtCache<ComplexityMetrics> = new WeakMap();

/**
 * Get complexity metrics for a node.
 * Used by contextData and explainFunctionImpl in queries.js.
 */
export function getComplexityForNode(
  db: BetterSqlite3Database,
  nodeId: number,
): ComplexityMetrics | undefined {
  return cachedStmt(
    _getComplexityForNodeStmt,
    db,
    `SELECT cognitive, cyclomatic, max_nesting, maintainability_index, halstead_volume
     FROM function_complexity WHERE node_id = ?`,
  ).get(nodeId);
}
