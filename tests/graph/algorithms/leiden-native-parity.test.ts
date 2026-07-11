/**
 * Native/JS Leiden parity tests (issue #1804).
 *
 * Before this fix, the native path ran classic Louvain while the JS
 * fallback ran Leiden — two genuinely different algorithms, so
 * `codegraph communities`/`--drift` reported different partitions purely
 * based on whether the native addon loaded. Both engines now run Leiden
 * (`crates/codegraph-core/src/graph/algorithms/leiden.rs` is a Rust port of
 * `../leiden/*`), so this suite asserts they produce byte-identical
 * community assignments and modularity scores — not just "similar" ones —
 * across a variety of graph shapes, seeds, and resolutions.
 *
 * Skipped entirely when the native addon isn't available in this
 * environment (nothing to compare against).
 */

import { describe, expect, it } from 'vitest';
import { detectClusters } from '../../../src/graph/algorithms/leiden/index.js';
import { louvainCommunities } from '../../../src/graph/algorithms/louvain.js';
import { CodeGraph } from '../../../src/graph/model.js';
import { getNative, isNativeAvailable } from '../../../src/infrastructure/native.js';

// Guards against a stale/cached native addon that loads but predates the
// `leidenCommunities` binding (#1804 review): without the export check,
// assertParity would silently degrade to a JS-vs-JS comparison and
// runNativeDirect's non-null assertion would throw a confusing TypeError.
const hasNative = isNativeAvailable() && typeof getNative()?.leidenCommunities === 'function';

/** Sorted "node:community" pairs — stable snapshot for deep-equal comparison. */
function snapshot(assignments: Map<string, number>): string[] {
  return [...assignments.entries()].map(([node, community]) => `${node}:${community}`).sort();
}

/** Run the JS Leiden path directly (bypassing louvainCommunities' native preference). */
function runJS(
  graph: CodeGraph,
  opts: { resolution?: number; randomSeed?: number } = {},
): { assignments: Map<string, number>; modularity: number } {
  const result = detectClusters(graph, {
    resolution: opts.resolution ?? 1.0,
    randomSeed: opts.randomSeed ?? 42,
    directed: false,
  });
  const assignments = new Map<string, number>();
  for (const [id] of graph.nodes()) {
    const cls = result.getClass(id);
    if (cls != null) assignments.set(id, cls);
  }
  return { assignments, modularity: result.quality() };
}

/** Run the native Leiden binding directly, bypassing louvainCommunities' hardcoded seed. */
function runNativeDirect(
  graph: CodeGraph,
  opts: { resolution?: number; randomSeed?: number } = {},
): { assignments: Map<string, number>; modularity: number } {
  const native = getNative();
  const edges = graph.toEdgeArray();
  const nodeIds = graph.nodeIds();
  const result = native.leidenCommunities!(
    edges,
    nodeIds,
    opts.resolution ?? 1.0,
    opts.randomSeed ?? 42,
  );
  const assignments = new Map<string, number>();
  for (const entry of result.assignments) assignments.set(entry.node, entry.community);
  return { assignments, modularity: result.modularity };
}

/**
 * Assert parity through the *public* `louvainCommunities` API (which prefers
 * native and hardcodes randomSeed=42 for both engines — matching real
 * `codegraph communities` usage). Only `resolution` is a real caller-facing
 * knob here.
 */
function assertParity(graph: CodeGraph, opts: { resolution?: number } = {}) {
  const native = louvainCommunities(graph, { resolution: opts.resolution });
  const js = runJS(graph, { resolution: opts.resolution });
  expect(snapshot(native.assignments)).toEqual(snapshot(js.assignments));
  expect(native.modularity).toBe(js.modularity);
}

/**
 * Assert parity by calling the native binding and the JS algorithm directly
 * with an explicit seed, bypassing `louvainCommunities`' hardcoded seed —
 * used to verify the underlying algorithms agree across seeds, independent
 * of what the current public wrapper happens to expose.
 */
function assertParityDirect(graph: CodeGraph, opts: { resolution?: number; randomSeed?: number }) {
  const native = runNativeDirect(graph, opts);
  const js = runJS(graph, opts);
  expect(snapshot(native.assignments)).toEqual(snapshot(js.assignments));
  expect(native.modularity).toBe(js.modularity);
}

function buildTwoClusterGraph(): CodeGraph {
  const g = new CodeGraph();
  g.addEdge('a', 'b');
  g.addEdge('b', 'c');
  g.addEdge('c', 'a');
  g.addEdge('x', 'y');
  g.addEdge('y', 'z');
  g.addEdge('z', 'x');
  g.addEdge('c', 'x');
  return g;
}

/** Deterministic pseudo-random clustered graph: numClusters loosely-connected
 * cliques plus sparse cross-links, large enough to force multi-level
 * coarsening (the code path that originally diverged — see leiden.rs's
 * `build_coarse_graph` doc). */
function buildClusteredGraph(
  numClusters: number,
  clusterSize: number,
  crossLinkProb: number,
  seedStr: string,
): CodeGraph {
  const g = new CodeGraph();
  let s = 0;
  for (let i = 0; i < seedStr.length; i++) s = (s * 31 + seedStr.charCodeAt(i)) & 0x7fffffff;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };

  const clusters: string[][] = [];
  for (let c = 0; c < numClusters; c++) {
    const nodes: string[] = [];
    for (let i = 0; i < clusterSize; i++) {
      const id = `c${c}n${i}`;
      nodes.push(id);
      g.addNode(id);
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (rnd() < 0.5) g.addEdge(nodes[i]!, nodes[j]!);
      }
    }
    clusters.push(nodes);
  }
  for (let c1 = 0; c1 < numClusters; c1++) {
    for (let c2 = c1 + 1; c2 < numClusters; c2++) {
      for (const a of clusters[c1]!) {
        for (const b of clusters[c2]!) {
          if (rnd() < crossLinkProb) g.addEdge(a, b);
        }
      }
    }
  }
  return g;
}

describe.skipIf(!hasNative)('native/JS Leiden parity (issue #1804)', () => {
  it('matches on a small two-cluster graph', () => {
    assertParity(buildTwoClusterGraph());
  });

  it('matches on a graph with reciprocal (mutual-import-style) edges', () => {
    // Both directions present between several node pairs -- exercises the
    // undirected symmetrization/averaging path (adapter.ts's
    // aggregateUndirectedPairs), a second, independent source of
    // native/JS divergence pre-#1804 (classic Louvain summed reciprocal
    // edges instead of averaging them).
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'a');
    g.addEdge('b', 'c');
    g.addEdge('c', 'b');
    g.addEdge('c', 'd');
    g.addEdge('d', 'c');
    assertParity(g);
  });

  it('matches on a graph with self-loops', () => {
    // Unweighted self-loop only: custom edge weights are out of scope for
    // the native binding (GraphEdge carries no weight field, and none of
    // louvainCommunities' real call sites ever set one — see leiden.rs's
    // module doc). This still guards the actual regression: the classic
    // Louvain implementation this file replaces dropped self-loops
    // entirely instead of counting them once toward degree/modularity.
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'c');
    g.addEdge('c', 'a');
    g.addEdge('a', 'a');
    assertParity(g);
  });

  it('matches on a graph forcing multi-level coarsening', () => {
    const g = buildClusteredGraph(15, 4, 0.02, 'parity-seed-1');
    assertParity(g);
  });

  it('matches across multiple resolutions via the public API on a multi-level graph', () => {
    const g = buildClusteredGraph(10, 6, 0.03, 'parity-seed-2');
    for (const resolution of [0.5, 0.8, 1.0, 1.5, 2.0]) {
      assertParity(g, { resolution });
    }
  });

  it('matches across multiple seeds (direct engine calls) on a multi-level graph', () => {
    // louvainCommunities hardcodes randomSeed=42 for both engines (it is not
    // a caller-facing knob today), so this drives the native binding and
    // detectClusters directly to confirm the underlying algorithms agree
    // for any seed, not just the one value the current wrapper ever passes.
    const g = buildClusteredGraph(10, 6, 0.03, 'parity-seed-2');
    for (const randomSeed of [1, 7, 42, 999, 2026]) {
      assertParityDirect(g, { randomSeed });
    }
  });

  it('matches with maxLevels/maxLocalPasses/refinementTheta/capacityGrowthFactor overrides', () => {
    const g = buildClusteredGraph(8, 5, 0.03, 'parity-seed-3');
    const native = louvainCommunities(g, {
      resolution: 1.0,
      maxLevels: 3,
      maxLocalPasses: 5,
      refinementTheta: 0.5,
      capacityGrowthFactor: 1.2,
    });
    const jsResult = detectClusters(g, {
      resolution: 1.0,
      randomSeed: 42,
      directed: false,
      maxLevels: 3,
      maxLocalPasses: 5,
      refinementTheta: 0.5,
      capacityGrowthFactor: 1.2,
    });
    const jsAssignments = new Map<string, number>();
    for (const [id] of g.nodes()) {
      const cls = jsResult.getClass(id);
      if (cls != null) jsAssignments.set(id, cls);
    }
    expect(snapshot(native.assignments)).toEqual(snapshot(jsAssignments));
    expect(native.modularity).toBe(jsResult.quality());
  });
});
