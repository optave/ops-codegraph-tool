/**
 * Community detection via native Rust Louvain or vendored Leiden algorithm.
 * Maintains backward-compatible API: { assignments: Map<string, number>, modularity: number }
 *
 * Native path: classic Louvain (Rust, undirected modularity optimization).
 * JS fallback: Leiden algorithm via `detectClusters` (always undirected, `directed: false`).
 */
import { loadNative } from '../../infrastructure/native.js';
import type { CodeGraph } from '../model.js';
import type { DetectClustersResult } from './leiden/index.js';
import { detectClusters } from './leiden/index.js';

export interface LouvainOptions {
  resolution?: number;
  maxLevels?: number;
  maxLocalPasses?: number;
  refinementTheta?: number;
}

export interface LouvainResult {
  assignments: Map<string, number>;
  modularity: number;
}

export function louvainCommunities(graph: CodeGraph, opts: LouvainOptions = {}): LouvainResult {
  if (graph.nodeCount === 0 || graph.edgeCount === 0) {
    return { assignments: new Map(), modularity: 0 };
  }

  const resolution: number = opts.resolution ?? 1.0;

  const native = loadNative();
  if (native?.louvainCommunities) {
    const edges = graph.toEdgeArray();
    const nodeIds = graph.nodeIds();
    const result = native.louvainCommunities(edges, nodeIds, resolution, 42);
    const assignments = new Map<string, number>();
    for (const entry of result.assignments) {
      assignments.set(entry.node, entry.community);
    }
    return { assignments, modularity: result.modularity };
  }

  return louvainJS(graph, opts, resolution);
}

/** JS fallback using the vendored Leiden algorithm. */
function louvainJS(graph: CodeGraph, opts: LouvainOptions, resolution: number): LouvainResult {
  const result: DetectClustersResult = detectClusters(graph, {
    resolution,
    randomSeed: 42,
    directed: false,
    ...(opts.maxLevels != null && { maxLevels: opts.maxLevels }),
    ...(opts.maxLocalPasses != null && { maxLocalPasses: opts.maxLocalPasses }),
    ...(opts.refinementTheta != null && { refinementTheta: opts.refinementTheta }),
  });

  const assignments = new Map<string, number>();
  for (const [id] of graph.nodes()) {
    const cls = result.getClass(id);
    if (cls != null) assignments.set(id, cls);
  }

  return { assignments, modularity: result.quality() };
}
