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

/* ------------------------------------------------------------------ */
/*  Internal mutable state bucket shared by all extracted functions    */
/* ------------------------------------------------------------------ */

interface PartitionState {
  graph: GraphAdapter;
  n: number;
  nodeCommunity: Int32Array;
  communityCount: number;
  communityTotalSize: Float64Array;
  communityNodeCount: Int32Array;
  communityInternalEdgeWeight: Float64Array;
  communityTotalStrength: Float64Array;
  communityTotalOutStrength: Float64Array;
  communityTotalInStrength: Float64Array;
  /* scratch arrays for neighbor accumulation */
  candidateCommunities: Int32Array;
  candidateCommunityCount: number;
  neighborEdgeWeightToCommunity: Float64Array;
  outEdgeWeightToCommunity: Float64Array;
  inEdgeWeightFromCommunity: Float64Array;
  isCandidateCommunity: Uint8Array;
}

/* ------------------------------------------------------------------ */
/*  Aggregate helpers (shared by initializeAggregates & compact)      */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Extracted: capacity management                                     */
/* ------------------------------------------------------------------ */

function ensureCommCapacity(s: PartitionState, newCount: number): void {
  if (newCount <= s.communityTotalSize.length) return;
  const growTo: number = Math.max(newCount, Math.ceil(s.communityTotalSize.length * 1.5));
  s.communityTotalSize = growFloat(s.communityTotalSize, growTo);
  s.communityNodeCount = growInt(s.communityNodeCount, growTo);
  s.communityInternalEdgeWeight = growFloat(s.communityInternalEdgeWeight, growTo);
  s.communityTotalStrength = growFloat(s.communityTotalStrength, growTo);
  s.communityTotalOutStrength = growFloat(s.communityTotalOutStrength, growTo);
  s.communityTotalInStrength = growFloat(s.communityTotalInStrength, growTo);
}

/* ------------------------------------------------------------------ */
/*  Extracted: aggregate initialization                                */
/* ------------------------------------------------------------------ */

function initAggregates(s: PartitionState): void {
  s.communityTotalSize.fill(0);
  s.communityNodeCount.fill(0);
  s.communityInternalEdgeWeight.fill(0);
  s.communityTotalStrength.fill(0);
  s.communityTotalOutStrength.fill(0);
  s.communityTotalInStrength.fill(0);
  accumulateNodeAggregates(
    s.graph,
    s.nodeCommunity,
    s.n,
    s.communityTotalSize,
    s.communityNodeCount,
    s.communityInternalEdgeWeight,
    s.communityTotalStrength,
    s.communityTotalOutStrength,
    s.communityTotalInStrength,
  );
  accumulateInternalEdgeWeights(s.graph, s.nodeCommunity, s.n, s.communityInternalEdgeWeight);
}

/* ------------------------------------------------------------------ */
/*  Extracted: neighbor accumulation                                   */
/* ------------------------------------------------------------------ */

function resetScratch(s: PartitionState): void {
  for (let i = 0; i < s.candidateCommunityCount; i++) {
    const c: number = iget(s.candidateCommunities, i);
    s.isCandidateCommunity[c] = 0;
    s.neighborEdgeWeightToCommunity[c] = 0;
    s.outEdgeWeightToCommunity[c] = 0;
    s.inEdgeWeightFromCommunity[c] = 0;
  }
  s.candidateCommunityCount = 0;
}

function touchCandidate(s: PartitionState, c: number): void {
  if (u8get(s.isCandidateCommunity, c)) return;
  s.isCandidateCommunity[c] = 1;
  s.candidateCommunities[s.candidateCommunityCount++] = c;
}

function accumulateNeighborWeights(s: PartitionState, v: number): number {
  resetScratch(s);
  const ci: number = iget(s.nodeCommunity, v);
  touchCandidate(s, ci);
  if (s.graph.directed) {
    const outL = s.graph.outEdges[v]!;
    for (let k = 0; k < outL.length; k++) {
      const j: number = outL[k]!.to;
      const w: number = outL[k]!.w;
      const cj: number = iget(s.nodeCommunity, j);
      touchCandidate(s, cj);
      s.outEdgeWeightToCommunity[cj] = fget(s.outEdgeWeightToCommunity, cj) + w;
    }
    const inL = s.graph.inEdges[v]!;
    for (let k = 0; k < inL.length; k++) {
      const i2: number = inL[k]!.from;
      const w: number = inL[k]!.w;
      const ci2: number = iget(s.nodeCommunity, i2);
      touchCandidate(s, ci2);
      s.inEdgeWeightFromCommunity[ci2] = fget(s.inEdgeWeightFromCommunity, ci2) + w;
    }
  } else {
    const list = s.graph.outEdges[v]!;
    for (let k = 0; k < list.length; k++) {
      const j: number = list[k]!.to;
      const w: number = list[k]!.w;
      const cj: number = iget(s.nodeCommunity, j);
      touchCandidate(s, cj);
      s.neighborEdgeWeightToCommunity[cj] = fget(s.neighborEdgeWeightToCommunity, cj) + w;
    }
  }
  return s.candidateCommunityCount;
}

/* ------------------------------------------------------------------ */
/*  Extracted: modularity delta computations                           */
/* ------------------------------------------------------------------ */

function computeDeltaModularityUndirected(
  s: PartitionState,
  v: number,
  newC: number,
  gamma: number = 1.0,
): number {
  const oldC: number = iget(s.nodeCommunity, v);
  if (newC === oldC) return 0;
  const twoM: number = s.graph.totalWeight;
  const strengthV: number = fget(s.graph.strengthOut, v);
  const weightToNew: number =
    newC < s.neighborEdgeWeightToCommunity.length
      ? fget(s.neighborEdgeWeightToCommunity, newC) || 0
      : 0;
  const weightToOld: number = fget(s.neighborEdgeWeightToCommunity, oldC) || 0;
  const totalStrengthNew: number =
    newC < s.communityTotalStrength.length ? fget(s.communityTotalStrength, newC) : 0;
  const totalStrengthOld: number = fget(s.communityTotalStrength, oldC);
  const gain_remove: number = -(
    weightToOld / twoM -
    (gamma * (strengthV * totalStrengthOld)) / (twoM * twoM)
  );
  const gain_add: number =
    weightToNew / twoM - (gamma * (strengthV * totalStrengthNew)) / (twoM * twoM);
  return gain_remove + gain_add;
}

function computeDeltaModularityDirected(
  s: PartitionState,
  v: number,
  newC: number,
  gamma: number = 1.0,
): number {
  const oldC: number = iget(s.nodeCommunity, v);
  if (newC === oldC) return 0;
  const totalEdgeWeight: number = s.graph.totalWeight;
  const strengthOutV: number = fget(s.graph.strengthOut, v);
  const strengthInV: number = fget(s.graph.strengthIn, v);
  const inFromNew: number =
    newC < s.inEdgeWeightFromCommunity.length ? fget(s.inEdgeWeightFromCommunity, newC) || 0 : 0;
  const outToNew: number =
    newC < s.outEdgeWeightToCommunity.length ? fget(s.outEdgeWeightToCommunity, newC) || 0 : 0;
  const inFromOld: number = fget(s.inEdgeWeightFromCommunity, oldC) || 0;
  const outToOld: number = fget(s.outEdgeWeightToCommunity, oldC) || 0;
  const totalInStrengthNew: number =
    newC < s.communityTotalInStrength.length ? fget(s.communityTotalInStrength, newC) : 0;
  const totalOutStrengthNew: number =
    newC < s.communityTotalOutStrength.length ? fget(s.communityTotalOutStrength, newC) : 0;
  const totalInStrengthOld: number = fget(s.communityTotalInStrength, oldC);
  const totalOutStrengthOld: number = fget(s.communityTotalOutStrength, oldC);
  // Self-loop correction + constant term (see modularity.ts diffModularityDirected)
  const selfW: number = fget(s.graph.selfLoop, v) || 0;
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

function computeDeltaCPM(s: PartitionState, v: number, newC: number, gamma: number = 1.0): number {
  const oldC: number = iget(s.nodeCommunity, v);
  if (newC === oldC) return 0;
  let w_old: number;
  let w_new: number;
  let selfCorrection: number = 0;
  if (s.graph.directed) {
    w_old =
      (fget(s.outEdgeWeightToCommunity, oldC) || 0) +
      (fget(s.inEdgeWeightFromCommunity, oldC) || 0);
    w_new =
      newC < s.outEdgeWeightToCommunity.length
        ? (fget(s.outEdgeWeightToCommunity, newC) || 0) +
          (fget(s.inEdgeWeightFromCommunity, newC) || 0)
        : 0;
    // Self-loop correction (see cpm.ts diffCPM)
    selfCorrection = 2 * (fget(s.graph.selfLoop, v) || 0);
  } else {
    w_old = fget(s.neighborEdgeWeightToCommunity, oldC) || 0;
    w_new =
      newC < s.neighborEdgeWeightToCommunity.length
        ? fget(s.neighborEdgeWeightToCommunity, newC) || 0
        : 0;
  }
  const nodeSz: number = fget(s.graph.size, v) || 1;
  const sizeOld: number = fget(s.communityTotalSize, oldC) || 0;
  const sizeNew: number = newC < s.communityTotalSize.length ? fget(s.communityTotalSize, newC) : 0;
  return w_new - w_old + selfCorrection - gamma * nodeSz * (sizeNew - sizeOld + nodeSz);
}

/* ------------------------------------------------------------------ */
/*  Extracted: node move                                               */
/* ------------------------------------------------------------------ */

function moveNode(s: PartitionState, v: number, newC: number): boolean {
  const oldC: number = iget(s.nodeCommunity, v);
  if (oldC === newC) return false;
  if (newC >= s.communityCount) {
    ensureCommCapacity(s, newC + 1);
    s.communityCount = newC + 1;
  }
  const strengthOutV: number = fget(s.graph.strengthOut, v);
  const strengthInV: number = fget(s.graph.strengthIn, v);
  const selfLoopWeight: number = fget(s.graph.selfLoop, v);
  const nodeSz: number = fget(s.graph.size, v);

  s.communityNodeCount[oldC] = iget(s.communityNodeCount, oldC) - 1;
  s.communityNodeCount[newC] = iget(s.communityNodeCount, newC) + 1;
  s.communityTotalSize[oldC] = fget(s.communityTotalSize, oldC) - nodeSz;
  s.communityTotalSize[newC] = fget(s.communityTotalSize, newC) + nodeSz;
  if (s.graph.directed) {
    s.communityTotalOutStrength[oldC] = fget(s.communityTotalOutStrength, oldC) - strengthOutV;
    s.communityTotalOutStrength[newC] = fget(s.communityTotalOutStrength, newC) + strengthOutV;
    s.communityTotalInStrength[oldC] = fget(s.communityTotalInStrength, oldC) - strengthInV;
    s.communityTotalInStrength[newC] = fget(s.communityTotalInStrength, newC) + strengthInV;
  } else {
    s.communityTotalStrength[oldC] = fget(s.communityTotalStrength, oldC) - strengthOutV;
    s.communityTotalStrength[newC] = fget(s.communityTotalStrength, newC) + strengthOutV;
  }

  if (s.graph.directed) {
    const outToOld: number = fget(s.outEdgeWeightToCommunity, oldC) || 0;
    const inFromOld: number = fget(s.inEdgeWeightFromCommunity, oldC) || 0;
    const outToNew: number =
      newC < s.outEdgeWeightToCommunity.length ? fget(s.outEdgeWeightToCommunity, newC) || 0 : 0;
    const inFromNew: number =
      newC < s.inEdgeWeightFromCommunity.length ? fget(s.inEdgeWeightFromCommunity, newC) || 0 : 0;
    // outToOld/inFromOld already include the self-loop weight (self-loops are
    // in outEdges/inEdges), so subtract it once to avoid triple-counting.
    s.communityInternalEdgeWeight[oldC] =
      fget(s.communityInternalEdgeWeight, oldC) - (outToOld + inFromOld - selfLoopWeight);
    s.communityInternalEdgeWeight[newC] =
      fget(s.communityInternalEdgeWeight, newC) + (outToNew + inFromNew + selfLoopWeight);
  } else {
    const weightToOld: number = fget(s.neighborEdgeWeightToCommunity, oldC) || 0;
    const weightToNew: number = fget(s.neighborEdgeWeightToCommunity, newC) || 0;
    s.communityInternalEdgeWeight[oldC] =
      fget(s.communityInternalEdgeWeight, oldC) - (2 * weightToOld + selfLoopWeight);
    s.communityInternalEdgeWeight[newC] =
      fget(s.communityInternalEdgeWeight, newC) + (2 * weightToNew + selfLoopWeight);
  }

  s.nodeCommunity[v] = newC;
  return true;
}

/* ------------------------------------------------------------------ */
/*  Extracted: community compaction                                    */
/* ------------------------------------------------------------------ */

function compactIds(s: PartitionState, opts: CompactOptions = {}): void {
  const ids: number[] = [];
  for (let c = 0; c < s.communityCount; c++) if (iget(s.communityNodeCount, c) > 0) ids.push(c);
  buildSortedCommunityIds(ids, opts, s.communityTotalSize, s.communityNodeCount);

  const newId = new Int32Array(s.communityCount).fill(-1);
  ids.forEach((c, i) => {
    newId[c] = i;
  });
  for (let i = 0; i < s.nodeCommunity.length; i++)
    s.nodeCommunity[i] = iget(newId, iget(s.nodeCommunity, i));

  const remappedCount: number = ids.length;
  const newTotalSize = new Float64Array(remappedCount);
  const newNodeCount = new Int32Array(remappedCount);
  const newInternalEdgeWeight = new Float64Array(remappedCount);
  const newTotalStrength = new Float64Array(remappedCount);
  const newTotalOutStrength = new Float64Array(remappedCount);
  const newTotalInStrength = new Float64Array(remappedCount);
  accumulateNodeAggregates(
    s.graph,
    s.nodeCommunity,
    s.n,
    newTotalSize,
    newNodeCount,
    newInternalEdgeWeight,
    newTotalStrength,
    newTotalOutStrength,
    newTotalInStrength,
  );
  accumulateInternalEdgeWeights(s.graph, s.nodeCommunity, s.n, newInternalEdgeWeight);

  s.communityCount = remappedCount;
  s.communityTotalSize = newTotalSize;
  s.communityNodeCount = newNodeCount;
  s.communityInternalEdgeWeight = newInternalEdgeWeight;
  s.communityTotalStrength = newTotalStrength;
  s.communityTotalOutStrength = newTotalOutStrength;
  s.communityTotalInStrength = newTotalInStrength;
}

/* ------------------------------------------------------------------ */
/*  Factory: thin wrapper that wires state to extracted functions      */
/* ------------------------------------------------------------------ */

export function makePartition(graph: GraphAdapter): Partition {
  const n: number = graph.n;
  const nodeCommunity = new Int32Array(n);
  for (let i = 0; i < n; i++) nodeCommunity[i] = i;

  const s: PartitionState = {
    graph,
    n,
    nodeCommunity,
    communityCount: n,
    communityTotalSize: new Float64Array(n),
    communityNodeCount: new Int32Array(n),
    communityInternalEdgeWeight: new Float64Array(n),
    communityTotalStrength: new Float64Array(n),
    communityTotalOutStrength: new Float64Array(n),
    communityTotalInStrength: new Float64Array(n),
    candidateCommunities: new Int32Array(n),
    candidateCommunityCount: 0,
    neighborEdgeWeightToCommunity: new Float64Array(n),
    outEdgeWeightToCommunity: new Float64Array(n),
    inEdgeWeightFromCommunity: new Float64Array(n),
    isCandidateCommunity: new Uint8Array(n),
  };

  return {
    n,
    get communityCount() {
      return s.communityCount;
    },
    nodeCommunity,
    get communityTotalSize() {
      return s.communityTotalSize;
    },
    get communityNodeCount() {
      return s.communityNodeCount;
    },
    get communityInternalEdgeWeight() {
      return s.communityInternalEdgeWeight;
    },
    get communityTotalStrength() {
      return s.communityTotalStrength;
    },
    get communityTotalOutStrength() {
      return s.communityTotalOutStrength;
    },
    get communityTotalInStrength() {
      return s.communityTotalInStrength;
    },
    resizeCommunities(newCount: number): void {
      ensureCommCapacity(s, newCount);
      s.communityCount = newCount;
    },
    initializeAggregates: () => initAggregates(s),
    accumulateNeighborCommunityEdgeWeights: (v: number) => accumulateNeighborWeights(s, v),
    getCandidateCommunityCount: (): number => s.candidateCommunityCount,
    getCandidateCommunityAt: (i: number): number => iget(s.candidateCommunities, i),
    getNeighborEdgeWeightToCommunity: (c: number): number =>
      fget(s.neighborEdgeWeightToCommunity, c) || 0,
    getOutEdgeWeightToCommunity: (c: number): number => fget(s.outEdgeWeightToCommunity, c) || 0,
    getInEdgeWeightFromCommunity: (c: number): number => fget(s.inEdgeWeightFromCommunity, c) || 0,
    deltaModularityUndirected: (v: number, newC: number, gamma?: number) =>
      computeDeltaModularityUndirected(s, v, newC, gamma),
    deltaModularityDirected: (v: number, newC: number, gamma?: number) =>
      computeDeltaModularityDirected(s, v, newC, gamma),
    deltaCPM: (v: number, newC: number, gamma?: number) => computeDeltaCPM(s, v, newC, gamma),
    moveNodeToCommunity: (v: number, newC: number) => moveNode(s, v, newC),
    compactCommunityIds: (opts?: CompactOptions) => compactIds(s, opts),
    getCommunityMembers(): number[][] {
      const comms: number[][] = new Array(s.communityCount);
      for (let i = 0; i < s.communityCount; i++) comms[i] = [];
      for (let i = 0; i < n; i++) comms[iget(nodeCommunity, i)]!.push(i);
      return comms;
    },
    getCommunityTotalSize: (c: number): number =>
      c < s.communityTotalSize.length ? fget(s.communityTotalSize, c) : 0,
    getCommunityNodeCount: (c: number): number =>
      c < s.communityNodeCount.length ? iget(s.communityNodeCount, c) : 0,
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
