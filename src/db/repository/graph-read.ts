import { CORE_SYMBOL_KINDS } from '../../shared/kinds.js';
import type {
  BetterSqlite3Database,
  CallableNodeRow,
  CallEdgeRow,
  FileNodeRow,
  ImportGraphEdgeRow,
  StmtCache,
} from '../../types.js';
import { cachedStmt } from './cached-stmt.js';

// ─── Statement caches (one prepared statement per db instance) ────────────
const _getCallableNodesStmt: StmtCache<CallableNodeRow> = new WeakMap();
const _getCallEdgesStmt: StmtCache<CallEdgeRow> = new WeakMap();
const _getFileNodesAllStmt: StmtCache<FileNodeRow> = new WeakMap();
const _getImportEdgesStmt: StmtCache<ImportGraphEdgeRow> = new WeakMap();

const CALLABLE_KINDS_SQL = CORE_SYMBOL_KINDS.map((k: string) => `'${k}'`).join(',');

/**
 * Get callable nodes (all core symbol kinds) for graph construction.
 */
export function getCallableNodes(db: BetterSqlite3Database): CallableNodeRow[] {
  return cachedStmt(
    _getCallableNodesStmt,
    db,
    `SELECT id, name, kind, file FROM nodes WHERE kind IN (${CALLABLE_KINDS_SQL})`,
  ).all();
}

/**
 * Get all 'calls' edges.
 */
export function getCallEdges(db: BetterSqlite3Database): CallEdgeRow[] {
  return cachedStmt(
    _getCallEdgesStmt,
    db,
    "SELECT source_id, target_id, confidence FROM edges WHERE kind = 'calls'",
  ).all();
}

/**
 * Get all file-kind nodes.
 */
export function getFileNodesAll(db: BetterSqlite3Database): FileNodeRow[] {
  return cachedStmt(
    _getFileNodesAllStmt,
    db,
    "SELECT id, name, file FROM nodes WHERE kind = 'file'",
  ).all();
}

/**
 * Get all import edges.
 */
export function getImportEdges(db: BetterSqlite3Database): ImportGraphEdgeRow[] {
  return cachedStmt(
    _getImportEdgesStmt,
    db,
    "SELECT source_id, target_id FROM edges WHERE kind IN ('imports','imports-type')",
  ).all();
}
