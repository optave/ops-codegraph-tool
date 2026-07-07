/**
 * Community detection via native Rust Leiden or vendored TS Leiden.
 * Maintains backward-compatible API: { assignments: Map<string, number>, modularity: number }
 *
 * Both the native path and the JS fallback run the same algorithm — Leiden
 * (always undirected, `directed: false`, modularity quality). Before issue
 * #1804, the native path ran classic Louvain while the JS fallback ran
 * Leiden: two genuinely different algorithms with different guarantees
 * (Leiden avoids Louvain's disconnected-community defect), so `codegraph
 * communities`/`--drift` reported different partitions purely based on
 * whether the native addon loaded. `crates/codegraph-core/src/graph/algorithms/leiden.rs`
 * is a faithful Rust port of `./leiden/*` covering exactly the option
 * surface `LouvainOptions` exposes below (undirected, modularity-only,
 * "neighbors" candidate strategy, refine always on) — see that file's module
 * doc for the precise (deliberately narrower) subset ported and the
 * follow-up issue tracking the rest.
 */

import { loadNative } from '../../infrastructure/native.js';
import type { CodeGraph } from '../model.js';
import type { DetectClustersResult } from './leiden/index.js';
import { detectClusters } from './leiden/index.js';

/** Default random seed for deterministic community detection. */
const DEFAULT_RANDOM_SEED = 42;

export interface LouvainOptions {
  resolution?: number;
  maxLevels?: number;
  maxLocalPasses?: number;
  refinementTheta?: number;
  capacityGrowthFactor?: number;
}

export interface LouvainResult {
  assignments: Map<string, number>;
  modularity: number;
}

export function louvainCommunities(graph: CodeGraph, opts: LouvainOptions = {}): LouvainResult {
  if (graph.nodeCount === 0 || graph.edgeCount === 0) {
    return { assignments: new Map(), modularity: 0 };
  }

  const resolution: number = opts.resolution ?? 1.0;

  const native = loadNative();
  if (native?.leidenCommunities) {
    const edges = graph.toEdgeArray();
    const nodeIds = graph.nodeIds();
    const result = native.leidenCommunities(
      edges,
      nodeIds,
      resolution,
      DEFAULT_RANDOM_SEED,
      opts.maxLevels,
      opts.maxLocalPasses,
      opts.refinementTheta,
      opts.capacityGrowthFactor,
    );
    const assignments = new Map<string, number>();
    for (const entry of result.assignments) {
      assignments.set(entry.node, entry.community);
    }
    return { assignments, modularity: result.modularity };
  }

  return louvainJS(graph, opts, resolution);
}

/** JS fallback using the vendored Leiden algorithm. */
function louvainJS(graph: CodeGraph, opts: LouvainOptions, resolution: number): LouvainResult {
  const result: DetectClustersResult = detectClusters(graph, {
    resolution,
    randomSeed: DEFAULT_RANDOM_SEED,
    directed: false,
    ...(opts.maxLevels != null && { maxLevels: opts.maxLevels }),
    ...(opts.maxLocalPasses != null && { maxLocalPasses: opts.maxLocalPasses }),
    ...(opts.refinementTheta != null && { refinementTheta: opts.refinementTheta }),
    ...(opts.capacityGrowthFactor != null && { capacityGrowthFactor: opts.capacityGrowthFactor }),
  });

  const assignments = new Map<string, number>();
  for (const [id] of graph.nodes()) {
    const cls = result.getClass(id);
    if (cls != null) assignments.set(id, cls);
  }

  return { assignments, modularity: result.quality() };
}
