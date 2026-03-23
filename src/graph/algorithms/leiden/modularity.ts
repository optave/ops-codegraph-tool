/**
 * Modularity quality functions.
 * Vendored from ngraph.leiden (MIT) — no external dependencies.
 */

/**
 * Minimal view of a partition needed by modularity quality functions.
 */
export interface PartitionView {
  readonly communityCount: number;
  nodeCommunity: Int32Array;
  readonly communityInternalEdgeWeight: Float64Array;
  readonly communityTotalStrength: Float64Array;
  readonly communityTotalOutStrength: Float64Array;
  readonly communityTotalInStrength: Float64Array;
  getNeighborEdgeWeightToCommunity(c: number): number;
  getOutEdgeWeightToCommunity(c: number): number;
  getInEdgeWeightFromCommunity(c: number): number;
}

/**
 * Minimal view of a graph needed by modularity quality functions.
 */
export interface GraphView {
  n: number;
  directed: boolean;
  totalWeight: number;
  strengthOut: Float64Array;
  strengthIn: Float64Array;
  selfLoop: Float64Array;
}

// Typed array safe-access helper (see adapter.ts for rationale)
function fget(a: Float64Array, i: number): number {
  return a[i] as number;
}
function iget(a: Int32Array, i: number): number {
  return a[i] as number;
}

export function diffModularity(
  part: PartitionView,
  g: GraphView,
  v: number,
  c: number,
  gamma: number = 1.0,
): number {
  if (g.directed) return diffModularityDirected(part, g, v, c, gamma);
  const oldC: number = iget(part.nodeCommunity, v);
  if (c === oldC) return 0;
  const k_v: number = fget(g.strengthOut, v);
  const m2: number = g.totalWeight;
  const k_v_in_new: number = part.getNeighborEdgeWeightToCommunity(c) || 0;
  const k_v_in_old: number = part.getNeighborEdgeWeightToCommunity(oldC) || 0;
  const wTot_new: number =
    c < part.communityTotalStrength.length ? fget(part.communityTotalStrength, c) : 0;
  const wTot_old: number = fget(part.communityTotalStrength, oldC);
  const gain_remove: number = -(k_v_in_old / m2 - (gamma * (k_v * wTot_old)) / (m2 * m2));
  const gain_add: number = k_v_in_new / m2 - (gamma * (k_v * wTot_new)) / (m2 * m2);
  return gain_remove + gain_add;
}

export function diffModularityDirected(
  part: PartitionView,
  g: GraphView,
  v: number,
  c: number,
  gamma: number = 1.0,
): number {
  const oldC: number = iget(part.nodeCommunity, v);
  if (c === oldC) return 0;
  const m: number = g.totalWeight;
  const k_out: number = fget(g.strengthOut, v);
  const k_in: number = fget(g.strengthIn, v);
  const w_new_in: number = c < g.n ? part.getInEdgeWeightFromCommunity(c) || 0 : 0;
  const w_new_out: number = c < g.n ? part.getOutEdgeWeightToCommunity(c) || 0 : 0;
  const w_old_in: number = part.getInEdgeWeightFromCommunity(oldC) || 0;
  const w_old_out: number = part.getOutEdgeWeightToCommunity(oldC) || 0;
  const T_new: number =
    c < part.communityTotalInStrength.length ? fget(part.communityTotalInStrength, c) : 0;
  const F_new: number =
    c < part.communityTotalOutStrength.length ? fget(part.communityTotalOutStrength, c) : 0;
  const T_old: number = fget(part.communityTotalInStrength, oldC);
  const F_old: number = fget(part.communityTotalOutStrength, oldC);
  // Self-loop correction: the self-loop edge (v->v) appears in both
  // outEdgeWeightToCommunity[oldC] and inEdgeWeightFromCommunity[oldC],
  // making w_old include 2x selfLoop. Since the self-loop moves with the
  // node, add it back to match moveNodeToCommunity's directed accounting.
  const selfW: number = fget(g.selfLoop, v) || 0;
  const deltaInternal: number = (w_new_in + w_new_out - w_old_in - w_old_out + 2 * selfW) / m;
  // The full delta(F*T) expansion includes a constant 2*k_out*k_in term that
  // doesn't depend on the target community but does affect the move-vs-stay
  // decision. Without it, coarse-level merges can appear profitable when
  // they actually decrease quality.
  const deltaExpected: number =
    (gamma * (k_out * (T_new - T_old) + k_in * (F_new - F_old) + 2 * k_out * k_in)) / (m * m);
  return deltaInternal - deltaExpected;
}

export function qualityModularity(part: PartitionView, g: GraphView, gamma: number = 1.0): number {
  const m2: number = g.totalWeight;
  let sum: number = 0;
  if (g.directed) {
    for (let c = 0; c < part.communityCount; c++)
      sum +=
        fget(part.communityInternalEdgeWeight, c) / m2 -
        (gamma *
          (fget(part.communityTotalOutStrength, c) * fget(part.communityTotalInStrength, c))) /
          (m2 * m2);
  } else {
    // communityInternalEdgeWeight counts each undirected edge once (j > i),
    // but m2 = totalWeight = 2m (sum of symmetrized degrees). The standard
    // Newman-Girvan formula is Q = sum_c [2*L_c/(2m) - gamma*(d_c/(2m))^2], so
    // we multiply lc by 2 to match.
    for (let c = 0; c < part.communityCount; c++) {
      const lc: number = fget(part.communityInternalEdgeWeight, c);
      const dc: number = fget(part.communityTotalStrength, c);
      sum += (2 * lc) / m2 - (gamma * (dc * dc)) / (m2 * m2);
    }
  }
  return sum;
}
