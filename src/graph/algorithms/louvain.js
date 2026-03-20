/**
 * Community detection via vendored Leiden algorithm.
 * Maintains backward-compatible API: { assignments: Map<string, number>, modularity: number }
 *
 * @param {import('../model.js').CodeGraph} graph
 * @param {{ resolution?: number, maxLevels?: number, maxLocalPasses?: number }} [opts]
 * @returns {{ assignments: Map<string, number>, modularity: number }}
 */
import { detectClusters } from './leiden/index.js';

export function louvainCommunities(graph, opts = {}) {
  if (graph.nodeCount === 0 || graph.edgeCount === 0) {
    return { assignments: new Map(), modularity: 0 };
  }

  const resolution = opts.resolution ?? 1.0;
  const result = detectClusters(graph, {
    resolution,
    randomSeed: 42,
    directed: false,
    ...(opts.maxLevels != null && { maxLevels: opts.maxLevels }),
    ...(opts.maxLocalPasses != null && { maxLocalPasses: opts.maxLocalPasses }),
  });

  const assignments = new Map();
  for (const [id] of graph.nodes()) {
    const cls = result.getClass(id);
    if (cls != null) assignments.set(id, cls);
  }

  return { assignments, modularity: result.quality() };
}
