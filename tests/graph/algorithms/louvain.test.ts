import { describe, expect, it } from 'vitest';
import { louvainCommunities } from '../../../src/graph/algorithms/louvain.js';
import { CodeGraph } from '../../../src/graph/model.js';

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
});
