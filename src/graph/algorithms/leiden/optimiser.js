/**
 * Core Leiden/Louvain community detection optimiser.
 * Vendored from ngraph.leiden (MIT) — adapted to use CodeGraph + local RNG.
 */

import { CodeGraph } from '../../model.js';
import { makeGraphAdapter } from './adapter.js';
import { diffCPM } from './cpm.js';
import { diffModularity, diffModularityDirected } from './modularity.js';
import { makePartition } from './partition.js';
import { createRng } from './rng.js';

// Mirrored in DEFAULTS.community (src/infrastructure/config.js) for user override
// via .codegraphrc.json. Callers (e.g. louvain.js) can pass overrides through options.
const DEFAULT_MAX_LEVELS = 50;
const DEFAULT_MAX_LOCAL_PASSES = 20;
const GAIN_EPSILON = 1e-12;

const CandidateStrategy = {
  Neighbors: 0,
  All: 1,
  RandomAny: 2,
  RandomNeighbor: 3,
};

export function runLouvainUndirectedModularity(graph, optionsInput = {}) {
  const options = normalizeOptions(optionsInput);
  let currentGraph = graph;
  const levels = [];
  const rngSource = createRng(options.randomSeed);
  const random = () => rngSource.nextDouble();

  const baseGraphAdapter = makeGraphAdapter(currentGraph, {
    directed: options.directed,
    ...optionsInput,
  });
  const origN = baseGraphAdapter.n;
  const originalToCurrent = new Int32Array(origN);
  for (let i = 0; i < origN; i++) originalToCurrent[i] = i;

  let fixedNodeMask = null;
  if (options.fixedNodes) {
    const fixed = new Uint8Array(origN);
    const asSet =
      options.fixedNodes instanceof Set ? options.fixedNodes : new Set(options.fixedNodes);
    for (const id of asSet) {
      const idx = baseGraphAdapter.idToIndex.get(String(id));
      if (idx != null) fixed[idx] = 1;
    }
    fixedNodeMask = fixed;
  }

  for (let level = 0; level < options.maxLevels; level++) {
    const graphAdapter =
      level === 0
        ? baseGraphAdapter
        : makeGraphAdapter(currentGraph, { directed: options.directed, ...optionsInput });
    const partition = makePartition(graphAdapter);
    partition.graph = graphAdapter;
    partition.initializeAggregates();

    const order = new Int32Array(graphAdapter.n);
    for (let i = 0; i < graphAdapter.n; i++) order[i] = i;

    let improved = true;
    let localPasses = 0;
    const strategyCode = options.candidateStrategyCode;
    while (improved) {
      improved = false;
      localPasses++;
      shuffleArrayInPlace(order, random);
      for (let idx = 0; idx < order.length; idx++) {
        const nodeIndex = order[idx];
        if (level === 0 && fixedNodeMask && fixedNodeMask[nodeIndex]) continue;
        const candidateCount = partition.accumulateNeighborCommunityEdgeWeights(nodeIndex);
        let bestCommunityId = partition.nodeCommunity[nodeIndex];
        let bestGain = 0;
        const maxCommunitySize = options.maxCommunitySize;
        if (strategyCode === CandidateStrategy.All) {
          for (let communityId = 0; communityId < partition.communityCount; communityId++) {
            if (communityId === partition.nodeCommunity[nodeIndex]) continue;
            if (
              maxCommunitySize < Infinity &&
              partition.getCommunityTotalSize(communityId) + graphAdapter.size[nodeIndex] >
                maxCommunitySize
            )
              continue;
            const gain = computeQualityGain(partition, nodeIndex, communityId, options);
            if (gain > bestGain) {
              bestGain = gain;
              bestCommunityId = communityId;
            }
          }
        } else if (strategyCode === CandidateStrategy.RandomAny) {
          const tries = Math.min(10, Math.max(1, partition.communityCount));
          for (let trialIndex = 0; trialIndex < tries; trialIndex++) {
            const communityId = (random() * partition.communityCount) | 0;
            if (communityId === partition.nodeCommunity[nodeIndex]) continue;
            if (
              maxCommunitySize < Infinity &&
              partition.getCommunityTotalSize(communityId) + graphAdapter.size[nodeIndex] >
                maxCommunitySize
            )
              continue;
            const gain = computeQualityGain(partition, nodeIndex, communityId, options);
            if (gain > bestGain) {
              bestGain = gain;
              bestCommunityId = communityId;
            }
          }
        } else if (strategyCode === CandidateStrategy.RandomNeighbor) {
          const tries = Math.min(10, Math.max(1, candidateCount));
          for (let trialIndex = 0; trialIndex < tries; trialIndex++) {
            const communityId = partition.getCandidateCommunityAt((random() * candidateCount) | 0);
            if (communityId === partition.nodeCommunity[nodeIndex]) continue;
            if (
              maxCommunitySize < Infinity &&
              partition.getCommunityTotalSize(communityId) + graphAdapter.size[nodeIndex] >
                maxCommunitySize
            )
              continue;
            const gain = computeQualityGain(partition, nodeIndex, communityId, options);
            if (gain > bestGain) {
              bestGain = gain;
              bestCommunityId = communityId;
            }
          }
        } else {
          for (let trialIndex = 0; trialIndex < candidateCount; trialIndex++) {
            const communityId = partition.getCandidateCommunityAt(trialIndex);
            if (maxCommunitySize < Infinity) {
              const nextSize =
                partition.getCommunityTotalSize(communityId) + graphAdapter.size[nodeIndex];
              if (nextSize > maxCommunitySize) continue;
            }
            const gain = computeQualityGain(partition, nodeIndex, communityId, options);
            if (gain > bestGain) {
              bestGain = gain;
              bestCommunityId = communityId;
            }
          }
        }
        if (options.allowNewCommunity) {
          const newCommunityId = partition.communityCount;
          const gain = computeQualityGain(partition, nodeIndex, newCommunityId, options);
          if (gain > bestGain) {
            bestGain = gain;
            bestCommunityId = newCommunityId;
          }
        }
        if (bestCommunityId !== partition.nodeCommunity[nodeIndex] && bestGain > GAIN_EPSILON) {
          partition.moveNodeToCommunity(nodeIndex, bestCommunityId);
          improved = true;
        }
      }
      if (localPasses > options.maxLocalPasses) break;
    }

    renumberCommunities(partition, options.preserveLabels);

    let effectivePartition = partition;
    if (options.refine) {
      const refined = refineWithinCoarseCommunities(
        graphAdapter,
        partition,
        random,
        options,
        level === 0 ? fixedNodeMask : null,
      );
      renumberCommunities(refined, options.preserveLabels);
      effectivePartition = refined;
    }

    levels.push({ graph: graphAdapter, partition: effectivePartition });
    const fineToCoarse = effectivePartition.nodeCommunity;
    for (let i = 0; i < originalToCurrent.length; i++) {
      originalToCurrent[i] = fineToCoarse[originalToCurrent[i]];
    }

    if (partition.communityCount === graphAdapter.n) break;
    currentGraph = buildCoarseGraph(graphAdapter, effectivePartition);
  }

  const last = levels[levels.length - 1];
  return {
    graph: last.graph,
    partition: last.partition,
    levels,
    originalToCurrent,
    originalNodeIds: baseGraphAdapter.nodeIds,
  };
}

/**
 * Build a coarse graph where each community becomes a node.
 * Uses CodeGraph instead of ngraph.graph.
 */
function buildCoarseGraph(g, p) {
  const coarse = new CodeGraph({ directed: g.directed });
  for (let c = 0; c < p.communityCount; c++) {
    coarse.addNode(String(c), { size: p.communityTotalSize[c] });
  }
  const acc = new Map();
  for (let i = 0; i < g.n; i++) {
    const cu = p.nodeCommunity[i];
    const list = g.outEdges[i];
    for (let k = 0; k < list.length; k++) {
      const j = list[k].to;
      const w = list[k].w;
      const cv = p.nodeCommunity[j];
      const key = `${cu}:${cv}`;
      acc.set(key, (acc.get(key) || 0) + w);
    }
  }
  for (const [key, w] of acc.entries()) {
    const [cuStr, cvStr] = key.split(':');
    coarse.addEdge(cuStr, cvStr, { weight: w });
  }
  return coarse;
}

function refineWithinCoarseCommunities(g, basePart, rng, opts, fixedMask0) {
  const p = makePartition(g);
  p.initializeAggregates();
  p.graph = g;
  const macro = basePart.nodeCommunity;
  const commMacro = new Int32Array(p.communityCount);
  for (let i = 0; i < p.communityCount; i++) commMacro[i] = macro[i];

  const order = new Int32Array(g.n);
  for (let i = 0; i < g.n; i++) order[i] = i;
  let improved = true;
  let passes = 0;
  while (improved) {
    improved = false;
    passes++;
    shuffleArrayInPlace(order, rng);
    for (let idx = 0; idx < order.length; idx++) {
      const v = order[idx];
      if (fixedMask0?.[v]) continue;
      const macroV = macro[v];
      const touchedCount = p.accumulateNeighborCommunityEdgeWeights(v);
      let bestC = p.nodeCommunity[v];
      let bestGain = 0;
      const maxSize = Number.isFinite(opts.maxCommunitySize) ? opts.maxCommunitySize : Infinity;
      for (let t = 0; t < touchedCount; t++) {
        const c = p.getCandidateCommunityAt(t);
        if (commMacro[c] !== macroV) continue;
        if (maxSize < Infinity) {
          const nextSize = p.getCommunityTotalSize(c) + g.size[v];
          if (nextSize > maxSize) continue;
        }
        const gain = computeQualityGain(p, v, c, opts);
        if (gain > bestGain) {
          bestGain = gain;
          bestC = c;
        }
      }
      if (bestC !== p.nodeCommunity[v] && bestGain > GAIN_EPSILON) {
        p.moveNodeToCommunity(v, bestC);
        improved = true;
      }
    }
    if (passes > (opts.maxLocalPasses || DEFAULT_MAX_LOCAL_PASSES)) break;
  }
  return p;
}

function computeQualityGain(partition, v, c, opts) {
  const quality = (opts.quality || 'modularity').toLowerCase();
  const gamma = typeof opts.resolution === 'number' ? opts.resolution : 1.0;
  if (quality === 'cpm') {
    return diffCPM(partition, partition.graph || {}, v, c, gamma);
  }
  if (opts.directed) {
    return diffModularityDirected(partition, partition.graph || {}, v, c, gamma);
  }
  return diffModularity(partition, partition.graph || {}, v, c, gamma);
}

function shuffleArrayInPlace(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

function resolveCandidateStrategy(options) {
  const val = options.candidateStrategy;
  if (typeof val !== 'string') return CandidateStrategy.Neighbors;
  switch (val) {
    case 'neighbors':
      return CandidateStrategy.Neighbors;
    case 'all':
      return CandidateStrategy.All;
    case 'random':
      return CandidateStrategy.RandomAny;
    case 'random-neighbor':
      return CandidateStrategy.RandomNeighbor;
    default:
      return CandidateStrategy.Neighbors;
  }
}

function normalizeOptions(options = {}) {
  const directed = !!options.directed;
  const randomSeed = Number.isFinite(options.randomSeed) ? options.randomSeed : 42;
  const maxLevels = Number.isFinite(options.maxLevels) ? options.maxLevels : DEFAULT_MAX_LEVELS;
  const maxLocalPasses = Number.isFinite(options.maxLocalPasses)
    ? options.maxLocalPasses
    : DEFAULT_MAX_LOCAL_PASSES;
  const allowNewCommunity = !!options.allowNewCommunity;
  const candidateStrategyCode = resolveCandidateStrategy(options);
  const quality = (options.quality || 'modularity').toLowerCase();
  const resolution = typeof options.resolution === 'number' ? options.resolution : 1.0;
  const refine = options.refine !== false;
  const preserveLabels = options.preserveLabels;
  const maxCommunitySize = Number.isFinite(options.maxCommunitySize)
    ? options.maxCommunitySize
    : Infinity;
  return {
    directed,
    randomSeed,
    maxLevels,
    maxLocalPasses,
    allowNewCommunity,
    candidateStrategyCode,
    quality,
    resolution,
    refine,
    preserveLabels,
    maxCommunitySize,
    fixedNodes: options.fixedNodes,
  };
}

function renumberCommunities(partition, preserveLabels) {
  if (preserveLabels && preserveLabels instanceof Map) {
    partition.compactCommunityIds({ preserveMap: preserveLabels });
  } else if (preserveLabels === true) {
    partition.compactCommunityIds({ keepOldOrder: true });
  } else {
    partition.compactCommunityIds();
  }
}
