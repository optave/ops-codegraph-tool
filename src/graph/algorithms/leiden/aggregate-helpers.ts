/**
 * Per-community aggregate accumulation shared by partition.ts (live
 * optimisation state, mutated move-by-move) and index.ts (one-shot
 * evaluation on the original graph for quality()). Both need to reduce the
 * graph's per-node size/strength/self-loop values down to one row per
 * community using identical directed/undirected branching — extracting
 * this once prevents the two copies from silently drifting apart on a
 * future edit to only one of them.
 */

import type { GraphAdapter } from './adapter.js';
import { fget, iget } from './typed-array-helpers.js';

/**
 * Accumulate per-community node-level totals (size, strength, self-loop
 * weight) into the provided aggregate arrays.
 *
 * `nodeCount` is optional: partition.ts's live optimisation state tracks
 * per-community node counts (used by compactCommunityIds's size/count sort
 * tie-break), while index.ts's read-only quality evaluation does not need
 * it and omits the argument.
 */
export function accumulateNodeAggregates(
  graph: GraphAdapter,
  nodeCommunity: Int32Array,
  n: number,
  totalSize: Float64Array,
  internalEdgeWeight: Float64Array,
  totalStrength: Float64Array,
  totalOutStrength: Float64Array,
  totalInStrength: Float64Array,
  nodeCount?: Int32Array,
): void {
  for (let i = 0; i < n; i++) {
    const c: number = iget(nodeCommunity, i);
    totalSize[c] = fget(totalSize, c) + fget(graph.size, i);
    if (nodeCount) nodeCount[c] = iget(nodeCount, c) + 1;
    if (graph.directed) {
      totalOutStrength[c] = fget(totalOutStrength, c) + fget(graph.strengthOut, i);
      totalInStrength[c] = fget(totalInStrength, c) + fget(graph.strengthIn, i);
    } else {
      totalStrength[c] = fget(totalStrength, c) + fget(graph.strengthOut, i);
    }
    if (fget(graph.selfLoop, i) !== 0)
      internalEdgeWeight[c] = fget(internalEdgeWeight, c) + fget(graph.selfLoop, i);
  }
}

/**
 * Accumulate intra-community edge weights. For directed graphs, counts all
 * intra-community non-self edges. For undirected, counts each edge once
 * (j > i) to avoid double-counting.
 */
export function accumulateInternalEdgeWeights(
  graph: GraphAdapter,
  nodeCommunity: Int32Array,
  n: number,
  internalEdgeWeight: Float64Array,
): void {
  if (graph.directed) {
    for (let i = 0; i < n; i++) {
      const ci: number = iget(nodeCommunity, i);
      const neighbors = graph.outEdges[i]!;
      for (let k = 0; k < neighbors.length; k++) {
        const { to: j, w } = neighbors[k]!;
        if (i === j) continue; // self-loop already counted via graph.selfLoop[i]
        if (ci === iget(nodeCommunity, j))
          internalEdgeWeight[ci] = fget(internalEdgeWeight, ci) + w;
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      const ci: number = iget(nodeCommunity, i);
      const neighbors = graph.outEdges[i]!;
      for (let k = 0; k < neighbors.length; k++) {
        const { to: j, w } = neighbors[k]!;
        if (j <= i) continue;
        if (ci === iget(nodeCommunity, j))
          internalEdgeWeight[ci] = fget(internalEdgeWeight, ci) + w;
      }
    }
  }
}
