/**
 * CPM (Constant Potts Model) quality functions.
 * Vendored from ngraph.leiden (MIT) — no external dependencies.
 */

/**
 * Minimal view of a partition needed by CPM quality functions.
 */
export interface PartitionView {
  readonly communityCount: number;
  nodeCommunity: Int32Array;
  readonly communityInternalEdgeWeight: Float64Array;
  readonly communityTotalSize: Float64Array;
  getOutEdgeWeightToCommunity(c: number): number;
  getInEdgeWeightFromCommunity(c: number): number;
  getNeighborEdgeWeightToCommunity(c: number): number;
}

/**
 * Minimal view of a graph needed by CPM quality functions.
 */
export interface GraphView {
  n: number;
  directed: boolean;
  selfLoop: Float64Array;
  size: Float64Array;
}

// Typed array safe-access helper (see adapter.ts for rationale)
function fget(a: Float64Array, i: number): number {
  return a[i] as number;
}
function iget(a: Int32Array, i: number): number {
  return a[i] as number;
}

export function diffCPM(
  part: PartitionView,
  g: GraphView,
  v: number,
  c: number,
  gamma: number = 1.0,
): number {
  const oldC: number = iget(part.nodeCommunity, v);
  if (c === oldC) return 0;
  let w_old: number;
  let w_new: number;
  let selfCorrection: number = 0;
  if (g.directed) {
    w_old =
      (part.getOutEdgeWeightToCommunity(oldC) || 0) +
      (part.getInEdgeWeightFromCommunity(oldC) || 0);
    w_new =
      c < g.n
        ? (part.getOutEdgeWeightToCommunity(c) || 0) + (part.getInEdgeWeightFromCommunity(c) || 0)
        : 0;
    // Self-loop weight appears in both out and in arrays for oldC,
    // making w_old include 2x selfLoop. Correct to match moveNodeToCommunity.
    selfCorrection = 2 * (fget(g.selfLoop, v) || 0);
  } else {
    w_old = part.getNeighborEdgeWeightToCommunity(oldC) || 0;
    w_new = c < g.n ? part.getNeighborEdgeWeightToCommunity(c) || 0 : 0;
  }
  const s_v: number = fget(g.size, v) || 1;
  const S_old: number = fget(part.communityTotalSize, oldC) || 0;
  const S_new: number = c < part.communityTotalSize.length ? fget(part.communityTotalSize, c) : 0;
  return w_new - w_old + selfCorrection - gamma * s_v * (S_new - S_old + s_v);
}

export function qualityCPM(part: PartitionView, _g: GraphView, gamma: number = 1.0): number {
  let sum: number = 0;
  for (let c = 0; c < part.communityCount; c++) {
    const S: number = fget(part.communityTotalSize, c) || 0;
    sum += fget(part.communityInternalEdgeWeight, c) - (gamma * (S * (S - 1))) / 2;
  }
  return sum;
}
