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
});
