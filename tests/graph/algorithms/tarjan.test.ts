import { describe, expect, it } from 'vitest';
import { tarjan } from '../../../src/graph/algorithms/tarjan.js';
import { CodeGraph } from '../../../src/graph/model.js';

function sortCycles(cycles) {
  return cycles.map((c) => [...c].sort()).sort((a, b) => a[0].localeCompare(b[0]));
}

describe('tarjan', () => {
  it('returns empty for acyclic graph', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'c');
    expect(tarjan(g)).toHaveLength(0);
  });

  it('detects 2-node cycle', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'a');
    const sccs = tarjan(g);
    expect(sccs).toHaveLength(1);
    expect(sccs[0].sort()).toEqual(['a', 'b']);
  });

  it('detects 3-node cycle', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'c');
    g.addEdge('c', 'a');
    const sccs = tarjan(g);
    expect(sccs).toHaveLength(1);
    expect(sccs[0].sort()).toEqual(['a', 'b', 'c']);
  });

  it('detects multiple independent cycles', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'a');
    g.addEdge('x', 'y');
    g.addEdge('y', 'z');
    g.addEdge('z', 'x');
    g.addEdge('p', 'q'); // non-cyclic

    const sccs = sortCycles(tarjan(g));
    expect(sccs).toHaveLength(2);
    expect(sccs[0]).toEqual(['a', 'b']);
    expect(sccs[1]).toEqual(['x', 'y', 'z']);
  });

  it('handles empty graph', () => {
    const g = new CodeGraph();
    expect(tarjan(g)).toHaveLength(0);
  });

  it('ignores self-loops (single-node SCCs are filtered)', () => {
    const g = new CodeGraph();
    g.addNode('a');
    expect(tarjan(g)).toHaveLength(0);
  });
});
