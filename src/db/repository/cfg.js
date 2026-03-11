// ─── Statement caches (one prepared statement per db instance) ────────────
// WeakMap keys on the db object so statements are GC'd when the db closes.
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
  let stmt = _getCfgBlocksStmt.get(db);
  if (!stmt) {
    stmt = db.prepare(
      `SELECT id, block_index, block_type, start_line, end_line, label
       FROM cfg_blocks WHERE function_node_id = ?
       ORDER BY block_index`,
    );
    _getCfgBlocksStmt.set(db, stmt);
  }
  return stmt.all(functionNodeId);
}

/**
 * Get CFG edges for a function node (with block info).
 * @param {object} db
 * @param {number} functionNodeId
 * @returns {object[]}
 */
export function getCfgEdges(db, functionNodeId) {
  let stmt = _getCfgEdgesStmt.get(db);
  if (!stmt) {
    stmt = db.prepare(
      `SELECT e.kind,
              sb.block_index AS source_index, sb.block_type AS source_type,
              tb.block_index AS target_index, tb.block_type AS target_type
       FROM cfg_edges e
       JOIN cfg_blocks sb ON e.source_block_id = sb.id
       JOIN cfg_blocks tb ON e.target_block_id = tb.id
       WHERE e.function_node_id = ?
       ORDER BY sb.block_index, tb.block_index`,
    );
    _getCfgEdgesStmt.set(db, stmt);
  }
  return stmt.all(functionNodeId);
}

/**
 * Delete all CFG data for a function node.
 * @param {object} db
 * @param {number} functionNodeId
 */
export function deleteCfgForNode(db, functionNodeId) {
  let delEdges = _deleteCfgEdgesStmt.get(db);
  if (!delEdges) {
    delEdges = db.prepare('DELETE FROM cfg_edges WHERE function_node_id = ?');
    _deleteCfgEdgesStmt.set(db, delEdges);
  }
  let delBlocks = _deleteCfgBlocksStmt.get(db);
  if (!delBlocks) {
    delBlocks = db.prepare('DELETE FROM cfg_blocks WHERE function_node_id = ?');
    _deleteCfgBlocksStmt.set(db, delBlocks);
  }
  delEdges.run(functionNodeId);
  delBlocks.run(functionNodeId);
}
