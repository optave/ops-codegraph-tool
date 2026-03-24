/**
 * Community detection via vendored Leiden algorithm.
 * Maintains backward-compatible API: { assignments: Map<string, number>, modularity: number }
 *
 * Note: Always runs in undirected mode (`directed: false`) regardless of
 * the input graph's directedness. For direction-aware community detection,
 * use `detectClusters` from `./leiden/index.js` directly.
 */
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
