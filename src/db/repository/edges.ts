import type {
  AdjacentEdgeRow,
  BetterSqlite3Database,
  ImportEdgeRow,
  IntraFileCallEdge,
  NodeRow,
  RelatedNodeRow,
  StmtCache,
} from '../../types.js';
import { cachedStmt } from './cached-stmt.js';

// ─── Prepared-statement caches (one per db instance) ────────────────────
const _findCalleesStmt: StmtCache<RelatedNodeRow> = new WeakMap();
const _findCallersStmt: StmtCache<RelatedNodeRow> = new WeakMap();
const _findDistinctCallersStmt: StmtCache<RelatedNodeRow> = new WeakMap();
const _findAllOutgoingStmt: StmtCache<AdjacentEdgeRow> = new WeakMap();
const _findAllIncomingStmt: StmtCache<AdjacentEdgeRow> = new WeakMap();
const _findCalleeNamesStmt: StmtCache<{ name: string }> = new WeakMap();
const _findCallerNamesStmt: StmtCache<{ name: string }> = new WeakMap();
const _findImportTargetsStmt: StmtCache<ImportEdgeRow> = new WeakMap();
const _findImportSourcesStmt: StmtCache<ImportEdgeRow> = new WeakMap();
const _findImportDependentsStmt: StmtCache<NodeRow> = new WeakMap();
const _findCrossFileCallTargetsStmt: StmtCache<{ target_id: number }> = new WeakMap();
const _countCrossFileCallersStmt: StmtCache<{ cnt: number }> = new WeakMap();
const _getClassAncestorsStmt: StmtCache<{ id: number; name: string }> = new WeakMap();
const _findIntraFileCallEdgesStmt: StmtCache<IntraFileCallEdge> = new WeakMap();
const _findImplementorsStmt: StmtCache<RelatedNodeRow> = new WeakMap();
const _findInterfacesStmt: StmtCache<RelatedNodeRow> = new WeakMap();

// ─── Call-edge queries ──────────────────────────────────────────────────

/**
 * Find all callees of a node (outgoing 'calls' edges).
 */
export function findCallees(db: BetterSqlite3Database, nodeId: number): RelatedNodeRow[] {
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
 */
export function findCallers(db: BetterSqlite3Database, nodeId: number): RelatedNodeRow[] {
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
 */
export function findDistinctCallers(db: BetterSqlite3Database, nodeId: number): RelatedNodeRow[] {
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
 */
export function findAllOutgoingEdges(db: BetterSqlite3Database, nodeId: number): AdjacentEdgeRow[] {
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
 */
export function findAllIncomingEdges(db: BetterSqlite3Database, nodeId: number): AdjacentEdgeRow[] {
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
 */
export function findCalleeNames(db: BetterSqlite3Database, nodeId: number): string[] {
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
 */
export function findCallerNames(db: BetterSqlite3Database, nodeId: number): string[] {
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
 */
export function findImportTargets(db: BetterSqlite3Database, nodeId: number): ImportEdgeRow[] {
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
 */
export function findImportSources(db: BetterSqlite3Database, nodeId: number): ImportEdgeRow[] {
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
 */
export function findImportDependents(db: BetterSqlite3Database, nodeId: number): NodeRow[] {
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
 */
export function findCrossFileCallTargets(db: BetterSqlite3Database, file: string): Set<number> {
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
 */
export function countCrossFileCallers(
  db: BetterSqlite3Database,
  nodeId: number,
  file: string,
): number {
  return (
    cachedStmt(
      _countCrossFileCallersStmt,
      db,
      `SELECT COUNT(*) AS cnt FROM edges e JOIN nodes n ON e.source_id = n.id
     WHERE e.target_id = ? AND e.kind = 'calls' AND n.file != ?`,
    ).get(nodeId, file)?.cnt ?? 0
  );
}

/**
 * Get all ancestor class IDs via extends edges (BFS).
 */
export function getClassHierarchy(db: BetterSqlite3Database, classNodeId: number): Set<number> {
  const ancestors = new Set<number>();
  const queue = [classNodeId];
  const stmt = cachedStmt(
    _getClassAncestorsStmt,
    db,
    `SELECT n.id, n.name FROM edges e JOIN nodes n ON e.target_id = n.id
     WHERE e.source_id = ? AND e.kind = 'extends'`,
  );
  while (queue.length > 0) {
    const current = queue.shift() as number;
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

// ─── Implements-edge queries ──────────────────────────────────────────

/**
 * Find all concrete types that implement a given interface/trait node.
 */
export function findImplementors(db: BetterSqlite3Database, nodeId: number): RelatedNodeRow[] {
  return cachedStmt(
    _findImplementorsStmt,
    db,
    `SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line
     FROM edges e JOIN nodes n ON e.source_id = n.id
     WHERE e.target_id = ? AND e.kind = 'implements'`,
  ).all(nodeId);
}

/**
 * Find all interfaces/traits that a given class/struct implements.
 */
export function findInterfaces(db: BetterSqlite3Database, nodeId: number): RelatedNodeRow[] {
  return cachedStmt(
    _findInterfacesStmt,
    db,
    `SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line
     FROM edges e JOIN nodes n ON e.target_id = n.id
     WHERE e.source_id = ? AND e.kind = 'implements'`,
  ).all(nodeId);
}

/**
 * Find intra-file call edges (caller → callee within the same file).
 */
export function findIntraFileCallEdges(
  db: BetterSqlite3Database,
  file: string,
): IntraFileCallEdge[] {
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
