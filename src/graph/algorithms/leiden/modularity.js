/**
 * Modularity quality functions.
 * Vendored from ngraph.leiden (MIT) — no external dependencies.
 */

export function diffModularity(part, g, v, c, gamma = 1.0) {
  if (g.directed) return diffModularityDirected(part, g, v, c, gamma);
  const oldC = part.nodeCommunity[v];
  if (c === oldC) return 0;
  const k_v = g.strengthOut[v];
  const m2 = g.totalWeight;
  const k_v_in_new = part.getNeighborEdgeWeightToCommunity(c) || 0;
  const k_v_in_old = part.getNeighborEdgeWeightToCommunity(oldC) || 0;
  const wTot_new = c < part.communityTotalStrength.length ? part.communityTotalStrength[c] : 0;
  const wTot_old = part.communityTotalStrength[oldC];
  const gain_remove = -(k_v_in_old / m2 - (gamma * (k_v * wTot_old)) / (m2 * m2));
  const gain_add = k_v_in_new / m2 - (gamma * (k_v * wTot_new)) / (m2 * m2);
  return gain_remove + gain_add;
}

export function diffModularityDirected(part, g, v, c, gamma = 1.0) {
  const oldC = part.nodeCommunity[v];
  if (c === oldC) return 0;
  const m = g.totalWeight;
  const k_out = g.strengthOut[v];
  const k_in = g.strengthIn[v];
  const w_new_in = c < g.n ? part.getInEdgeWeightFromCommunity(c) || 0 : 0;
  const w_new_out = c < g.n ? part.getOutEdgeWeightToCommunity(c) || 0 : 0;
  const w_old_in = part.getInEdgeWeightFromCommunity(oldC) || 0;
  const w_old_out = part.getOutEdgeWeightToCommunity(oldC) || 0;
  const T_new = c < part.communityTotalInStrength.length ? part.communityTotalInStrength[c] : 0;
  const F_new = c < part.communityTotalOutStrength.length ? part.communityTotalOutStrength[c] : 0;
  const T_old = part.communityTotalInStrength[oldC];
  const F_old = part.communityTotalOutStrength[oldC];
  // Self-loop correction: the self-loop edge (v→v) appears in both
  // outEdgeWeightToCommunity[oldC] and inEdgeWeightFromCommunity[oldC],
  // making w_old include 2×selfLoop. Since the self-loop moves with the
  // node, add it back to match moveNodeToCommunity's directed accounting.
  const selfW = g.selfLoop[v] || 0;
  const deltaInternal = (w_new_in + w_new_out - w_old_in - w_old_out + 2 * selfW) / m;
  // The full Δ(F·T) expansion includes a constant 2·k_out·k_in term that
  // doesn't depend on the target community but does affect the move-vs-stay
  // decision.  Without it, coarse-level merges can appear profitable when
  // they actually decrease quality.
  const deltaExpected =
    (gamma * (k_out * (T_new - T_old) + k_in * (F_new - F_old) + 2 * k_out * k_in)) / (m * m);
  return deltaInternal - deltaExpected;
}

export function qualityModularity(part, g, gamma = 1.0) {
  const m2 = g.totalWeight;
  let sum = 0;
  if (g.directed) {
    for (let c = 0; c < part.communityCount; c++)
      sum +=
        part.communityInternalEdgeWeight[c] / m2 -
        (gamma * (part.communityTotalOutStrength[c] * part.communityTotalInStrength[c])) /
          (m2 * m2);
  } else {
    // communityInternalEdgeWeight counts each undirected edge once (j > i),
    // but m2 = totalWeight = 2m (sum of symmetrized degrees). The standard
    // Newman-Girvan formula is Q = Σ_c [2·L_c/(2m) - γ·(d_c/(2m))²], so
    // we multiply lc by 2 to match.
    for (let c = 0; c < part.communityCount; c++) {
      const lc = part.communityInternalEdgeWeight[c];
      const dc = part.communityTotalStrength[c];
      sum += (2 * lc) / m2 - (gamma * (dc * dc)) / (m2 * m2);
    }
  }
  return sum;
}
