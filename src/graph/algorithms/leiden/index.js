/**
 * Leiden community detection — vendored from ngraph.leiden (MIT).
 * Adapted to work directly with CodeGraph (no external graph library dependency).
 *
 * Original: https://github.com/anvaka/ngraph.leiden
 * License:  MIT — see LICENSE in this directory.
 */

import { qualityCPM } from './cpm.js';
import { qualityModularity } from './modularity.js';
import { runLouvainUndirectedModularity } from './optimiser.js';

/**
 * Detect communities in a CodeGraph using the Leiden algorithm.
 *
 * @param {import('../../model.js').CodeGraph} graph
 * @param {object} [options]
 * @param {number}  [options.randomSeed=42]
 * @param {boolean} [options.directed=false]
 * @param {boolean} [options.refine=true]         - Leiden refinement (set false for plain Louvain)
 * @param {string}  [options.quality='modularity'] - 'modularity' | 'cpm'
 * @param {number}  [options.resolution=1.0]
 * @param {number}  [options.maxCommunitySize]
 * @param {Set|Array} [options.fixedNodes]
 * @param {string}  [options.candidateStrategy]    - 'neighbors' | 'all' | 'random' | 'random-neighbor'
 * @param {number}  [options.refinementTheta=1.0]  - Temperature for probabilistic Leiden refinement (Algorithm 3, Traag et al. 2019). Lower → more greedy, higher → more exploratory. Deterministic via seeded PRNG
 * @returns {{ getClass(id): number, getCommunities(): Map, quality(): number, toJSON(): object }}
 *
 * **Note on `quality()`:** For modularity, `quality()` always evaluates at γ=1.0
 * (standard Newman-Girvan modularity) regardless of the `resolution` used during
 * optimization. This makes quality values comparable across runs with different
 * resolutions. For CPM, `quality()` uses the caller-specified resolution since γ
 * is intrinsic to the CPM metric. Do not use modularity `quality()` values to
 * compare partitions found at different resolutions — they reflect Q at γ=1.0,
 * not the objective that was actually optimized.
 */
export function detectClusters(graph, options = {}) {
  const { levels, originalToCurrent, originalNodeIds, baseGraph } = runLouvainUndirectedModularity(
    graph,
    options,
  );

  const idToClass = new Map();
  for (let i = 0; i < originalNodeIds.length; i++) {
    const comm = originalToCurrent[i];
    idToClass.set(originalNodeIds[i], comm);
  }

  return {
    getClass(nodeId) {
      return idToClass.get(String(nodeId));
    },
    getCommunities() {
      const out = new Map();
      for (const [id, c] of idToClass) {
        if (!out.has(c)) out.set(c, []);
        out.get(c).push(id);
      }
      return out;
    },
    quality() {
      // Compute quality on the original (level-0) graph with the final
      // partition mapped back.  Computing on the last coarse-level graph
      // produces inflated values because the modularity null model depends
      // on the degree distribution, which changes after coarsening.
      const part = buildOriginalPartition(baseGraph, originalToCurrent);
      const q = (options.quality || 'modularity').toLowerCase();
      if (q === 'cpm') {
        const gamma = typeof options.resolution === 'number' ? options.resolution : 1.0;
        return qualityCPM(part, baseGraph, gamma);
      }
      // Always evaluate at gamma=1.0 for standard Newman-Girvan modularity
      return qualityModularity(part, baseGraph, 1.0);
    },
    toJSON() {
      const membershipObj = {};
      for (const [id, c] of idToClass) membershipObj[id] = c;
      return {
        membership: membershipObj,
        meta: { levels: levels.length, quality: this.quality(), options },
      };
    },
  };
}

/**
 * Build a minimal partition-like object from the original graph and the
 * final community mapping, suitable for qualityModularity / qualityCPM.
 */
function buildOriginalPartition(g, communityMap) {
  const n = g.n;
  let maxC = 0;
  for (let i = 0; i < n; i++) if (communityMap[i] > maxC) maxC = communityMap[i];
  const cc = maxC + 1;

  const internalWeight = new Float64Array(cc);
  const totalStr = new Float64Array(cc);
  const totalOutStr = new Float64Array(cc);
  const totalInStr = new Float64Array(cc);
  const totalSize = new Float64Array(cc);

  for (let i = 0; i < n; i++) {
    const c = communityMap[i];
    totalSize[c] += g.size[i];
    if (g.directed) {
      totalOutStr[c] += g.strengthOut[i];
      totalInStr[c] += g.strengthIn[i];
    } else {
      totalStr[c] += g.strengthOut[i];
    }
    if (g.selfLoop[i]) internalWeight[c] += g.selfLoop[i];
  }

  if (g.directed) {
    for (let i = 0; i < n; i++) {
      const ci = communityMap[i];
      const list = g.outEdges[i];
      for (let k = 0; k < list.length; k++) {
        const { to: j, w } = list[k];
        if (i === j) continue;
        if (ci === communityMap[j]) internalWeight[ci] += w;
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      const ci = communityMap[i];
      const list = g.outEdges[i];
      for (let k = 0; k < list.length; k++) {
        const { to: j, w } = list[k];
        if (j <= i) continue;
        if (ci === communityMap[j]) internalWeight[ci] += w;
      }
    }
  }

  return {
    communityCount: cc,
    communityInternalEdgeWeight: internalWeight,
    communityTotalStrength: totalStr,
    communityTotalOutStrength: totalOutStr,
    communityTotalInStrength: totalInStr,
    communityTotalSize: totalSize,
  };
}
