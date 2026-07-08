import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { louvainCommunities } from '../../../src/graph/algorithms/louvain.js';
import { CodeGraph } from '../../../src/graph/model.js';
import { setVerbose } from '../../../src/infrastructure/logger.js';

describe('louvainCommunities', () => {
  it('returns empty for empty graph', () => {
    const g = new CodeGraph();
    const { assignments, modularity } = louvainCommunities(g);
    expect(assignments.size).toBe(0);
    expect(modularity).toBe(0);
  });

  it('detects communities in a two-cluster graph', () => {
    const g = new CodeGraph();
    // Cluster 1: a-b-c tightly connected
    g.addEdge('a', 'b');
    g.addEdge('b', 'c');
    g.addEdge('c', 'a');
    // Cluster 2: x-y-z tightly connected
    g.addEdge('x', 'y');
    g.addEdge('y', 'z');
    g.addEdge('z', 'x');
    // Weak bridge
    g.addEdge('c', 'x');

    const { assignments, modularity } = louvainCommunities(g);
    expect(assignments.size).toBe(6);
    expect(typeof modularity).toBe('number');

    // a, b, c should be in the same community
    expect(assignments.get('a')).toBe(assignments.get('b'));
    expect(assignments.get('b')).toBe(assignments.get('c'));
    // x, y, z should be in the same community
    expect(assignments.get('x')).toBe(assignments.get('y'));
    expect(assignments.get('y')).toBe(assignments.get('z'));
    // The two clusters should differ
    expect(assignments.get('a')).not.toBe(assignments.get('x'));
  });

  it('returns assignments for nodes-only graph (no edges)', () => {
    const g = new CodeGraph();
    g.addNode('a');
    g.addNode('b');
    const { assignments, modularity } = louvainCommunities(g);
    expect(assignments.size).toBe(0);
    expect(modularity).toBe(0);
  });

  // Regression test for #1734: `codegraph communities --drift` produced
  // different modularity/community assignments across separate full rebuilds
  // of byte-identical source. Root cause: the native Rust local-move phase
  // accumulated per-candidate-community weights in a `std::collections::HashMap`
  // (randomized per-process hasher), so a genuine tie in modularity gain
  // between two or more candidate communities was broken by hashmap iteration
  // order instead of a reproducible rule. Fixed by switching the relevant
  // maps to `BTreeMap` (deterministic, sorted iteration).
  //
  // This graph is symmetric by construction: three disjoint triangles, plus a
  // bridge node connected with equal weight to one member of each triangle.
  // Moving the bridge node into any of the three triangles yields the exact
  // same modularity gain, forcing the local-move phase to break a genuine
  // tie on every run.
  describe('determinism (#1734)', () => {
    function buildTieGraph(): CodeGraph {
      const g = new CodeGraph();
      g.addEdge('a1', 'a2');
      g.addEdge('a2', 'a3');
      g.addEdge('a3', 'a1');
      g.addEdge('b1', 'b2');
      g.addEdge('b2', 'b3');
      g.addEdge('b3', 'b1');
      g.addEdge('c1', 'c2');
      g.addEdge('c2', 'c3');
      g.addEdge('c3', 'c1');
      // Bridge node tied equally between all three triangles.
      g.addEdge('x', 'a1');
      g.addEdge('x', 'b1');
      g.addEdge('x', 'c1');
      return g;
    }

    /** Sorted "node:community" pairs — stable snapshot for deep-equal comparison. */
    function snapshotAssignments(assignments: Map<string, number>): string[] {
      return [...assignments.entries()].map(([node, community]) => `${node}:${community}`).sort();
    }

    it('produces byte-identical modularity and assignments across repeated runs', () => {
      const runs = Array.from({ length: 20 }, () => {
        const g = buildTieGraph();
        return louvainCommunities(g);
      });

      const firstModularity = runs[0]!.modularity;
      const firstAssignments = snapshotAssignments(runs[0]!.assignments);

      for (const run of runs.slice(1)) {
        expect(run.modularity).toBe(firstModularity);
        expect(snapshotAssignments(run.assignments)).toEqual(firstAssignments);
      }
    });

    // Note: `buildTieGraph()` above is *symmetric by design* — the bridge
    // node's three-way tie means a different edge-insertion order can validly
    // land it in a different (but equally optimal) community. That is
    // expected Louvain behavior, not a bug, so it is not asserted here.
    // Order-independence is only a meaningful invariant when the optimal
    // partition is unambiguous, as below.
    it('produces an equivalent partition regardless of edge insertion order (unambiguous graph)', () => {
      function buildUnambiguousGraph(edges: Array<[string, string]>): CodeGraph {
        const g = new CodeGraph();
        for (const [src, tgt] of edges) g.addEdge(src, tgt);
        return g;
      }

      // Two tightly-connected triangles joined by a single weak bridge edge —
      // the best partition (two triangles) is unambiguous, so insertion order
      // must not change which nodes end up grouped together.
      const edges: Array<[string, string]> = [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
        ['x', 'y'],
        ['y', 'z'],
        ['z', 'x'],
        ['c', 'x'],
      ];

      const forwardResult = louvainCommunities(buildUnambiguousGraph(edges));
      const reversedResult = louvainCommunities(buildUnambiguousGraph(edges.slice().reverse()));

      expect(reversedResult.modularity).toBe(forwardResult.modularity);
      expect(reversedResult.assignments.get('a')).toBe(reversedResult.assignments.get('b'));
      expect(reversedResult.assignments.get('b')).toBe(reversedResult.assignments.get('c'));
      expect(reversedResult.assignments.get('x')).toBe(reversedResult.assignments.get('y'));
      expect(reversedResult.assignments.get('y')).toBe(reversedResult.assignments.get('z'));
      expect(reversedResult.assignments.get('a')).not.toBe(reversedResult.assignments.get('x'));
    });
  });

  describe('Leiden-knob parity logging', () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      stderrSpy.mockRestore();
      setVerbose(false);
    });

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

    // Regression guard: DEFAULTS.community always populates maxLevels/maxLocalPasses/
    // refinementTheta, so forwarding config values used to emit `[codegraph WARN]` on
    // every communities computation. Keep the parity note at debug level — never warn.
    it('never emits the parity message at WARN level when config defaults are forwarded', () => {
      const g = buildTwoClusterGraph();
      louvainCommunities(g, {
        maxLevels: 50,
        maxLocalPasses: 20,
        refinementTheta: 1.0,
      });

      const warnWrites = stderrSpy.mock.calls
        .map(([chunk]) => (typeof chunk === 'string' ? chunk : (chunk?.toString?.() ?? '')))
        .filter((line) => line.includes('[codegraph WARN]'));
      expect(warnWrites).toEqual([]);
    });

    it('emits the parity message at DEBUG level when verbose is enabled and Leiden knobs are set', () => {
      setVerbose(true);
      const g = buildTwoClusterGraph();
      louvainCommunities(g, {
        maxLevels: 50,
        maxLocalPasses: 20,
        refinementTheta: 1.0,
      });

      const writes = stderrSpy.mock.calls
        .map(([chunk]) => (typeof chunk === 'string' ? chunk : (chunk?.toString?.() ?? '')))
        .join('');
      // Message is only emitted on the native path. When native is unavailable we at
      // least assert no WARN was emitted (covered by the previous test); when it is
      // available, it must go through the DEBUG channel and never WARN.
      expect(writes).not.toContain('[codegraph WARN]');
      // Allow either outcome for DEBUG depending on engine availability.
      if (writes.includes('maxLevels/maxLocalPasses/refinementTheta')) {
        expect(writes).toContain('[codegraph DEBUG]');
      }
    });
  });

  // Regression guard for issue #1804: before that fix, the native Rust path
  // ran classic Louvain and silently ignored maxLevels/maxLocalPasses/
  // refinementTheta/capacityGrowthFactor entirely (native Leiden now honors
  // all four, same as the JS fallback) — this just pins that passing them
  // doesn't throw or change the shape of the result, on both engines.
  it('accepts maxLevels/maxLocalPasses/refinementTheta/capacityGrowthFactor without error', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'c');
    g.addEdge('c', 'a');
    g.addEdge('x', 'y');
    g.addEdge('y', 'z');
    g.addEdge('z', 'x');
    g.addEdge('c', 'x');

    const { assignments, modularity } = louvainCommunities(g, {
      maxLevels: 50,
      maxLocalPasses: 20,
      refinementTheta: 1.0,
      capacityGrowthFactor: 1.5,
    });

    expect(assignments.size).toBe(6);
    expect(typeof modularity).toBe('number');
  });
});
