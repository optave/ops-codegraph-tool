import { cachedStmt } from './cached-stmt.js';

// ─── Prepared-statement caches (one per db instance) ────────────────────
const _findCalleesStmt = new WeakMap();
const _findCallersStmt = new WeakMap();
const _findDistinctCallersStmt = new WeakMap();
const _findAllOutgoingStmt = new WeakMap();
const _findAllIncomingStmt = new WeakMap();
const _findCalleeNamesStmt = new WeakMap();
const _findCallerNamesStmt = new WeakMap();
const _findImportTargetsStmt = new WeakMap();
const _findImportSourcesStmt = new WeakMap();
const _findImportDependentsStmt = new WeakMap();
const _findCrossFileCallTargetsStmt = new WeakMap();
const _countCrossFileCallersStmt = new WeakMap();
const _getClassAncestorsStmt = new WeakMap();
const _findIntraFileCallEdgesStmt = new WeakMap();

// ─── Call-edge queries ──────────────────────────────────────────────────

/**
 * Find all callees of a node (outgoing 'calls' edges).
 * Returns full node info including end_line for source display.
 * @param {object} db
 * @param {number} nodeId
 * @returns {{ id: number, name: string, kind: string, file: string, line: number, end_line: number|null }[]}
 */
export function findCallees(db, nodeId) {
  return cachedStmt(
    _findCalleesStmt,
    db,
    `SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line, n.end_line
     FROM edges e JOIN nodes n ON e.target_id = n.id
     WHERE e.source_id = ? AND e.kind = 'calls'`,
  ).all(nodeId);
}

/**
 * Find all callers of a node (incoming 'calls' edges).
 * @param {object} db
 * @param {number} nodeId
 * @returns {{ id: number, name: string, kind: string, file: string, line: number }[]}
 */
export function findCallers(db, nodeId) {
  return cachedStmt(
    _findCallersStmt,
    db,
    `SELECT n.id, n.name, n.kind, n.file, n.line
     FROM edges e JOIN nodes n ON e.source_id = n.id
     WHERE e.target_id = ? AND e.kind = 'calls'`,
  ).all(nodeId);
}

/**
 * Find distinct callers of a node (for impact analysis BFS).
 * @param {object} db
 * @param {number} nodeId
 * @returns {{ id: number, name: string, kind: string, file: string, line: number }[]}
 */
export function findDistinctCallers(db, nodeId) {
  return cachedStmt(
    _findDistinctCallersStmt,
    db,
    `SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line
     FROM edges e JOIN nodes n ON e.source_id = n.id
     WHERE e.target_id = ? AND e.kind = 'calls'`,
  ).all(nodeId);
}

// ─── All-edge queries (no kind filter) ─────────────────────────────────

/**
 * Find all outgoing edges with edge kind (for queryNameData).
 * @param {object} db
 * @param {number} nodeId
 * @returns {{ name: string, kind: string, file: string, line: number, edge_kind: string }[]}
 */
export function findAllOutgoingEdges(db, nodeId) {
  return cachedStmt(
    _findAllOutgoingStmt,
    db,
    `SELECT n.name, n.kind, n.file, n.line, e.kind AS edge_kind
     FROM edges e JOIN nodes n ON e.target_id = n.id
     WHERE e.source_id = ?`,
  ).all(nodeId);
}

/**
 * Find all incoming edges with edge kind (for queryNameData).
 * @param {object} db
 * @param {number} nodeId
 * @returns {{ name: string, kind: string, file: string, line: number, edge_kind: string }[]}
 */
export function findAllIncomingEdges(db, nodeId) {
  return cachedStmt(
    _findAllIncomingStmt,
    db,
    `SELECT n.name, n.kind, n.file, n.line, e.kind AS edge_kind
     FROM edges e JOIN nodes n ON e.source_id = n.id
     WHERE e.target_id = ?`,
  ).all(nodeId);
}

// ─── Name-only callee/caller lookups (for embedder) ────────────────────

/**
 * Get distinct callee names for a node, sorted alphabetically.
 * @param {object} db
 * @param {number} nodeId
 * @returns {string[]}
 */
export function findCalleeNames(db, nodeId) {
  return cachedStmt(
    _findCalleeNamesStmt,
    db,
    `SELECT DISTINCT n.name
     FROM edges e JOIN nodes n ON e.target_id = n.id
     WHERE e.source_id = ? AND e.kind = 'calls'
     ORDER BY n.name`,
  )
    .all(nodeId)
    .map((r) => r.name);
}

/**
 * Get distinct caller names for a node, sorted alphabetically.
 * @param {object} db
 * @param {number} nodeId
 * @returns {string[]}
 */
export function findCallerNames(db, nodeId) {
  return cachedStmt(
    _findCallerNamesStmt,
    db,
    `SELECT DISTINCT n.name
     FROM edges e JOIN nodes n ON e.source_id = n.id
     WHERE e.target_id = ? AND e.kind = 'calls'
     ORDER BY n.name`,
  )
    .all(nodeId)
    .map((r) => r.name);
}

// ─── Import-edge queries ───────────────────────────────────────────────

/**
 * Find outgoing import edges (files this node imports).
 * @param {object} db
 * @param {number} nodeId
 * @returns {{ file: string, edge_kind: string }[]}
 */
export function findImportTargets(db, nodeId) {
  return cachedStmt(
    _findImportTargetsStmt,
    db,
    `SELECT n.file, e.kind AS edge_kind
     FROM edges e JOIN nodes n ON e.target_id = n.id
     WHERE e.source_id = ? AND e.kind IN ('imports', 'imports-type')`,
  ).all(nodeId);
}

/**
 * Find incoming import edges (files that import this node).
 * @param {object} db
 * @param {number} nodeId
 * @returns {{ file: string, edge_kind: string }[]}
 */
export function findImportSources(db, nodeId) {
  return cachedStmt(
    _findImportSourcesStmt,
    db,
    `SELECT n.file, e.kind AS edge_kind
     FROM edges e JOIN nodes n ON e.source_id = n.id
     WHERE e.target_id = ? AND e.kind IN ('imports', 'imports-type')`,
  ).all(nodeId);
}

/**
 * Find nodes that import a given node (BFS-ready, returns full node info).
 * Used by impactAnalysisData for transitive import traversal.
 * @param {object} db
 * @param {number} nodeId
 * @returns {object[]}
 */
export function findImportDependents(db, nodeId) {
  return cachedStmt(
    _findImportDependentsStmt,
    db,
    `SELECT n.* FROM edges e JOIN nodes n ON e.source_id = n.id
     WHERE e.target_id = ? AND e.kind IN ('imports', 'imports-type')`,
  ).all(nodeId);
}

// ─── Cross-file and hierarchy queries ──────────────────────────────────

/**
 * Get IDs of symbols in a file that are called from other files.
 * Used for "exported" detection in explain/where/exports.
 * @param {object} db
 * @param {string} file
 * @returns {Set<number>}
 */
export function findCrossFileCallTargets(db, file) {
  return new Set(
    cachedStmt(
      _findCrossFileCallTargetsStmt,
      db,
      `SELECT DISTINCT e.target_id FROM edges e
       JOIN nodes caller ON e.source_id = caller.id
       JOIN nodes target ON e.target_id = target.id
       WHERE target.file = ? AND caller.file != ? AND e.kind = 'calls'`,
    )
      .all(file, file)
      .map((r) => r.target_id),
  );
}

/**
 * Count callers that are in a different file than the target node.
 * Used by whereSymbolImpl to determine if a symbol is exported.
 * @param {object} db
 * @param {number} nodeId
 * @param {string} file - The target node's file
 * @returns {number}
 */
export function countCrossFileCallers(db, nodeId, file) {
  return cachedStmt(
    _countCrossFileCallersStmt,
    db,
    `SELECT COUNT(*) AS cnt FROM edges e JOIN nodes n ON e.source_id = n.id
     WHERE e.target_id = ? AND e.kind = 'calls' AND n.file != ?`,
  ).get(nodeId, file).cnt;
}

/**
 * Get all ancestor class IDs via extends edges (BFS).
 * @param {object} db
 * @param {number} classNodeId
 * @returns {Set<number>}
 */
export function getClassHierarchy(db, classNodeId) {
  const ancestors = new Set();
  const queue = [classNodeId];
  const stmt = cachedStmt(
    _getClassAncestorsStmt,
    db,
    `SELECT n.id, n.name FROM edges e JOIN nodes n ON e.target_id = n.id
     WHERE e.source_id = ? AND e.kind = 'extends'`,
  );
  while (queue.length > 0) {
    const current = queue.shift();
    const parents = stmt.all(current);
    for (const p of parents) {
      if (!ancestors.has(p.id)) {
        ancestors.add(p.id);
        queue.push(p.id);
      }
    }
  }
  return ancestors;
}

/**
 * Find intra-file call edges (caller → callee within the same file).
 * Used by explainFileImpl for data flow visualization.
 * @param {object} db
 * @param {string} file
 * @returns {{ caller_name: string, callee_name: string }[]}
 */
export function findIntraFileCallEdges(db, file) {
  return cachedStmt(
    _findIntraFileCallEdgesStmt,
    db,
    `SELECT caller.name AS caller_name, callee.name AS callee_name
     FROM edges e
     JOIN nodes caller ON e.source_id = caller.id
     JOIN nodes callee ON e.target_id = callee.id
     WHERE caller.file = ? AND callee.file = ? AND e.kind = 'calls'
     ORDER BY caller.line`,
  ).all(file, file);
}
