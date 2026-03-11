import { cachedStmt } from './cached-stmt.js';

// ─── Statement caches (one prepared statement per db instance) ────────────
const _getCfgBlocksStmt = new WeakMap();
const _getCfgEdgesStmt = new WeakMap();
const _deleteCfgEdgesStmt = new WeakMap();
const _deleteCfgBlocksStmt = new WeakMap();

/**
 * Check whether CFG tables exist.
 * @param {object} db
 * @returns {boolean}
 */
export function hasCfgTables(db) {
  try {
    db.prepare('SELECT 1 FROM cfg_blocks LIMIT 0').get();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get CFG blocks for a function node.
 * @param {object} db
 * @param {number} functionNodeId
 * @returns {object[]}
 */
export function getCfgBlocks(db, functionNodeId) {
  return cachedStmt(
    _getCfgBlocksStmt,
    db,
    `SELECT id, block_index, block_type, start_line, end_line, label
     FROM cfg_blocks WHERE function_node_id = ?
     ORDER BY block_index`,
  ).all(functionNodeId);
}

/**
 * Get CFG edges for a function node (with block info).
 * @param {object} db
 * @param {number} functionNodeId
 * @returns {object[]}
 */
export function getCfgEdges(db, functionNodeId) {
  return cachedStmt(
    _getCfgEdgesStmt,
    db,
    `SELECT e.kind,
            sb.block_index AS source_index, sb.block_type AS source_type,
            tb.block_index AS target_index, tb.block_type AS target_type
     FROM cfg_edges e
     JOIN cfg_blocks sb ON e.source_block_id = sb.id
     JOIN cfg_blocks tb ON e.target_block_id = tb.id
     WHERE e.function_node_id = ?
     ORDER BY sb.block_index, tb.block_index`,
  ).all(functionNodeId);
}

/**
 * Delete all CFG data for a function node.
 * @param {object} db
 * @param {number} functionNodeId
 */
export function deleteCfgForNode(db, functionNodeId) {
  cachedStmt(_deleteCfgEdgesStmt, db, 'DELETE FROM cfg_edges WHERE function_node_id = ?').run(
    functionNodeId,
  );
  cachedStmt(_deleteCfgBlocksStmt, db, 'DELETE FROM cfg_blocks WHERE function_node_id = ?').run(
    functionNodeId,
  );
}
