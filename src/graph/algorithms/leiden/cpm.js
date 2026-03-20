/**
 * CPM (Constant Potts Model) quality functions.
 * Vendored from ngraph.leiden (MIT) — no external dependencies.
 */

export function diffCPM(part, g, v, c, gamma = 1.0) {
  const oldC = part.nodeCommunity[v];
  if (c === oldC) return 0;
  let w_old, w_new;
  let selfCorrection = 0;
  if (g.directed) {
    w_old =
      (part.getOutEdgeWeightToCommunity(oldC) || 0) +
      (part.getInEdgeWeightFromCommunity(oldC) || 0);
    w_new =
      c < g.n
        ? (part.getOutEdgeWeightToCommunity(c) || 0) + (part.getInEdgeWeightFromCommunity(c) || 0)
        : 0;
    // Self-loop weight appears in both out and in arrays for oldC,
    // making w_old include 2×selfLoop. Correct to match moveNodeToCommunity.
    selfCorrection = 2 * (g.selfLoop[v] || 0);
  } else {
    w_old = part.getNeighborEdgeWeightToCommunity(oldC) || 0;
    w_new = c < g.n ? part.getNeighborEdgeWeightToCommunity(c) || 0 : 0;
  }
  const s_v = g.size[v] || 1;
  const S_old = part.communityTotalSize[oldC] || 0;
  const S_new = c < part.communityTotalSize.length ? part.communityTotalSize[c] : 0;
  return w_new - w_old + selfCorrection - gamma * s_v * (S_new - S_old + s_v);
}

export function qualityCPM(part, _g, gamma = 1.0) {
  let sum = 0;
  for (let c = 0; c < part.communityCount; c++) {
    const S = part.communityTotalSize[c] || 0;
    sum += part.communityInternalEdgeWeight[c] - (gamma * (S * (S - 1))) / 2;
  }
  return sum;
}
