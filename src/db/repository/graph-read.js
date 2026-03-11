import { cachedStmt } from './cached-stmt.js';

// ─── Statement caches (one prepared statement per db instance) ────────────
const _getCallableNodesStmt = new WeakMap();
const _getCallEdgesStmt = new WeakMap();
const _getFileNodesAllStmt = new WeakMap();
const _getImportEdgesStmt = new WeakMap();

/**
 * Get callable nodes (function/method/class) for community detection.
 * @param {object} db
 * @returns {{ id: number, name: string, kind: string, file: string }[]}
 */
export function getCallableNodes(db) {
  return cachedStmt(
    _getCallableNodesStmt,
    db,
    "SELECT id, name, kind, file FROM nodes WHERE kind IN ('function','method','class')",
  ).all();
}

/**
 * Get all 'calls' edges.
 * @param {object} db
 * @returns {{ source_id: number, target_id: number }[]}
 */
export function getCallEdges(db) {
  return cachedStmt(
    _getCallEdgesStmt,
    db,
    "SELECT source_id, target_id FROM edges WHERE kind = 'calls'",
  ).all();
}

/**
 * Get all file-kind nodes.
 * @param {object} db
 * @returns {{ id: number, name: string, file: string }[]}
 */
export function getFileNodesAll(db) {
  return cachedStmt(
    _getFileNodesAllStmt,
    db,
    "SELECT id, name, file FROM nodes WHERE kind = 'file'",
  ).all();
}

/**
 * Get all import edges.
 * @param {object} db
 * @returns {{ source_id: number, target_id: number }[]}
 */
export function getImportEdges(db) {
  return cachedStmt(
    _getImportEdgesStmt,
    db,
    "SELECT source_id, target_id FROM edges WHERE kind IN ('imports','imports-type')",
  ).all();
}
