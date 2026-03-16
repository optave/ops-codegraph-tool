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
import { CodeGraph } from '../model.js';

/**
 * @param {object} dbOrRepo - Open better-sqlite3 database (readonly) or a Repository instance
 * @param {object} [opts]
 * @param {boolean} [opts.fileLevel=true] - File-level (imports) or function-level (calls)
 * @param {boolean} [opts.noTests=false] - Exclude test files
 * @param {number}  [opts.minConfidence] - Minimum edge confidence (function-level only)
 * @returns {CodeGraph}
 */
export function buildDependencyGraph(dbOrRepo, opts = {}) {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;

  if (fileLevel) {
    return buildFileLevelGraph(dbOrRepo, noTests);
  }
  return buildFunctionLevelGraph(dbOrRepo, noTests, opts.minConfidence);
}

function buildFileLevelGraph(dbOrRepo, noTests) {
  const graph = new CodeGraph();
  const isRepo = dbOrRepo instanceof Repository;

  let nodes = isRepo ? dbOrRepo.getFileNodesAll() : getFileNodesAll(dbOrRepo);
  if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));

  const nodeIds = new Set();
  for (const n of nodes) {
    graph.addNode(String(n.id), { label: n.file, file: n.file, dbId: n.id });
    nodeIds.add(n.id);
  }

  const edges = isRepo ? dbOrRepo.getImportEdges() : getImportEdges(dbOrRepo);
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

function buildFunctionLevelGraph(dbOrRepo, noTests, minConfidence) {
  const graph = new CodeGraph();
  const isRepo = dbOrRepo instanceof Repository;

  let nodes = isRepo ? dbOrRepo.getCallableNodes() : getCallableNodes(dbOrRepo);
  if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));

  const nodeIds = new Set();
  for (const n of nodes) {
    graph.addNode(String(n.id), {
      label: n.name,
      file: n.file,
      kind: n.kind,
      dbId: n.id,
    });
    nodeIds.add(n.id);
  }

  let edges;
  if (minConfidence != null) {
    if (isRepo) {
      // minConfidence filtering not supported by Repository — fall back to getCallEdges
      edges = dbOrRepo.getCallEdges();
    } else {
      edges = dbOrRepo
        .prepare("SELECT source_id, target_id FROM edges WHERE kind = 'calls' AND confidence >= ?")
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
