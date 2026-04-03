/**
 * Core Leiden/Louvain community detection optimiser.
 * Vendored from ngraph.leiden (MIT) — adapted to use CodeGraph + local RNG.
 */

import { CodeGraph } from '../../model.js';
import type { EdgeEntry, GraphAdapter, GraphAdapterOptions, InEdgeEntry } from './adapter.js';
import { makeGraphAdapter } from './adapter.js';
import { diffCPM } from './cpm.js';
import { diffModularity } from './modularity.js';
import type { Partition } from './partition.js';
import { makePartition } from './partition.js';
import { createRng } from './rng.js';

// Mirrored in DEFAULTS.community (src/infrastructure/config.js) for user override
// via .codegraphrc.json. Callers (e.g. louvain.ts) can pass overrides through options.
const DEFAULT_MAX_LEVELS: number = 50;
const DEFAULT_MAX_LOCAL_PASSES: number = 20;
const GAIN_EPSILON: number = 1e-12;

/** Pre-allocated scratch buffers for refinement candidate collection. */
interface RefinementScratch {
  candC: Int32Array;
  candGain: Float64Array;
  candWeight: Float64Array;
}

const CandidateStrategy = {
  Neighbors: 0,
  All: 1,
  RandomAny: 2,
  RandomNeighbor: 3,
} as const;

type CandidateStrategyCode = (typeof CandidateStrategy)[keyof typeof CandidateStrategy];

export interface LeidenOptions {
  directed?: boolean;
  randomSeed?: number;
  maxLevels?: number;
  maxLocalPasses?: number;
  allowNewCommunity?: boolean;
  candidateStrategy?: 'neighbors' | 'all' | 'random' | 'random-neighbor';
  quality?: string;
  resolution?: number;
  refine?: boolean;
  preserveLabels?: boolean | Map<number, number>;
  maxCommunitySize?: number;
  refinementTheta?: number;
  fixedNodes?: Set<string> | string[];
  linkWeight?: GraphAdapterOptions['linkWeight'];
  nodeSize?: GraphAdapterOptions['nodeSize'];
  baseNodeIds?: string[];
}

export interface NormalizedOptions {
  directed: boolean;
  randomSeed: number;
  maxLevels: number;
  maxLocalPasses: number;
  allowNewCommunity: boolean;
  candidateStrategyCode: CandidateStrategyCode;
  quality: string;
  resolution: number;
  refine: boolean;
  preserveLabels: boolean | Map<number, number> | undefined;
  maxCommunitySize: number;
  refinementTheta: number;
  fixedNodes: Set<string> | string[] | undefined;
}

export interface LevelEntry {
  graph: GraphAdapter;
  partition: Partition;
}

export interface LouvainResult {
  graph: GraphAdapter;
  partition: Partition;
  levels: LevelEntry[];
  originalToCurrent: Int32Array;
  originalNodeIds: string[];
  baseGraph: GraphAdapter;
}

export function runLouvainUndirectedModularity(
  graph: CodeGraph,
  optionsInput: LeidenOptions = {},
): LouvainResult {
  const options: NormalizedOptions = normalizeOptions(optionsInput);
  let currentGraph: CodeGraph = graph;
  const levels: LevelEntry[] = [];
  const rngSource = createRng(options.randomSeed);
  const random: () => number = () => rngSource.nextDouble();

  const baseGraphAdapter: GraphAdapter = makeGraphAdapter(currentGraph, {
    directed: options.directed,
    ...optionsInput,
  });
  const origN: number = baseGraphAdapter.n;
  const originalToCurrent = new Int32Array(origN);
  for (let i = 0; i < origN; i++) originalToCurrent[i] = i;

  let fixedNodeMask: Uint8Array | null = null;
  if (options.fixedNodes) {
    const fixed = new Uint8Array(origN);
    const asSet: Set<string> =
      options.fixedNodes instanceof Set ? options.fixedNodes : new Set(options.fixedNodes);
    for (const id of asSet) {
      const idx = baseGraphAdapter.idToIndex.get(String(id));
      if (idx != null) fixed[idx] = 1;
    }
    fixedNodeMask = fixed;
  }

  for (let level = 0; level < options.maxLevels; level++) {
    const graphAdapter: GraphAdapter =
      level === 0
        ? baseGraphAdapter
        : makeGraphAdapter(currentGraph, { directed: options.directed, ...optionsInput });
    const partition: Partition = makePartition(graphAdapter);
    partition.graph = graphAdapter;
    partition.initializeAggregates();

    const order = new Int32Array(graphAdapter.n);
    for (let i = 0; i < graphAdapter.n; i++) order[i] = i;

    let improved: boolean = true;
    let localPasses: number = 0;
    const strategyCode: CandidateStrategyCode = options.candidateStrategyCode;
    while (improved) {
      improved = false;
      localPasses++;
      shuffleArrayInPlace(order, random);
      for (let idx = 0; idx < order.length; idx++) {
        const nodeIndex: number = order[idx]!;
        if (level === 0 && fixedNodeMask && fixedNodeMask[nodeIndex]) continue;
        const candidateCount: number = partition.accumulateNeighborCommunityEdgeWeights(nodeIndex);
        const { bestCommunityId, bestGain } = findBestCommunityMove(
          partition,
          graphAdapter,
          nodeIndex,
          candidateCount,
          strategyCode,
          options,
          random,
        );
        if (bestCommunityId !== partition.nodeCommunity[nodeIndex]! && bestGain > GAIN_EPSILON) {
          partition.moveNodeToCommunity(nodeIndex, bestCommunityId);
          improved = true;
        }
      }
      if (localPasses >= options.maxLocalPasses) break;
    }

    renumberCommunities(partition, options.preserveLabels);

    let effectivePartition: Partition = partition;
    if (options.refine) {
      const refined: Partition = refineWithinCoarseCommunities(
        graphAdapter,
        partition,
        random,
        options,
        level === 0 ? fixedNodeMask : null,
      );
      // Post-refinement: split any disconnected communities into their
      // connected components. This is the cheap O(V+E) alternative to
      // checking gamma-connectedness on every candidate during refinement.
      // A disconnected community violates even basic connectivity, so
      // splitting is always correct.
      splitDisconnectedCommunities(graphAdapter, refined);
      renumberCommunities(refined, options.preserveLabels);
      effectivePartition = refined;
    }

    levels.push({ graph: graphAdapter, partition: effectivePartition });
    const fineToCoarse: Int32Array = effectivePartition.nodeCommunity;
    for (let i = 0; i < originalToCurrent.length; i++) {
      originalToCurrent[i] = fineToCoarse[originalToCurrent[i]!]!;
    }

    // Terminate when no further coarsening is possible. Check both the
    // move-phase partition (did the greedy phase find merges?) and the
    // effective partition that feeds buildCoarseGraph (would coarsening
    // actually reduce the graph?). When refine is enabled the refined
    // partition starts from singletons and may have more communities than
    // the move phase found, so checking only effectivePartition would
    // cause premature termination.
    if (
      partition.communityCount === graphAdapter.n &&
      effectivePartition.communityCount === graphAdapter.n
    )
      break;
    currentGraph = buildCoarseGraph(graphAdapter, effectivePartition);
  }

  const last: LevelEntry = levels[levels.length - 1]!;
  return {
    graph: last.graph,
    partition: last.partition,
    levels,
    originalToCurrent,
    originalNodeIds: baseGraphAdapter.nodeIds,
    baseGraph: baseGraphAdapter,
  };
}

/**
 * Evaluate all candidate communities for a node and return the best move.
 * Encapsulates the four candidate-selection strategies (All, RandomAny,
 * RandomNeighbor, Neighbors) and the optional new-community probe.
 */
function findBestCommunityMove(
  partition: Partition,
  graphAdapter: GraphAdapter,
  nodeIndex: number,
  candidateCount: number,
  strategyCode: CandidateStrategyCode,
  options: NormalizedOptions,
  random: () => number,
): { bestCommunityId: number; bestGain: number } {
  let bestCommunityId: number = partition.nodeCommunity[nodeIndex]!;
  let bestGain: number = 0;
  const maxCommunitySize: number = options.maxCommunitySize;

  const evaluateCandidate = (communityId: number): void => {
    if (communityId === partition.nodeCommunity[nodeIndex]!) return;
    if (
      maxCommunitySize < Infinity &&
      partition.getCommunityTotalSize(communityId) + graphAdapter.size[nodeIndex]! >
        maxCommunitySize
    )
      return;
    const gain: number = computeQualityGain(partition, nodeIndex, communityId, options);
    if (gain > bestGain) {
      bestGain = gain;
      bestCommunityId = communityId;
    }
  };

  if (strategyCode === CandidateStrategy.All) {
    for (let communityId = 0; communityId < partition.communityCount; communityId++) {
      evaluateCandidate(communityId);
    }
  } else if (strategyCode === CandidateStrategy.RandomAny) {
    const tries: number = Math.min(10, Math.max(1, partition.communityCount));
    for (let trialIndex = 0; trialIndex < tries; trialIndex++) {
      evaluateCandidate((random() * partition.communityCount) | 0);
    }
  } else if (strategyCode === CandidateStrategy.RandomNeighbor) {
    const tries: number = Math.min(10, Math.max(1, candidateCount));
    for (let trialIndex = 0; trialIndex < tries; trialIndex++) {
      evaluateCandidate(partition.getCandidateCommunityAt((random() * candidateCount) | 0));
    }
  } else {
    for (let trialIndex = 0; trialIndex < candidateCount; trialIndex++) {
      evaluateCandidate(partition.getCandidateCommunityAt(trialIndex));
    }
  }

  if (options.allowNewCommunity) {
    const newCommunityId: number = partition.communityCount;
    const gain: number = computeQualityGain(partition, nodeIndex, newCommunityId, options);
    if (gain > bestGain) {
      bestGain = gain;
      bestCommunityId = newCommunityId;
    }
  }

  return { bestCommunityId, bestGain };
}

/**
 * Run a BFS on the subgraph induced by `inCommunity` starting from `start`.
 * Returns the list of visited nodes. Works on both directed (weak connectivity
 * via both outEdges and inEdges) and undirected graphs.
 */
function bfsComponent(
  g: GraphAdapter,
  start: number,
  inCommunity: Uint8Array,
  visited: Uint8Array,
): number[] {
  const queue: number[] = [start];
  visited[start] = 1;
  let head: number = 0;
  while (head < queue.length) {
    const v: number = queue[head++]!;
    const out: EdgeEntry[] = g.outEdges[v]!;
    for (let k = 0; k < out.length; k++) {
      const w: number = out[k]!.to;
      if (inCommunity[w] && !visited[w]) {
        visited[w] = 1;
        queue.push(w);
      }
    }
    if (g.directed) {
      const inc: InEdgeEntry[] = g.inEdges[v]!;
      for (let k = 0; k < inc.length; k++) {
        const w: number = inc[k]!.from;
        if (inCommunity[w] && !visited[w]) {
          visited[w] = 1;
          queue.push(w);
        }
      }
    }
  }
  return queue;
}

// Build a coarse graph where each community becomes a single node.
// Self-loops (g.selfLoop[]) don't need separate handling here because they
// are already present in g.outEdges (directed path keeps them in both arrays).
// When the coarse graph is fed back to makeGraphAdapter at the next level,
// the adapter re-detects cu===cu edges as self-loops and populates selfLoop[].
function buildCoarseGraph(g: GraphAdapter, p: Partition): CodeGraph {
  const coarse = new CodeGraph({ directed: g.directed });
  for (let c = 0; c < p.communityCount; c++) {
    coarse.addNode(String(c), { size: p.communityTotalSize[c]! });
  }
  const acc = new Map<string, number>();
  for (let i = 0; i < g.n; i++) {
    const cu: number = p.nodeCommunity[i]!;
    const list: EdgeEntry[] = g.outEdges[i]!;
    for (let k = 0; k < list.length; k++) {
      const j: number = list[k]!.to;
      const w: number = list[k]!.w;
      const cv: number = p.nodeCommunity[j]!;
      // Undirected: each non-self edge (i,j) appears in both outEdges[i] and
      // outEdges[j]. For intra-community edges (cu===cv), skip the reverse to
      // avoid inflating the coarse self-loop weight by 2x.
      if (!g.directed && cu === cv && j < i) continue;
      const key = `${cu}:${cv}`;
      acc.set(key, (acc.get(key) || 0) + w);
    }
  }
  for (const [key, w] of acc.entries()) {
    const parts = key.split(':');
    coarse.addEdge(parts[0]!, parts[1]!, { weight: w });
  }
  return coarse;
}

/**
 * Collect eligible candidate communities for node `v` during refinement.
 * A candidate must: (a) be in the same macro-community, (b) respect the size
 * limit, and (c) produce a positive quality gain above GAIN_EPSILON.
 * Returns the number of collected candidates written into `scratch`.
 */
function collectRefinementCandidates(
  p: Partition,
  g: GraphAdapter,
  v: number,
  touchedCount: number,
  macroV: number,
  commMacro: Int32Array,
  maxSize: number,
  opts: NormalizedOptions,
  scratch: RefinementScratch,
): number {
  let candLen: number = 0;
  for (let t = 0; t < touchedCount; t++) {
    const c: number = p.getCandidateCommunityAt(t);
    if (c === p.nodeCommunity[v]!) continue;
    if (commMacro[c]! !== macroV) continue;
    if (maxSize < Infinity) {
      const nextSize: number = p.getCommunityTotalSize(c) + g.size[v]!;
      if (nextSize > maxSize) continue;
    }
    const gain: number = computeQualityGain(p, v, c, opts);
    if (gain > GAIN_EPSILON) {
      scratch.candC[candLen] = c;
      scratch.candGain[candLen] = gain;
      candLen++;
    }
  }
  return candLen;
}

/**
 * Boltzmann probabilistic selection from collected candidates (Algorithm 3).
 * Returns the chosen community ID, or -1 if the node should stay as singleton.
 *
 * p(v, C) is proportional to exp(deltaH / theta), with the "stay as singleton"
 * option (deltaH = 0) included. For numerical stability, the max gain is
 * subtracted before exponentiation.
 */
function boltzmannSelectCandidate(
  candLen: number,
  theta: number,
  rng: () => number,
  scratch: RefinementScratch,
): number {
  let maxGain: number = 0;
  for (let i = 0; i < candLen; i++) {
    if (scratch.candGain[i]! > maxGain) maxGain = scratch.candGain[i]!;
  }
  // "Stay as singleton" weight: exp((0 - maxGain) / theta)
  const stayWeight: number = Math.exp((0 - maxGain) / theta);
  let totalWeight: number = stayWeight;
  for (let i = 0; i < candLen; i++) {
    scratch.candWeight[i] = Math.exp((scratch.candGain[i]! - maxGain) / theta);
    totalWeight += scratch.candWeight[i]!;
  }

  const r: number = rng() * totalWeight;
  if (r < stayWeight) return -1; // node stays as singleton

  let cumulative: number = stayWeight;
  for (let i = 0; i < candLen; i++) {
    cumulative += scratch.candWeight[i]!;
    if (r < cumulative) return scratch.candC[i]!;
  }
  return scratch.candC[candLen - 1]!; // fallback
}

/**
 * True Leiden refinement phase (Algorithm 3, Traag et al. 2019).
 *
 * Key properties that distinguish this from Louvain-style refinement:
 *
 * 1. Singleton start — each node begins in its own community.
 * 2. Singleton guard — only nodes still in singleton communities are
 *    considered for merging. Once a node joins a non-singleton community
 *    it is locked for the remainder of the pass. This prevents oscillation
 *    and is essential for the gamma-connectedness guarantee.
 * 3. Single pass — one randomized sweep through all nodes, not an
 *    iterative loop until convergence (that would be Louvain behavior).
 * 4. Probabilistic selection — candidate communities are sampled from
 *    a Boltzmann distribution p(v, C) proportional to exp(deltaH / theta),
 *    with the "stay as singleton" option (deltaH = 0) included in the
 *    distribution. This means a node may probabilistically choose to remain
 *    alone even when positive-gain merges exist.
 *
 * theta (refinementTheta) controls temperature: lower = more deterministic
 * (approaches greedy), higher = more exploratory. Determinism is preserved
 * via the seeded PRNG — same seed produces the same assignments.
 */
/**
 * Collect eligible candidate communities for node `v` during refinement.
 * A candidate must: (a) be in the same macro-community, (b) respect the size
 * limit, and (c) produce a positive quality gain above GAIN_EPSILON.
 * Returns the number of collected candidates written into `scratch`.
 */
function collectRefinementCandidates(
  p: Partition,
  g: GraphAdapter,
  v: number,
  touchedCount: number,
  macroV: number,
  commMacro: Int32Array,
  maxSize: number,
  opts: NormalizedOptions,
  scratch: RefinementScratch,
): number {
  let candLen: number = 0;
  for (let t = 0; t < touchedCount; t++) {
    const c: number = p.getCandidateCommunityAt(t);
    if (c === p.nodeCommunity[v]!) continue;
    if (commMacro[c]! !== macroV) continue;
    if (maxSize < Infinity) {
      const nextSize: number = p.getCommunityTotalSize(c) + g.size[v]!;
      if (nextSize > maxSize) continue;
    }
    const gain: number = computeQualityGain(p, v, c, opts);
    if (gain > GAIN_EPSILON) {
      scratch.candC[candLen] = c;
      scratch.candGain[candLen] = gain;
      candLen++;
    }
  }
  return candLen;
}

/**
 * Boltzmann probabilistic selection from collected candidates (Algorithm 3).
 * Returns the chosen community ID, or -1 if the node should stay as singleton.
 *
 * p(v, C) is proportional to exp(deltaH / theta), with the "stay as singleton"
 * option (deltaH = 0) included. For numerical stability, the max gain is
 * subtracted before exponentiation.
 */
function boltzmannSelectCandidate(
  candLen: number,
  theta: number,
  rng: () => number,
  scratch: RefinementScratch,
): number {
  let maxGain: number = 0;
  for (let i = 0; i < candLen; i++) {
    if (scratch.candGain[i]! > maxGain) maxGain = scratch.candGain[i]!;
  }
  // "Stay as singleton" weight: exp((0 - maxGain) / theta)
  const stayWeight: number = Math.exp((0 - maxGain) / theta);
  let totalWeight: number = stayWeight;
  for (let i = 0; i < candLen; i++) {
    scratch.candWeight[i] = Math.exp((scratch.candGain[i]! - maxGain) / theta);
    totalWeight += scratch.candWeight[i]!;
  }

  const r: number = rng() * totalWeight;
  if (r < stayWeight) return -1; // node stays as singleton

  let cumulative: number = stayWeight;
  for (let i = 0; i < candLen; i++) {
    cumulative += scratch.candWeight[i]!;
    if (r < cumulative) return scratch.candC[i]!;
  }
  return scratch.candC[candLen - 1]!; // fallback
}

function refineWithinCoarseCommunities(
  g: GraphAdapter,
  basePart: Partition,
  rng: () => number,
  opts: NormalizedOptions,
  fixedMask0: Uint8Array | null,
): Partition {
  const p: Partition = makePartition(g);
  p.initializeAggregates();
  p.graph = g;
  const macro: Int32Array = basePart.nodeCommunity;
  const commMacro = new Int32Array(p.communityCount);
  for (let i = 0; i < p.communityCount; i++) commMacro[i] = macro[i]!;

  const theta: number = typeof opts.refinementTheta === 'number' ? opts.refinementTheta : 1.0;
  if (theta <= 0) throw new RangeError(`refinementTheta must be > 0 (got ${theta})`);

  // Single pass in random order (Algorithm 3, step 2).
  const order = new Int32Array(g.n);
  for (let i = 0; i < g.n; i++) order[i] = i;
  shuffleArrayInPlace(order, rng);

  // Pre-allocate flat arrays for candidate collection to avoid per-node GC pressure.
  const scratch: RefinementScratch = {
    candC: new Int32Array(g.n),
    candGain: new Float64Array(g.n),
    candWeight: new Float64Array(g.n),
  };
  const maxSize: number = Number.isFinite(opts.maxCommunitySize) ? opts.maxCommunitySize : Infinity;

  for (let idx = 0; idx < order.length; idx++) {
    const v: number = order[idx]!;
    if (fixedMask0?.[v]) continue;

    // Singleton guard: only move nodes still alone in their community.
    if (p.getCommunityNodeCount(p.nodeCommunity[v]!) > 1) continue;

    const macroV: number = macro[v]!;
    const touchedCount: number = p.accumulateNeighborCommunityEdgeWeights(v);
    const candLen: number = collectRefinementCandidates(
      p,
      g,
      v,
      touchedCount,
      macroV,
      commMacro,
      maxSize,
      opts,
      scratch,
    );
    if (candLen === 0) continue;

    const chosenC: number = boltzmannSelectCandidate(candLen, theta, rng, scratch);
    if (chosenC >= 0) p.moveNodeToCommunity(v, chosenC);
  }
  return p;
}

/**
 * Post-refinement connectivity check. For each community, run a BFS on
 * the subgraph induced by its members (using the adapter's outEdges).
 * If a community has multiple connected components, assign secondary
 * components to new community IDs, then reinitialize aggregates once.
 *
 * O(V+E) total since communities partition V.
 *
 * This replaces the per-candidate gamma-connectedness check from the paper
 * with a cheaper post-step that catches the most important violation
 * (disconnected subcommunities).
 */
function splitDisconnectedCommunities(g: GraphAdapter, partition: Partition): void {
  const n: number = g.n;
  const nc: Int32Array = partition.nodeCommunity;
  const members: number[][] = partition.getCommunityMembers();
  let nextC: number = partition.communityCount;
  let didSplit: boolean = false;

  const visited = new Uint8Array(n);
  const inCommunity = new Uint8Array(n);

  for (let c = 0; c < members.length; c++) {
    const nodes: number[] = members[c]!;
    if (nodes.length <= 1) continue;

    for (let i = 0; i < nodes.length; i++) inCommunity[nodes[i]!] = 1;

    let componentCount: number = 0;
    for (let i = 0; i < nodes.length; i++) {
      const start: number = nodes[i]!;
      if (visited[start]) continue;
      componentCount++;

      const component: number[] = bfsComponent(g, start, inCommunity, visited);

      if (componentCount > 1) {
        // Secondary component — assign new community ID directly.
        const newC: number = nextC++;
        for (let q = 0; q < component.length; q++) nc[component[q]!] = newC;
        didSplit = true;
      }
    }

    for (let i = 0; i < nodes.length; i++) {
      inCommunity[nodes[i]!] = 0;
      visited[nodes[i]!] = 0;
    }
  }

  if (didSplit) {
    // Grow the partition's typed arrays to accommodate new community IDs,
    // then recompute all aggregates from the updated nodeCommunity array.
    partition.resizeCommunities(nextC);
    partition.initializeAggregates();
  }
}

function computeQualityGain(
  partition: Partition,
  v: number,
  c: number,
  opts: NormalizedOptions,
): number {
  if (!partition.graph) {
    throw new Error('partition.graph must be set before computeQualityGain');
  }
  const quality: string = (opts.quality || 'modularity').toLowerCase();
  const gamma: number = typeof opts.resolution === 'number' ? opts.resolution : 1.0;
  if (quality === 'cpm') {
    return diffCPM(partition, partition.graph, v, c, gamma);
  }
  // diffModularity dispatches to diffModularityDirected internally when g.directed is true
  return diffModularity(partition, partition.graph, v, c, gamma);
}

function shuffleArrayInPlace(arr: Int32Array, rng: () => number = Math.random): Int32Array {
  for (let i = arr.length - 1; i > 0; i--) {
    const j: number = Math.floor(rng() * (i + 1));
    const t: number = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
  return arr;
}

function resolveCandidateStrategy(options: LeidenOptions): CandidateStrategyCode {
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

function normalizeOptions(options: LeidenOptions = {}): NormalizedOptions {
  const directed: boolean = !!options.directed;
  const randomSeed: number = Number.isFinite(options.randomSeed)
    ? (options.randomSeed as number)
    : 42;
  const maxLevels: number = Number.isFinite(options.maxLevels)
    ? (options.maxLevels as number)
    : DEFAULT_MAX_LEVELS;
  const maxLocalPasses: number = Number.isFinite(options.maxLocalPasses)
    ? (options.maxLocalPasses as number)
    : DEFAULT_MAX_LOCAL_PASSES;
  const allowNewCommunity: boolean = !!options.allowNewCommunity;
  const candidateStrategyCode: CandidateStrategyCode = resolveCandidateStrategy(options);
  const quality: string = (options.quality || 'modularity').toLowerCase();
  const resolution: number = typeof options.resolution === 'number' ? options.resolution : 1.0;
  const refine: boolean = options.refine !== false;
  const preserveLabels = options.preserveLabels;
  const maxCommunitySize: number = Number.isFinite(options.maxCommunitySize)
    ? (options.maxCommunitySize as number)
    : Infinity;
  const refinementTheta: number =
    typeof options.refinementTheta === 'number' ? options.refinementTheta : 1.0;
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
    refinementTheta,
    fixedNodes: options.fixedNodes,
  };
}

function renumberCommunities(
  partition: Partition,
  preserveLabels: boolean | Map<number, number> | undefined,
): void {
  if (preserveLabels && preserveLabels instanceof Map) {
    partition.compactCommunityIds({ preserveMap: preserveLabels });
  } else if (preserveLabels === true) {
    partition.compactCommunityIds({ keepOldOrder: true });
  } else {
    partition.compactCommunityIds();
  }
}
