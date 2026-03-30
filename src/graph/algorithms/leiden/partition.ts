/**
 * Mutable community assignment with per-community aggregates.
 * Vendored from ngraph.leiden (MIT) — no external dependencies.
 *
 * Maintains per-community totals and per-move scratch accumulators so we can
 * compute modularity/CPM gains in O(neighborhood) time without rescanning the
 * whole graph after each move.
 */

import type { GraphAdapter } from './adapter.js';

export interface CompactOptions {
  keepOldOrder?: boolean;
  preserveMap?: Map<number, number>;
}

export interface Partition {
  n: number;
  readonly communityCount: number;
  nodeCommunity: Int32Array;
  readonly communityTotalSize: Float64Array;
  readonly communityNodeCount: Int32Array;
  readonly communityInternalEdgeWeight: Float64Array;
  readonly communityTotalStrength: Float64Array;
  readonly communityTotalOutStrength: Float64Array;
  readonly communityTotalInStrength: Float64Array;
  resizeCommunities(newCount: number): void;
  initializeAggregates(): void;
  accumulateNeighborCommunityEdgeWeights(v: number): number;
  getCandidateCommunityCount(): number;
  getCandidateCommunityAt(i: number): number;
  getNeighborEdgeWeightToCommunity(c: number): number;
  getOutEdgeWeightToCommunity(c: number): number;
  getInEdgeWeightFromCommunity(c: number): number;
  deltaModularityUndirected(v: number, newC: number, gamma?: number): number;
  deltaModularityDirected(v: number, newC: number, gamma?: number): number;
  deltaCPM(v: number, newC: number, gamma?: number): number;
  moveNodeToCommunity(v: number, newC: number): boolean;
  compactCommunityIds(opts?: CompactOptions): void;
  getCommunityMembers(): number[][];
  getCommunityTotalSize(c: number): number;
  getCommunityNodeCount(c: number): number;
  /** Attached by optimiser after creation — undefined until set. */
  graph?: GraphAdapter;
}

// Typed arrays always return a number for in-bounds access, but noUncheckedIndexedAccess
// widens to `number | undefined`. These helpers keep the compound assignment patterns readable.
function fget(a: Float64Array, i: number): number {
  return a[i] as number;
}
function iget(a: Int32Array, i: number): number {
  return a[i] as number;
}
function u8get(a: Uint8Array, i: number): number {
  return a[i] as number;
}

/**
 * Accumulate per-community node-level totals (size, count, strength) into the
 * provided aggregate arrays. Both `initializeAggregates` and `compactCommunityIds`
 * share this logic — extracting it eliminates the duplication.
 */
function accumulateNodeAggregates(
  graph: GraphAdapter,
  nodeCommunity: Int32Array,
  n: number,
  totalSize: Float64Array,
  nodeCount: Int32Array,
  internalEdgeWeight: Float64Array,
  totalStrength: Float64Array,
  totalOutStrength: Float64Array,
  totalInStrength: Float64Array,
): void {
  for (let i = 0; i < n; i++) {
    const c: number = iget(nodeCommunity, i);
    totalSize[c] = fget(totalSize, c) + fget(graph.size, i);
    nodeCount[c] = iget(nodeCount, c) + 1;
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
 * intra-community non-self edges. For undirected, counts each edge once (j > i).
 */
function accumulateInternalEdgeWeights(
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

/**
 * Sort community IDs according to the compaction options: preserve original
 * order, respect a user-provided label map, or sort by descending size.
 * Returns the sorted list of non-empty community IDs.
 */
function buildSortedCommunityIds(
  ids: number[],
  opts: CompactOptions,
  communityTotalSize: Float64Array,
  communityNodeCount: Int32Array,
): void {
  if (opts.keepOldOrder) {
    ids.sort((a, b) => a - b);
  } else if (opts.preserveMap instanceof Map) {
    const preserveMap = opts.preserveMap;
    ids.sort((a, b) => {
      const pa = preserveMap.get(a);
      const pb = preserveMap.get(b);
      if (pa != null && pb != null && pa !== pb) return pa - pb;
      if (pa != null && pb == null) return -1;
      if (pb != null && pa == null) return 1;
      return (
        fget(communityTotalSize, b) - fget(communityTotalSize, a) ||
        iget(communityNodeCount, b) - iget(communityNodeCount, a) ||
        a - b
      );
    });
  } else {
    ids.sort(
      (a, b) =>
        fget(communityTotalSize, b) - fget(communityTotalSize, a) ||
        iget(communityNodeCount, b) - iget(communityNodeCount, a) ||
        a - b,
    );
  }
}

export function makePartition(graph: GraphAdapter): Partition {
  const n: number = graph.n;
  const nodeCommunity = new Int32Array(n);
  for (let i = 0; i < n; i++) nodeCommunity[i] = i;
  let communityCount: number = n;

  let communityTotalSize = new Float64Array(communityCount);
  let communityNodeCount = new Int32Array(communityCount);
  let communityInternalEdgeWeight = new Float64Array(communityCount);
  let communityTotalStrength = new Float64Array(communityCount);
  let communityTotalOutStrength = new Float64Array(communityCount);
  let communityTotalInStrength = new Float64Array(communityCount);

  const candidateCommunities = new Int32Array(n);
  let candidateCommunityCount: number = 0;
  const neighborEdgeWeightToCommunity = new Float64Array(n);
  const outEdgeWeightToCommunity = new Float64Array(n);
  const inEdgeWeightFromCommunity = new Float64Array(n);
  const isCandidateCommunity = new Uint8Array(n);

  function ensureCommCapacity(newCount: number): void {
    if (newCount <= communityTotalSize.length) return;
    const growTo: number = Math.max(newCount, Math.ceil(communityTotalSize.length * 1.5));
    communityTotalSize = growFloat(communityTotalSize, growTo);
    communityNodeCount = growInt(communityNodeCount, growTo);
    communityInternalEdgeWeight = growFloat(communityInternalEdgeWeight, growTo);
    communityTotalStrength = growFloat(communityTotalStrength, growTo);
    communityTotalOutStrength = growFloat(communityTotalOutStrength, growTo);
    communityTotalInStrength = growFloat(communityTotalInStrength, growTo);
  }

  function initializeAggregates(): void {
    communityTotalSize.fill(0);
    communityNodeCount.fill(0);
    communityInternalEdgeWeight.fill(0);
    communityTotalStrength.fill(0);
    communityTotalOutStrength.fill(0);
    communityTotalInStrength.fill(0);
    accumulateNodeAggregates(
      graph,
      nodeCommunity,
      n,
      communityTotalSize,
      communityNodeCount,
      communityInternalEdgeWeight,
      communityTotalStrength,
      communityTotalOutStrength,
      communityTotalInStrength,
    );
    accumulateInternalEdgeWeights(graph, nodeCommunity, n, communityInternalEdgeWeight);
  }

  function resetScratch(): void {
    for (let i = 0; i < candidateCommunityCount; i++) {
      const c: number = iget(candidateCommunities, i);
      isCandidateCommunity[c] = 0;
      neighborEdgeWeightToCommunity[c] = 0;
      outEdgeWeightToCommunity[c] = 0;
      inEdgeWeightFromCommunity[c] = 0;
    }
    candidateCommunityCount = 0;
  }

  function touch(c: number): void {
    if (u8get(isCandidateCommunity, c)) return;
    isCandidateCommunity[c] = 1;
    candidateCommunities[candidateCommunityCount++] = c;
  }

  function accumulateNeighborCommunityEdgeWeights(v: number): number {
    resetScratch();
    const ci: number = iget(nodeCommunity, v);
    touch(ci);
    if (graph.directed) {
      const outL = graph.outEdges[v]!;
      for (let k = 0; k < outL.length; k++) {
        const j: number = outL[k]!.to;
        const w: number = outL[k]!.w;
        const cj: number = iget(nodeCommunity, j);
        touch(cj);
        outEdgeWeightToCommunity[cj] = fget(outEdgeWeightToCommunity, cj) + w;
      }
      const inL = graph.inEdges[v]!;
      for (let k = 0; k < inL.length; k++) {
        const i2: number = inL[k]!.from;
        const w: number = inL[k]!.w;
        const ci2: number = iget(nodeCommunity, i2);
        touch(ci2);
        inEdgeWeightFromCommunity[ci2] = fget(inEdgeWeightFromCommunity, ci2) + w;
      }
    } else {
      const list = graph.outEdges[v]!;
      for (let k = 0; k < list.length; k++) {
        const j: number = list[k]!.to;
        const w: number = list[k]!.w;
        const cj: number = iget(nodeCommunity, j);
        touch(cj);
        neighborEdgeWeightToCommunity[cj] = fget(neighborEdgeWeightToCommunity, cj) + w;
      }
    }
    return candidateCommunityCount;
  }

  const twoMUndirected: number = graph.totalWeight;
  function deltaModularityUndirected(v: number, newC: number, gamma: number = 1.0): number {
    const oldC: number = iget(nodeCommunity, v);
    if (newC === oldC) return 0;
    const strengthV: number = fget(graph.strengthOut, v);
    const weightToNew: number =
      newC < neighborEdgeWeightToCommunity.length
        ? fget(neighborEdgeWeightToCommunity, newC) || 0
        : 0;
    const weightToOld: number = fget(neighborEdgeWeightToCommunity, oldC) || 0;
    const totalStrengthNew: number =
      newC < communityTotalStrength.length ? fget(communityTotalStrength, newC) : 0;
    const totalStrengthOld: number = fget(communityTotalStrength, oldC);
    const gain_remove: number = -(
      weightToOld / twoMUndirected -
      (gamma * (strengthV * totalStrengthOld)) / (twoMUndirected * twoMUndirected)
    );
    const gain_add: number =
      weightToNew / twoMUndirected -
      (gamma * (strengthV * totalStrengthNew)) / (twoMUndirected * twoMUndirected);
    return gain_remove + gain_add;
  }

  function deltaModularityDirected(v: number, newC: number, gamma: number = 1.0): number {
    const oldC: number = iget(nodeCommunity, v);
    if (newC === oldC) return 0;
    const totalEdgeWeight: number = graph.totalWeight;
    const strengthOutV: number = fget(graph.strengthOut, v);
    const strengthInV: number = fget(graph.strengthIn, v);
    const inFromNew: number =
      newC < inEdgeWeightFromCommunity.length ? fget(inEdgeWeightFromCommunity, newC) || 0 : 0;
    const outToNew: number =
      newC < outEdgeWeightToCommunity.length ? fget(outEdgeWeightToCommunity, newC) || 0 : 0;
    const inFromOld: number = fget(inEdgeWeightFromCommunity, oldC) || 0;
    const outToOld: number = fget(outEdgeWeightToCommunity, oldC) || 0;
    const totalInStrengthNew: number =
      newC < communityTotalInStrength.length ? fget(communityTotalInStrength, newC) : 0;
    const totalOutStrengthNew: number =
      newC < communityTotalOutStrength.length ? fget(communityTotalOutStrength, newC) : 0;
    const totalInStrengthOld: number = fget(communityTotalInStrength, oldC);
    const totalOutStrengthOld: number = fget(communityTotalOutStrength, oldC);
    // Self-loop correction + constant term (see modularity.ts diffModularityDirected)
    const selfW: number = fget(graph.selfLoop, v) || 0;
    const deltaInternal: number =
      (inFromNew + outToNew - inFromOld - outToOld + 2 * selfW) / totalEdgeWeight;
    const deltaExpected: number =
      (gamma *
        (strengthOutV * (totalInStrengthNew - totalInStrengthOld) +
          strengthInV * (totalOutStrengthNew - totalOutStrengthOld) +
          2 * strengthOutV * strengthInV)) /
      (totalEdgeWeight * totalEdgeWeight);
    return deltaInternal - deltaExpected;
  }

  function deltaCPM(v: number, newC: number, gamma: number = 1.0): number {
    const oldC: number = iget(nodeCommunity, v);
    if (newC === oldC) return 0;
    let w_old: number;
    let w_new: number;
    let selfCorrection: number = 0;
    if (graph.directed) {
      w_old =
        (fget(outEdgeWeightToCommunity, oldC) || 0) + (fget(inEdgeWeightFromCommunity, oldC) || 0);
      w_new =
        newC < outEdgeWeightToCommunity.length
          ? (fget(outEdgeWeightToCommunity, newC) || 0) +
            (fget(inEdgeWeightFromCommunity, newC) || 0)
          : 0;
      // Self-loop correction (see cpm.ts diffCPM)
      selfCorrection = 2 * (fget(graph.selfLoop, v) || 0);
    } else {
      w_old = fget(neighborEdgeWeightToCommunity, oldC) || 0;
      w_new =
        newC < neighborEdgeWeightToCommunity.length
          ? fget(neighborEdgeWeightToCommunity, newC) || 0
          : 0;
    }
    const nodeSz: number = fget(graph.size, v) || 1;
    const sizeOld: number = fget(communityTotalSize, oldC) || 0;
    const sizeNew: number = newC < communityTotalSize.length ? fget(communityTotalSize, newC) : 0;
    return w_new - w_old + selfCorrection - gamma * nodeSz * (sizeNew - sizeOld + nodeSz);
  }

  function moveNodeToCommunity(v: number, newC: number): boolean {
    const oldC: number = iget(nodeCommunity, v);
    if (oldC === newC) return false;
    if (newC >= communityCount) {
      ensureCommCapacity(newC + 1);
      communityCount = newC + 1;
    }
    const strengthOutV: number = fget(graph.strengthOut, v);
    const strengthInV: number = fget(graph.strengthIn, v);
    const selfLoopWeight: number = fget(graph.selfLoop, v);
    const nodeSz: number = fget(graph.size, v);

    communityNodeCount[oldC] = iget(communityNodeCount, oldC) - 1;
    communityNodeCount[newC] = iget(communityNodeCount, newC) + 1;
    communityTotalSize[oldC] = fget(communityTotalSize, oldC) - nodeSz;
    communityTotalSize[newC] = fget(communityTotalSize, newC) + nodeSz;
    if (graph.directed) {
      communityTotalOutStrength[oldC] = fget(communityTotalOutStrength, oldC) - strengthOutV;
      communityTotalOutStrength[newC] = fget(communityTotalOutStrength, newC) + strengthOutV;
      communityTotalInStrength[oldC] = fget(communityTotalInStrength, oldC) - strengthInV;
      communityTotalInStrength[newC] = fget(communityTotalInStrength, newC) + strengthInV;
    } else {
      communityTotalStrength[oldC] = fget(communityTotalStrength, oldC) - strengthOutV;
      communityTotalStrength[newC] = fget(communityTotalStrength, newC) + strengthOutV;
    }

    if (graph.directed) {
      const outToOld: number = fget(outEdgeWeightToCommunity, oldC) || 0;
      const inFromOld: number = fget(inEdgeWeightFromCommunity, oldC) || 0;
      const outToNew: number =
        newC < outEdgeWeightToCommunity.length ? fget(outEdgeWeightToCommunity, newC) || 0 : 0;
      const inFromNew: number =
        newC < inEdgeWeightFromCommunity.length ? fget(inEdgeWeightFromCommunity, newC) || 0 : 0;
      // outToOld/inFromOld already include the self-loop weight (self-loops are
      // in outEdges/inEdges), so subtract it once to avoid triple-counting.
      communityInternalEdgeWeight[oldC] =
        fget(communityInternalEdgeWeight, oldC) - (outToOld + inFromOld - selfLoopWeight);
      communityInternalEdgeWeight[newC] =
        fget(communityInternalEdgeWeight, newC) + (outToNew + inFromNew + selfLoopWeight);
    } else {
      const weightToOld: number = fget(neighborEdgeWeightToCommunity, oldC) || 0;
      const weightToNew: number = fget(neighborEdgeWeightToCommunity, newC) || 0;
      communityInternalEdgeWeight[oldC] =
        fget(communityInternalEdgeWeight, oldC) - (2 * weightToOld + selfLoopWeight);
      communityInternalEdgeWeight[newC] =
        fget(communityInternalEdgeWeight, newC) + (2 * weightToNew + selfLoopWeight);
    }

    nodeCommunity[v] = newC;
    return true;
  }

  function compactCommunityIds(opts: CompactOptions = {}): void {
    const ids: number[] = [];
    for (let c = 0; c < communityCount; c++) if (iget(communityNodeCount, c) > 0) ids.push(c);
    buildSortedCommunityIds(ids, opts, communityTotalSize, communityNodeCount);

    const newId = new Int32Array(communityCount).fill(-1);
    ids.forEach((c, i) => {
      newId[c] = i;
    });
    for (let i = 0; i < nodeCommunity.length; i++)
      nodeCommunity[i] = iget(newId, iget(nodeCommunity, i));

    const remappedCount: number = ids.length;
    const newTotalSize = new Float64Array(remappedCount);
    const newNodeCount = new Int32Array(remappedCount);
    const newInternalEdgeWeight = new Float64Array(remappedCount);
    const newTotalStrength = new Float64Array(remappedCount);
    const newTotalOutStrength = new Float64Array(remappedCount);
    const newTotalInStrength = new Float64Array(remappedCount);
    accumulateNodeAggregates(
      graph,
      nodeCommunity,
      n,
      newTotalSize,
      newNodeCount,
      newInternalEdgeWeight,
      newTotalStrength,
      newTotalOutStrength,
      newTotalInStrength,
    );
    accumulateInternalEdgeWeights(graph, nodeCommunity, n, newInternalEdgeWeight);

    communityCount = remappedCount;
    communityTotalSize = newTotalSize;
    communityNodeCount = newNodeCount;
    communityInternalEdgeWeight = newInternalEdgeWeight;
    communityTotalStrength = newTotalStrength;
    communityTotalOutStrength = newTotalOutStrength;
    communityTotalInStrength = newTotalInStrength;
  }

  function getCommunityMembers(): number[][] {
    const comms: number[][] = new Array(communityCount);
    for (let i = 0; i < communityCount; i++) comms[i] = [];
    for (let i = 0; i < n; i++) comms[iget(nodeCommunity, i)]!.push(i);
    return comms;
  }

  function getCommunityTotalSizeFn(c: number): number {
    return c < communityTotalSize.length ? fget(communityTotalSize, c) : 0;
  }
  function getCommunityNodeCountFn(c: number): number {
    return c < communityNodeCount.length ? iget(communityNodeCount, c) : 0;
  }

  return {
    n,
    get communityCount() {
      return communityCount;
    },
    nodeCommunity,
    get communityTotalSize() {
      return communityTotalSize;
    },
    get communityNodeCount() {
      return communityNodeCount;
    },
    get communityInternalEdgeWeight() {
      return communityInternalEdgeWeight;
    },
    get communityTotalStrength() {
      return communityTotalStrength;
    },
    get communityTotalOutStrength() {
      return communityTotalOutStrength;
    },
    get communityTotalInStrength() {
      return communityTotalInStrength;
    },
    resizeCommunities(newCount: number): void {
      ensureCommCapacity(newCount);
      communityCount = newCount;
    },
    initializeAggregates,
    accumulateNeighborCommunityEdgeWeights,
    getCandidateCommunityCount: (): number => candidateCommunityCount,
    getCandidateCommunityAt: (i: number): number => iget(candidateCommunities, i),
    getNeighborEdgeWeightToCommunity: (c: number): number =>
      fget(neighborEdgeWeightToCommunity, c) || 0,
    getOutEdgeWeightToCommunity: (c: number): number => fget(outEdgeWeightToCommunity, c) || 0,
    getInEdgeWeightFromCommunity: (c: number): number => fget(inEdgeWeightFromCommunity, c) || 0,
    deltaModularityUndirected,
    deltaModularityDirected,
    deltaCPM,
    moveNodeToCommunity,
    compactCommunityIds,
    getCommunityMembers,
    getCommunityTotalSize: getCommunityTotalSizeFn,
    getCommunityNodeCount: getCommunityNodeCountFn,
    graph: undefined,
  };
}

function growFloat(a: Float64Array, to: number): Float64Array<ArrayBuffer> {
  const b = new Float64Array(to);
  for (let i = 0; i < a.length; i++) b[i] = a[i] as number;
  return b;
}
function growInt(a: Int32Array, to: number): Int32Array<ArrayBuffer> {
  const b = new Int32Array(to);
  for (let i = 0; i < a.length; i++) b[i] = a[i] as number;
  return b;
}
