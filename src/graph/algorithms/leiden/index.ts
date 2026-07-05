/**
 * Leiden community detection — vendored from ngraph.leiden (MIT).
 * Adapted to work directly with CodeGraph (no external graph library dependency).
 *
 * Original: https://github.com/anvaka/ngraph.leiden
 * License:  MIT — see LICENSE in this directory.
 */

import type { CodeGraph } from '../../model.js';
import type { GraphAdapter } from './adapter.js';
import { accumulateInternalEdgeWeights, accumulateNodeAggregates } from './aggregate-helpers.js';
import { qualityCPM } from './cpm.js';
import { qualityModularity } from './modularity.js';
import type { LeidenOptions } from './optimiser.js';
import { runLouvainUndirectedModularity } from './optimiser.js';
import { iget } from './typed-array-helpers.js';

export type { LeidenOptions } from './optimiser.js';

export type DetectClustersOptions = LeidenOptions;

export interface DetectClustersResult {
  getClass(nodeId: string | number): number | undefined;
  getCommunities(): Map<number, string[]>;
  quality(): number;
  toJSON(): {
    membership: Record<string, number>;
    meta: { levels: number; quality: number; options: DetectClustersOptions };
  };
}

/**
 * Detect communities in a CodeGraph using the Leiden algorithm.
 *
 * Note on `quality()`: For modularity, `quality()` always evaluates at gamma=1.0
 * (standard Newman-Girvan modularity) regardless of the `resolution` used during
 * optimization. This makes quality values comparable across runs with different
 * resolutions. For CPM, `quality()` uses the caller-specified resolution since gamma
 * is intrinsic to the CPM metric. Do not use modularity `quality()` values to
 * compare partitions found at different resolutions — they reflect Q at gamma=1.0,
 * not the objective that was actually optimized.
 */
export function detectClusters(
  graph: CodeGraph,
  options: DetectClustersOptions = {},
): DetectClustersResult {
  const { levels, originalToCurrent, originalNodeIds, baseGraph } = runLouvainUndirectedModularity(
    graph,
    options,
  );

  const idToClass = new Map<string, number>();
  for (let i = 0; i < originalNodeIds.length; i++) {
    const comm: number = iget(originalToCurrent, i);
    idToClass.set(originalNodeIds[i]!, comm);
  }

  return {
    getClass(nodeId: string | number): number | undefined {
      return idToClass.get(String(nodeId));
    },
    getCommunities(): Map<number, string[]> {
      const out = new Map<number, string[]>();
      for (const [id, c] of idToClass) {
        if (!out.has(c)) out.set(c, []);
        out.get(c)!.push(id);
      }
      return out;
    },
    quality(): number {
      // Compute quality on the original (level-0) graph with the final
      // partition mapped back. Computing on the last coarse-level graph
      // produces inflated values because the modularity null model depends
      // on the degree distribution, which changes after coarsening.
      const part = buildOriginalPartition(baseGraph, originalToCurrent);
      const q: string = (options.quality || 'modularity').toLowerCase();
      if (q === 'cpm') {
        const gamma: number = typeof options.resolution === 'number' ? options.resolution : 1.0;
        return qualityCPM(part, baseGraph, gamma);
      }
      // Always evaluate at gamma=1.0 for standard Newman-Girvan modularity
      return qualityModularity(part, baseGraph, 1.0);
    },
    toJSON() {
      const membershipObj: Record<string, number> = {};
      for (const [id, c] of idToClass) membershipObj[id] = c;
      return {
        membership: membershipObj,
        meta: { levels: levels.length, quality: this.quality(), options },
      };
    },
  };
}

/**
 * Minimal partition-like object built from the original graph and the
 * final community mapping, suitable for qualityModularity / qualityCPM.
 *
 * Implements the subset of PartitionView needed by the quality functions
 * (no scratch-space methods needed since this is read-only evaluation).
 */
interface OriginalPartition {
  communityCount: number;
  nodeCommunity: Int32Array;
  communityInternalEdgeWeight: Float64Array;
  communityTotalStrength: Float64Array;
  communityTotalOutStrength: Float64Array;
  communityTotalInStrength: Float64Array;
  communityTotalSize: Float64Array;
  // Stub methods required by PartitionView but not called by qualityModularity/qualityCPM
  getNeighborEdgeWeightToCommunity(c: number): number;
  getOutEdgeWeightToCommunity(c: number): number;
  getInEdgeWeightFromCommunity(c: number): number;
}

function buildOriginalPartition(g: GraphAdapter, communityMap: Int32Array): OriginalPartition {
  const n: number = g.n;
  let maxC: number = 0;
  for (let i = 0; i < n; i++) {
    const ci = iget(communityMap, i);
    if (ci > maxC) maxC = ci;
  }
  const cc: number = maxC + 1;

  const nodeCommunity = communityMap;
  const internalWeight = new Float64Array(cc);
  const totalStr = new Float64Array(cc);
  const totalOutStr = new Float64Array(cc);
  const totalInStr = new Float64Array(cc);
  const totalSize = new Float64Array(cc);

  accumulateNodeAggregates(
    g,
    communityMap,
    n,
    totalSize,
    internalWeight,
    totalStr,
    totalOutStr,
    totalInStr,
  );
  accumulateInternalEdgeWeights(g, communityMap, n, internalWeight);

  return {
    communityCount: cc,
    nodeCommunity,
    communityInternalEdgeWeight: internalWeight,
    communityTotalStrength: totalStr,
    communityTotalOutStrength: totalOutStr,
    communityTotalInStrength: totalInStr,
    communityTotalSize: totalSize,
    // Stubs — quality functions only read the aggregate arrays, not these methods
    getNeighborEdgeWeightToCommunity: () => 0,
    getOutEdgeWeightToCommunity: () => 0,
    getInEdgeWeightFromCommunity: () => 0,
  };
}
