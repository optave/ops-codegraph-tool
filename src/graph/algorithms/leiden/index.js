/**
 * Leiden community detection — vendored from ngraph.leiden (MIT).
 * Adapted to work directly with CodeGraph (no external graph library dependency).
 *
 * Original: https://github.com/anvaka/ngraph.leiden
 * License:  MIT — see LICENSE in this directory.
 */

import { qualityCPM, qualityCPMSizeAware } from './cpm.js';
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
 * @returns {{ getClass(id): number, getCommunities(): Map, quality(): number, toJSON(): object }}
 */
export function detectClusters(graph, options = {}) {
  const {
    graph: finalGraph,
    partition,
    levels,
    originalToCurrent,
    originalNodeIds,
  } = runLouvainUndirectedModularity(graph, options);

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
      const q = (options.quality || 'modularity').toLowerCase();
      if (q === 'cpm') {
        const gamma =
          typeof options.resolution === 'number' ? options.resolution : 1.0;
        if ((options.cpmMode || 'unit') === 'size-aware')
          return qualityCPMSizeAware(partition, finalGraph, gamma);
        return qualityCPM(partition, finalGraph, gamma);
      }
      const gamma =
          typeof options.resolution === 'number' ? options.resolution : 1.0;
      return qualityModularity(partition, finalGraph, gamma);
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
