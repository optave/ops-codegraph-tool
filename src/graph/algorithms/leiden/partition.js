/**
 * Mutable community assignment with per-community aggregates.
 * Vendored from ngraph.leiden (MIT) — no external dependencies.
 *
 * Maintains per-community totals and per-move scratch accumulators so we can
 * compute modularity/CPM gains in O(neighborhood) time without rescanning the
 * whole graph after each move.
 */

export function makePartition(graph) {
  const n = graph.n;
  const nodeCommunity = new Int32Array(n);
  for (let i = 0; i < n; i++) nodeCommunity[i] = i;
  let communityCount = n;

  let communityTotalSize = new Float64Array(communityCount);
  let communityNodeCount = new Int32Array(communityCount);
  let communityInternalEdgeWeight = new Float64Array(communityCount);
  let communityTotalStrength = new Float64Array(communityCount);
  let communityTotalOutStrength = new Float64Array(communityCount);
  let communityTotalInStrength = new Float64Array(communityCount);

  const candidateCommunities = new Int32Array(n);
  let candidateCommunityCount = 0;
  const neighborEdgeWeightToCommunity = new Float64Array(n);
  const outEdgeWeightToCommunity = new Float64Array(n);
  const inEdgeWeightFromCommunity = new Float64Array(n);
  const isCandidateCommunity = new Uint8Array(n);

  function ensureCommCapacity(newCount) {
    if (newCount <= communityTotalSize.length) return;
    const growTo = Math.max(newCount, Math.ceil(communityTotalSize.length * 1.5));
    communityTotalSize = growFloat(communityTotalSize, growTo);
    communityNodeCount = growInt(communityNodeCount, growTo);
    communityInternalEdgeWeight = growFloat(communityInternalEdgeWeight, growTo);
    communityTotalStrength = growFloat(communityTotalStrength, growTo);
    communityTotalOutStrength = growFloat(communityTotalOutStrength, growTo);
    communityTotalInStrength = growFloat(communityTotalInStrength, growTo);
  }

  function initializeAggregates() {
    communityTotalSize.fill(0);
    communityNodeCount.fill(0);
    communityInternalEdgeWeight.fill(0);
    communityTotalStrength.fill(0);
    communityTotalOutStrength.fill(0);
    communityTotalInStrength.fill(0);
    for (let i = 0; i < n; i++) {
      const c = nodeCommunity[i];
      communityTotalSize[c] += graph.size[i];
      communityNodeCount[c] += 1;
      if (graph.directed) {
        communityTotalOutStrength[c] += graph.strengthOut[i];
        communityTotalInStrength[c] += graph.strengthIn[i];
      } else {
        communityTotalStrength[c] += graph.strengthOut[i];
      }
      if (graph.selfLoop[i] !== 0) communityInternalEdgeWeight[c] += graph.selfLoop[i];
    }
    if (graph.directed) {
      for (let i = 0; i < n; i++) {
        const ci = nodeCommunity[i];
        const neighbors = graph.outEdges[i];
        for (let k = 0; k < neighbors.length; k++) {
          const { to: j, w } = neighbors[k];
          if (i === j) continue; // self-loop already counted via graph.selfLoop[i]
          if (ci === nodeCommunity[j]) communityInternalEdgeWeight[ci] += w;
        }
      }
    } else {
      for (let i = 0; i < n; i++) {
        const ci = nodeCommunity[i];
        const neighbors = graph.outEdges[i];
        for (let k = 0; k < neighbors.length; k++) {
          const { to: j, w } = neighbors[k];
          if (j <= i) continue;
          if (ci === nodeCommunity[j]) communityInternalEdgeWeight[ci] += w;
        }
      }
    }
  }

  function resetScratch() {
    for (let i = 0; i < candidateCommunityCount; i++) {
      const c = candidateCommunities[i];
      isCandidateCommunity[c] = 0;
      neighborEdgeWeightToCommunity[c] = 0;
      outEdgeWeightToCommunity[c] = 0;
      inEdgeWeightFromCommunity[c] = 0;
    }
    candidateCommunityCount = 0;
  }

  function touch(c) {
    if (isCandidateCommunity[c]) return;
    isCandidateCommunity[c] = 1;
    candidateCommunities[candidateCommunityCount++] = c;
  }

  function accumulateNeighborCommunityEdgeWeights(v) {
    resetScratch();
    const ci = nodeCommunity[v];
    touch(ci);
    if (graph.directed) {
      const outL = graph.outEdges[v];
      for (let k = 0; k < outL.length; k++) {
        const j = outL[k].to;
        const w = outL[k].w;
        const cj = nodeCommunity[j];
        touch(cj);
        outEdgeWeightToCommunity[cj] += w;
      }
      const inL = graph.inEdges[v];
      for (let k = 0; k < inL.length; k++) {
        const i2 = inL[k].from;
        const w = inL[k].w;
        const ci2 = nodeCommunity[i2];
        touch(ci2);
        inEdgeWeightFromCommunity[ci2] += w;
      }
    } else {
      const list = graph.outEdges[v];
      for (let k = 0; k < list.length; k++) {
        const j = list[k].to;
        const w = list[k].w;
        const cj = nodeCommunity[j];
        touch(cj);
        neighborEdgeWeightToCommunity[cj] += w;
      }
    }
    return candidateCommunityCount;
  }

  const twoMUndirected = graph.totalWeight;
  function deltaModularityUndirected(v, newC, gamma = 1.0) {
    const oldC = nodeCommunity[v];
    if (newC === oldC) return 0;
    const strengthV = graph.strengthOut[v];
    const weightToNew =
      newC < neighborEdgeWeightToCommunity.length ? neighborEdgeWeightToCommunity[newC] || 0 : 0;
    const weightToOld = neighborEdgeWeightToCommunity[oldC] || 0;
    const totalStrengthNew =
      newC < communityTotalStrength.length ? communityTotalStrength[newC] : 0;
    const totalStrengthOld = communityTotalStrength[oldC];
    const gain_remove = -(
      weightToOld / twoMUndirected -
      (gamma * (strengthV * totalStrengthOld)) / (twoMUndirected * twoMUndirected)
    );
    const gain_add =
      weightToNew / twoMUndirected -
      (gamma * (strengthV * totalStrengthNew)) / (twoMUndirected * twoMUndirected);
    return gain_remove + gain_add;
  }

  function deltaModularityDirected(v, newC, gamma = 1.0) {
    const oldC = nodeCommunity[v];
    if (newC === oldC) return 0;
    const totalEdgeWeight = graph.totalWeight;
    const strengthOutV = graph.strengthOut[v];
    const strengthInV = graph.strengthIn[v];
    const inFromNew =
      newC < inEdgeWeightFromCommunity.length ? inEdgeWeightFromCommunity[newC] || 0 : 0;
    const outToNew =
      newC < outEdgeWeightToCommunity.length ? outEdgeWeightToCommunity[newC] || 0 : 0;
    const inFromOld = inEdgeWeightFromCommunity[oldC] || 0;
    const outToOld = outEdgeWeightToCommunity[oldC] || 0;
    const totalInStrengthNew =
      newC < communityTotalInStrength.length ? communityTotalInStrength[newC] : 0;
    const totalOutStrengthNew =
      newC < communityTotalOutStrength.length ? communityTotalOutStrength[newC] : 0;
    const totalInStrengthOld = communityTotalInStrength[oldC];
    const totalOutStrengthOld = communityTotalOutStrength[oldC];
    // Self-loop correction + constant term (see modularity.js diffModularityDirected)
    const selfW = graph.selfLoop[v] || 0;
    const deltaInternal =
      (inFromNew + outToNew - inFromOld - outToOld + 2 * selfW) / totalEdgeWeight;
    const deltaExpected =
      (gamma *
        (strengthOutV * (totalInStrengthNew - totalInStrengthOld) +
          strengthInV * (totalOutStrengthNew - totalOutStrengthOld) +
          2 * strengthOutV * strengthInV)) /
      (totalEdgeWeight * totalEdgeWeight);
    return deltaInternal - deltaExpected;
  }

  function deltaCPM(v, newC, gamma = 1.0) {
    const oldC = nodeCommunity[v];
    if (newC === oldC) return 0;
    let w_old, w_new;
    let selfCorrection = 0;
    if (graph.directed) {
      w_old = (outEdgeWeightToCommunity[oldC] || 0) + (inEdgeWeightFromCommunity[oldC] || 0);
      w_new =
        newC < outEdgeWeightToCommunity.length
          ? (outEdgeWeightToCommunity[newC] || 0) + (inEdgeWeightFromCommunity[newC] || 0)
          : 0;
      // Self-loop correction (see cpm.js diffCPM)
      selfCorrection = 2 * (graph.selfLoop[v] || 0);
    } else {
      w_old = neighborEdgeWeightToCommunity[oldC] || 0;
      w_new =
        newC < neighborEdgeWeightToCommunity.length ? neighborEdgeWeightToCommunity[newC] || 0 : 0;
    }
    const nodeSize = graph.size[v] || 1;
    const sizeOld = communityTotalSize[oldC] || 0;
    const sizeNew = newC < communityTotalSize.length ? communityTotalSize[newC] : 0;
    return w_new - w_old + selfCorrection - gamma * nodeSize * (sizeNew - sizeOld + nodeSize);
  }

  function moveNodeToCommunity(v, newC) {
    const oldC = nodeCommunity[v];
    if (oldC === newC) return false;
    if (newC >= communityCount) {
      ensureCommCapacity(newC + 1);
      communityCount = newC + 1;
    }
    const strengthOutV = graph.strengthOut[v];
    const strengthInV = graph.strengthIn[v];
    const selfLoopWeight = graph.selfLoop[v];
    const nodeSize = graph.size[v];

    communityNodeCount[oldC] -= 1;
    communityNodeCount[newC] += 1;
    communityTotalSize[oldC] -= nodeSize;
    communityTotalSize[newC] += nodeSize;
    if (graph.directed) {
      communityTotalOutStrength[oldC] -= strengthOutV;
      communityTotalOutStrength[newC] += strengthOutV;
      communityTotalInStrength[oldC] -= strengthInV;
      communityTotalInStrength[newC] += strengthInV;
    } else {
      communityTotalStrength[oldC] -= strengthOutV;
      communityTotalStrength[newC] += strengthOutV;
    }

    if (graph.directed) {
      const outToOld = outEdgeWeightToCommunity[oldC] || 0;
      const inFromOld = inEdgeWeightFromCommunity[oldC] || 0;
      const outToNew =
        newC < outEdgeWeightToCommunity.length ? outEdgeWeightToCommunity[newC] || 0 : 0;
      const inFromNew =
        newC < inEdgeWeightFromCommunity.length ? inEdgeWeightFromCommunity[newC] || 0 : 0;
      // outToOld/inFromOld already include the self-loop weight (self-loops are
      // in outEdges/inEdges), so subtract it once to avoid triple-counting.
      communityInternalEdgeWeight[oldC] -= outToOld + inFromOld - selfLoopWeight;
      communityInternalEdgeWeight[newC] += outToNew + inFromNew + selfLoopWeight;
    } else {
      const weightToOld = neighborEdgeWeightToCommunity[oldC] || 0;
      const weightToNew = neighborEdgeWeightToCommunity[newC] || 0;
      communityInternalEdgeWeight[oldC] -= 2 * weightToOld + selfLoopWeight;
      communityInternalEdgeWeight[newC] += 2 * weightToNew + selfLoopWeight;
    }

    nodeCommunity[v] = newC;
    return true;
  }

  function compactCommunityIds(opts = {}) {
    const ids = [];
    for (let c = 0; c < communityCount; c++) if (communityNodeCount[c] > 0) ids.push(c);
    if (opts.keepOldOrder) {
      ids.sort((a, b) => a - b);
    } else if (opts.preserveMap instanceof Map) {
      ids.sort((a, b) => {
        const pa = opts.preserveMap.get(a);
        const pb = opts.preserveMap.get(b);
        if (pa != null && pb != null && pa !== pb) return pa - pb;
        if (pa != null && pb == null) return -1;
        if (pb != null && pa == null) return 1;
        return (
          communityTotalSize[b] - communityTotalSize[a] ||
          communityNodeCount[b] - communityNodeCount[a] ||
          a - b
        );
      });
    } else {
      ids.sort(
        (a, b) =>
          communityTotalSize[b] - communityTotalSize[a] ||
          communityNodeCount[b] - communityNodeCount[a] ||
          a - b,
      );
    }
    const newId = new Int32Array(communityCount).fill(-1);
    ids.forEach((c, i) => {
      newId[c] = i;
    });
    for (let i = 0; i < nodeCommunity.length; i++) nodeCommunity[i] = newId[nodeCommunity[i]];
    const remappedCount = ids.length;
    const newTotalSize = new Float64Array(remappedCount);
    const newNodeCount = new Int32Array(remappedCount);
    const newInternalEdgeWeight = new Float64Array(remappedCount);
    const newTotalStrength = new Float64Array(remappedCount);
    const newTotalOutStrength = new Float64Array(remappedCount);
    const newTotalInStrength = new Float64Array(remappedCount);
    for (let i = 0; i < n; i++) {
      const c = nodeCommunity[i];
      newTotalSize[c] += graph.size[i];
      newNodeCount[c] += 1;
      if (graph.directed) {
        newTotalOutStrength[c] += graph.strengthOut[i];
        newTotalInStrength[c] += graph.strengthIn[i];
      } else {
        newTotalStrength[c] += graph.strengthOut[i];
      }
      if (graph.selfLoop[i] !== 0) newInternalEdgeWeight[c] += graph.selfLoop[i];
    }
    if (graph.directed) {
      for (let i = 0; i < n; i++) {
        const ci = nodeCommunity[i];
        const list = graph.outEdges[i];
        for (let k = 0; k < list.length; k++) {
          const { to: j, w } = list[k];
          if (i === j) continue; // self-loop already counted via graph.selfLoop[i]
          if (ci === nodeCommunity[j]) newInternalEdgeWeight[ci] += w;
        }
      }
    } else {
      for (let i = 0; i < n; i++) {
        const ci = nodeCommunity[i];
        const list = graph.outEdges[i];
        for (let k = 0; k < list.length; k++) {
          const { to: j, w } = list[k];
          if (j <= i) continue;
          if (ci === nodeCommunity[j]) newInternalEdgeWeight[ci] += w;
        }
      }
    }
    communityCount = remappedCount;
    communityTotalSize = newTotalSize;
    communityNodeCount = newNodeCount;
    communityInternalEdgeWeight = newInternalEdgeWeight;
    communityTotalStrength = newTotalStrength;
    communityTotalOutStrength = newTotalOutStrength;
    communityTotalInStrength = newTotalInStrength;
  }

  function getCommunityMembers() {
    const comms = new Array(communityCount);
    for (let i = 0; i < communityCount; i++) comms[i] = [];
    for (let i = 0; i < n; i++) comms[nodeCommunity[i]].push(i);
    return comms;
  }

  function getCommunityTotalSize(c) {
    return c < communityTotalSize.length ? communityTotalSize[c] : 0;
  }
  function getCommunityNodeCount(c) {
    return c < communityNodeCount.length ? communityNodeCount[c] : 0;
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
    initializeAggregates,
    accumulateNeighborCommunityEdgeWeights,
    getCandidateCommunityCount: () => candidateCommunityCount,
    getCandidateCommunityAt: (i) => candidateCommunities[i],
    getNeighborEdgeWeightToCommunity: (c) => neighborEdgeWeightToCommunity[c] || 0,
    getOutEdgeWeightToCommunity: (c) => outEdgeWeightToCommunity[c] || 0,
    getInEdgeWeightFromCommunity: (c) => inEdgeWeightFromCommunity[c] || 0,
    deltaModularityUndirected,
    deltaModularityDirected,
    deltaCPM,
    moveNodeToCommunity,
    compactCommunityIds,
    getCommunityMembers,
    getCommunityTotalSize,
    getCommunityNodeCount,
  };
}

function growFloat(a, to) {
  const b = new Float64Array(to);
  b.set(a);
  return b;
}
function growInt(a, to) {
  const b = new Int32Array(to);
  b.set(a);
  return b;
}
