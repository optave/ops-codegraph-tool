/**
 * Louvain community detection via graphology.
 *
 * @param {import('../model.js').CodeGraph} graph
 * @param {{ resolution?: number }} [opts]
 * @returns {{ assignments: Map<string, number>, modularity: number }}
 */
import graphologyLouvain from 'graphology-communities-louvain';

export function louvainCommunities(graph, opts = {}) {
  const gy = graph.toGraphology({ type: 'undirected' });

  if (gy.order === 0 || gy.size === 0) {
    return { assignments: new Map(), modularity: 0 };
  }

  const resolution = opts.resolution ?? 1.0;
  const details = graphologyLouvain.detailed(gy, { resolution });

  const assignments = new Map();
  for (const [nodeId, communityId] of Object.entries(details.communities)) {
    assignments.set(nodeId, communityId);
  }

  return { assignments, modularity: details.modularity };
}
