/**
 * CPM (Constant Potts Model) quality functions.
 * Vendored from ngraph.leiden (MIT) — no external dependencies.
 */

export function diffCPM(part, g, v, c, gamma = 1.0) {
  const oldC = part.nodeCommunity[v];
  if (c === oldC) return 0;
  const w_old = part.getNeighborEdgeWeightToCommunity(oldC) || 0;
  const w_new = c < g.n ? (part.getNeighborEdgeWeightToCommunity(c) || 0) : 0;
  const s_v = g.size[v] || 1;
  const S_old = part.communityTotalSize[oldC] || 0;
  const S_new = c < part.communityTotalSize.length ? part.communityTotalSize[c] : 0;
  return w_new - w_old - gamma * s_v * (S_new - S_old + s_v);
}

export function qualityCPM(part, g, gamma = 1.0) {
  let sum = 0;
  for (let c = 0; c < part.communityCount; c++)
    sum +=
      part.communityInternalEdgeWeight[c] -
      (gamma * (part.communityNodeCount[c] * (part.communityNodeCount[c] - 1))) / 2;
  return sum;
}

export function qualityCPMSizeAware(part, g, gamma = 1.0) {
  let sum = 0;
  for (let c = 0; c < part.communityCount; c++) {
    const S = part.communityTotalSize[c] || 0;
    sum += part.communityInternalEdgeWeight[c] - (gamma * (S * (S - 1))) / 2;
  }
  return sum;
}
