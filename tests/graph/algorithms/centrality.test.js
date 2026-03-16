import { describe, expect, it } from 'vitest';
import { fanInOut } from '../../../src/graph/algorithms/centrality.js';
import { CodeGraph } from '../../../src/graph/model.js';

describe('fanInOut', () => {
  it('computes fan-in and fan-out for all nodes', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('a', 'c');
    g.addEdge('d', 'b');

    const metrics = fanInOut(g);
    expect(metrics.get('a')).toEqual({ fanIn: 0, fanOut: 2 });
    expect(metrics.get('b')).toEqual({ fanIn: 2, fanOut: 0 });
    expect(metrics.get('c')).toEqual({ fanIn: 1, fanOut: 0 });
    expect(metrics.get('d')).toEqual({ fanIn: 0, fanOut: 1 });
  });

  it('handles empty graph', () => {
    const g = new CodeGraph();
    expect(fanInOut(g).size).toBe(0);
  });

  it('handles isolated nodes', () => {
    const g = new CodeGraph();
    g.addNode('a');
    const metrics = fanInOut(g);
    expect(metrics.get('a')).toEqual({ fanIn: 0, fanOut: 0 });
  });
});
