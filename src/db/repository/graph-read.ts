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
 *
 * `ORDER BY id` — without an explicit order, SQLite's row order for a bare
 * WHERE scan is unspecified. Consumers (e.g. community detection's graph
 * builder) rely on a stable iteration order for run-to-run determinism, so
 * sort explicitly rather than depending on incidental physical/insertion
 * order (#1734). Mirrors `get_callable_nodes` in the native `graph_read.rs`.
 */
export function getCallableNodes(db: BetterSqlite3Database): CallableNodeRow[] {
  return cachedStmt(
    _getCallableNodesStmt,
    db,
    `SELECT id, name, kind, file FROM nodes WHERE kind IN (${CALLABLE_KINDS_SQL}) ORDER BY id`,
  ).all();
}

/**
 * Get all 'calls' edges. Ordered for determinism — see `getCallableNodes`.
 */
export function getCallEdges(db: BetterSqlite3Database): CallEdgeRow[] {
  return cachedStmt(
    _getCallEdgesStmt,
    db,
    "SELECT source_id, target_id, confidence FROM edges WHERE kind = 'calls' ORDER BY source_id, target_id",
  ).all();
}

/**
 * Get all file-kind nodes. Ordered for determinism — see `getCallableNodes`.
 */
export function getFileNodesAll(db: BetterSqlite3Database): FileNodeRow[] {
  return cachedStmt(
    _getFileNodesAllStmt,
    db,
    "SELECT id, name, file FROM nodes WHERE kind = 'file' ORDER BY id",
  ).all();
}

/**
 * Get all import edges. Ordered for determinism — see `getCallableNodes`.
 */
export function getImportEdges(db: BetterSqlite3Database): ImportGraphEdgeRow[] {
  return cachedStmt(
    _getImportEdgesStmt,
    db,
    "SELECT source_id, target_id FROM edges WHERE kind IN ('imports','imports-type') ORDER BY source_id, target_id",
  ).all();
}
