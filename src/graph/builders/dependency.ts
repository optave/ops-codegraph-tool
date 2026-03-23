/**
 * Build a CodeGraph from the SQLite database.
 * Replaces inline graph construction in cycles.js, communities.js, viewer.js, export.js.
 */

import {
  getCallableNodes,
  getCallEdges,
  getFileNodesAll,
  getImportEdges,
  Repository,
} from '../../db/index.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import type {
  BetterSqlite3Database,
  CallableNodeRow,
  CallEdgeRow,
  FileNodeRow,
  ImportGraphEdgeRow,
} from '../../types.js';
import { CodeGraph } from '../model.js';

export interface DependencyGraphOptions {
  fileLevel?: boolean;
  noTests?: boolean;
  minConfidence?: number;
}

/**
 * Build a dependency graph from an open database or Repository instance.
 * Supports both file-level (import edges) and function-level (call edges) graphs.
 */
export function buildDependencyGraph(
  dbOrRepo: BetterSqlite3Database | Repository,
  opts: DependencyGraphOptions = {},
): CodeGraph {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;

  if (fileLevel) {
    return buildFileLevelGraph(dbOrRepo, noTests);
  }
  return buildFunctionLevelGraph(dbOrRepo, noTests, opts.minConfidence);
}

function buildFileLevelGraph(
  dbOrRepo: BetterSqlite3Database | Repository,
  noTests: boolean,
): CodeGraph {
  const graph = new CodeGraph();
  const isRepo = dbOrRepo instanceof Repository;

  let nodes: FileNodeRow[] = isRepo ? dbOrRepo.getFileNodesAll() : getFileNodesAll(dbOrRepo);
  if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));

  const nodeIds = new Set<number>();
  for (const n of nodes) {
    graph.addNode(String(n.id), { label: n.file, file: n.file, dbId: n.id });
    nodeIds.add(n.id);
  }

  const edges: ImportGraphEdgeRow[] = isRepo ? dbOrRepo.getImportEdges() : getImportEdges(dbOrRepo);
  for (const e of edges) {
    if (!nodeIds.has(e.source_id) || !nodeIds.has(e.target_id)) continue;
    const src = String(e.source_id);
    const tgt = String(e.target_id);
    if (src === tgt) continue;
    if (!graph.hasEdge(src, tgt)) {
      graph.addEdge(src, tgt, { kind: 'imports' });
    }
  }

  return graph;
}

interface MinConfidenceEdgeRow {
  source_id: number;
  target_id: number;
}

function buildFunctionLevelGraph(
  dbOrRepo: BetterSqlite3Database | Repository,
  noTests: boolean,
  minConfidence?: number,
): CodeGraph {
  const graph = new CodeGraph();
  const isRepo = dbOrRepo instanceof Repository;

  let nodes: CallableNodeRow[] = isRepo ? dbOrRepo.getCallableNodes() : getCallableNodes(dbOrRepo);
  if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));

  const nodeIds = new Set<number>();
  for (const n of nodes) {
    graph.addNode(String(n.id), {
      label: n.name,
      file: n.file,
      kind: n.kind,
      dbId: n.id,
    });
    nodeIds.add(n.id);
  }

  let edges: CallEdgeRow[] | MinConfidenceEdgeRow[];
  if (minConfidence != null) {
    if (isRepo) {
      // Trade-off: Repository.getCallEdges() returns all call edges, so we
      // filter in JS. This is O(all call edges) rather than the SQL path's
      // indexed WHERE clause. Acceptable for current data sizes; a dedicated
      // getCallEdgesByMinConfidence(threshold) method on the Repository
      // interface would be the proper fix if this becomes a bottleneck.
      edges = dbOrRepo
        .getCallEdges()
        .filter((e) => e.confidence != null && e.confidence >= minConfidence);
    } else {
      edges = (dbOrRepo as BetterSqlite3Database)
        .prepare<MinConfidenceEdgeRow>(
          "SELECT source_id, target_id FROM edges WHERE kind = 'calls' AND confidence >= ?",
        )
        .all(minConfidence);
    }
  } else {
    edges = isRepo ? dbOrRepo.getCallEdges() : getCallEdges(dbOrRepo);
  }

  for (const e of edges) {
    if (!nodeIds.has(e.source_id) || !nodeIds.has(e.target_id)) continue;
    const src = String(e.source_id);
    const tgt = String(e.target_id);
    if (src === tgt) continue;
    if (!graph.hasEdge(src, tgt)) {
      graph.addEdge(src, tgt, { kind: 'calls' });
    }
  }

  return graph;
}
