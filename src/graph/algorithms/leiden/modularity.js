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
  const gain_remove = -(k_v_in_old / m2 - gamma * (k_v * wTot_old) / (m2 * m2));
  const gain_add = k_v_in_new / m2 - gamma * (k_v * wTot_new) / (m2 * m2);
  return gain_remove + gain_add;
}

export function diffModularityDirected(part, g, v, c, gamma = 1.0) {
  const oldC = part.nodeCommunity[v];
  if (c === oldC) return 0;
  const m = g.totalWeight;
  const k_out = g.strengthOut[v];
  const k_in = g.strengthIn[v];
  const w_new_in = c < g.n ? (part.getInEdgeWeightFromCommunity(c) || 0) : 0;
  const w_new_out = c < g.n ? (part.getOutEdgeWeightToCommunity(c) || 0) : 0;
  const w_old_in = part.getInEdgeWeightFromCommunity(oldC) || 0;
  const w_old_out = part.getOutEdgeWeightToCommunity(oldC) || 0;
  const T_new =
    c < part.communityTotalInStrength.length ? part.communityTotalInStrength[c] : 0;
  const F_new =
    c < part.communityTotalOutStrength.length ? part.communityTotalOutStrength[c] : 0;
  const T_old = part.communityTotalInStrength[oldC];
  const F_old = part.communityTotalOutStrength[oldC];
  const deltaInternal = (w_new_in + w_new_out - w_old_in - w_old_out) / m;
  const deltaExpected = gamma * (k_out * (T_new - T_old) + k_in * (F_new - F_old)) / (m * m);
  return deltaInternal - deltaExpected;
}

export function qualityModularity(part, g, gamma = 1.0) {
  const m2 = g.totalWeight;
  let sum = 0;
  if (g.directed) {
    for (let c = 0; c < part.communityCount; c++)
      sum +=
        part.communityInternalEdgeWeight[c] / m2 -
        gamma * (part.communityTotalOutStrength[c] * part.communityTotalInStrength[c]) / (m2 * m2);
  } else {
    for (let c = 0; c < part.communityCount; c++) {
      const lc = part.communityInternalEdgeWeight[c];
      const dc = part.communityTotalStrength[c];
      sum += lc / m2 - gamma * (dc * dc) / (m2 * m2);
    }
  }
  return sum;
}
