import { describe, expect, it } from 'vitest';
import { bfs } from '../../../src/graph/algorithms/bfs.js';
import { CodeGraph } from '../../../src/graph/model.js';

describe('bfs', () => {
  it('traverses forward from a single start', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'c');
    g.addEdge('a', 'd');

    const depths = bfs(g, 'a');
    expect(depths.get('a')).toBe(0);
    expect(depths.get('b')).toBe(1);
    expect(depths.get('c')).toBe(2);
    expect(depths.get('d')).toBe(1);
  });

  it('respects maxDepth', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'c');
    g.addEdge('c', 'd');

    const depths = bfs(g, 'a', { maxDepth: 1 });
    expect(depths.has('a')).toBe(true);
    expect(depths.has('b')).toBe(true);
    expect(depths.has('c')).toBe(false);
  });

  it('traverses backward', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'c');

    const depths = bfs(g, 'c', { direction: 'backward' });
    expect(depths.get('c')).toBe(0);
    expect(depths.get('b')).toBe(1);
    expect(depths.get('a')).toBe(2);
  });

  it('traverses both directions', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('c', 'b');

    const depths = bfs(g, 'b', { direction: 'both' });
    expect(depths.size).toBe(3);
  });

  it('handles multiple start nodes', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'c');
    g.addEdge('b', 'c');
    g.addEdge('c', 'd');

    const depths = bfs(g, ['a', 'b']);
    expect(depths.get('a')).toBe(0);
    expect(depths.get('b')).toBe(0);
    expect(depths.get('c')).toBe(1);
    expect(depths.get('d')).toBe(2);
  });

  it('handles empty graph', () => {
    const g = new CodeGraph();
    const depths = bfs(g, 'a');
    expect(depths.size).toBe(0);
  });
});
