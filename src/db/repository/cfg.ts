import type { BetterSqlite3Database, StmtCache } from '../../types.js';
import { cachedStmt } from './cached-stmt.js';

// ─── Statement caches (one prepared statement per db instance) ────────────

interface CfgBlockRow {
  id: number;
  block_index: number;
  block_type: string;
  start_line: number;
  end_line: number;
  label: string | null;
}

interface CfgEdgeRow {
  kind: string;
  source_index: number;
  source_type: string;
  target_index: number;
  target_type: string;
}

const _getCfgBlocksStmt: StmtCache<CfgBlockRow> = new WeakMap();
const _getCfgEdgesStmt: StmtCache<CfgEdgeRow> = new WeakMap();
const _deleteCfgEdgesStmt: StmtCache = new WeakMap();
const _deleteCfgBlocksStmt: StmtCache = new WeakMap();

/**
 * Check whether CFG tables exist.
 */
export function hasCfgTables(db: BetterSqlite3Database): boolean {
  try {
    db.prepare('SELECT 1 FROM cfg_blocks LIMIT 0').get();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get CFG blocks for a function node.
 */
export function getCfgBlocks(db: BetterSqlite3Database, functionNodeId: number): CfgBlockRow[] {
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
 */
export function getCfgEdges(db: BetterSqlite3Database, functionNodeId: number): CfgEdgeRow[] {
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
 */
export function deleteCfgForNode(db: BetterSqlite3Database, functionNodeId: number): void {
  cachedStmt(_deleteCfgEdgesStmt, db, 'DELETE FROM cfg_edges WHERE function_node_id = ?').run(
    functionNodeId,
  );
  cachedStmt(_deleteCfgBlocksStmt, db, 'DELETE FROM cfg_blocks WHERE function_node_id = ?').run(
    functionNodeId,
  );
}
