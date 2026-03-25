import { describe, expect, it } from 'vitest';
import { shortestPath } from '../../../src/graph/algorithms/shortest-path.js';
import { CodeGraph } from '../../../src/graph/model.js';

describe('shortestPath', () => {
  it('finds direct path', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    expect(shortestPath(g, 'a', 'b')).toEqual(['a', 'b']);
  });

  it('finds multi-hop path', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'c');
    g.addEdge('c', 'd');
    expect(shortestPath(g, 'a', 'd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns shortest among alternatives', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'd');
    g.addEdge('a', 'c');
    g.addEdge('c', 'e');
    g.addEdge('e', 'd');

    const path = shortestPath(g, 'a', 'd');
    expect(path).toEqual(['a', 'b', 'd']);
  });

  it('returns null for unreachable target', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addNode('c');
    expect(shortestPath(g, 'a', 'c')).toBeNull();
  });

  it('returns [node] for same start/end', () => {
    const g = new CodeGraph();
    g.addNode('a');
    expect(shortestPath(g, 'a', 'a')).toEqual(['a']);
  });

  it('returns null for missing nodes', () => {
    const g = new CodeGraph();
    expect(shortestPath(g, 'x', 'y')).toBeNull();
  });
});
