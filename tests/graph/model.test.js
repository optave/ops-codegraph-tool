import { describe, expect, it } from 'vitest';
import { CodeGraph } from '../../src/graph/model.js';

describe('CodeGraph — directed', () => {
  it('starts empty', () => {
    const g = new CodeGraph();
    expect(g.nodeCount).toBe(0);
    expect(g.edgeCount).toBe(0);
    expect(g.directed).toBe(true);
  });

  it('adds nodes and edges', () => {
    const g = new CodeGraph();
    g.addNode('a', { label: 'A' });
    g.addNode('b', { label: 'B' });
    g.addEdge('a', 'b', { kind: 'calls' });

    expect(g.nodeCount).toBe(2);
    expect(g.edgeCount).toBe(1);
    expect(g.hasNode('a')).toBe(true);
    expect(g.hasNode('c')).toBe(false);
    expect(g.hasEdge('a', 'b')).toBe(true);
    expect(g.hasEdge('b', 'a')).toBe(false);
  });

  it('auto-adds nodes when adding edges', () => {
    const g = new CodeGraph();
    g.addEdge('x', 'y');
    expect(g.hasNode('x')).toBe(true);
    expect(g.hasNode('y')).toBe(true);
    expect(g.nodeCount).toBe(2);
  });

  it('stringifies numeric IDs', () => {
    const g = new CodeGraph();
    g.addNode(42, { name: 'foo' });
    expect(g.hasNode('42')).toBe(true);
    expect(g.getNodeAttrs('42')).toEqual({ name: 'foo' });
  });

  it('reports correct adjacency', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('a', 'c');
    g.addEdge('d', 'a');

    expect(g.successors('a').sort()).toEqual(['b', 'c']);
    expect(g.predecessors('a')).toEqual(['d']);
    expect(g.neighbors('a').sort()).toEqual(['b', 'c', 'd']);
    expect(g.outDegree('a')).toBe(2);
    expect(g.inDegree('a')).toBe(1);
  });

  it('iterates nodes and edges', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b', { w: 1 });
    g.addEdge('b', 'c', { w: 2 });

    const nodeIds = [...g.nodes()].map(([id]) => id);
    expect(nodeIds.sort()).toEqual(['a', 'b', 'c']);

    const edges = [...g.edges()];
    expect(edges).toHaveLength(2);
    expect(edges[0]).toEqual(['a', 'b', { w: 1 }]);
  });

  it('nodeIds returns array of keys', () => {
    const g = new CodeGraph();
    g.addNode('x');
    g.addNode('y');
    expect(g.nodeIds().sort()).toEqual(['x', 'y']);
  });

  it('getEdgeAttrs returns attributes', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b', { kind: 'imports' });
    expect(g.getEdgeAttrs('a', 'b')).toEqual({ kind: 'imports' });
    expect(g.getEdgeAttrs('b', 'a')).toBeUndefined();
  });
});

describe('CodeGraph — undirected', () => {
  it('mirrors edges', () => {
    const g = new CodeGraph({ directed: false });
    g.addEdge('a', 'b');

    expect(g.hasEdge('a', 'b')).toBe(true);
    expect(g.hasEdge('b', 'a')).toBe(true);
    expect(g.successors('a')).toEqual(['b']);
    expect(g.successors('b')).toEqual(['a']);
  });

  it('counts each undirected edge once', () => {
    const g = new CodeGraph({ directed: false });
    g.addEdge('a', 'b');
    g.addEdge('b', 'c');
    expect(g.edgeCount).toBe(2);
    expect([...g.edges()]).toHaveLength(2);
  });
});

describe('CodeGraph — subgraph', () => {
  it('filters nodes and preserves internal edges', () => {
    const g = new CodeGraph();
    g.addNode('a', { keep: true });
    g.addNode('b', { keep: true });
    g.addNode('c', { keep: false });
    g.addEdge('a', 'b');
    g.addEdge('a', 'c');
    g.addEdge('b', 'c');

    const sub = g.subgraph((_, attrs) => attrs.keep);
    expect(sub.nodeCount).toBe(2);
    expect(sub.edgeCount).toBe(1);
    expect(sub.hasEdge('a', 'b')).toBe(true);
    expect(sub.hasEdge('a', 'c')).toBe(false);
  });
});

describe('CodeGraph — filterEdges', () => {
  it('keeps all nodes, filters edges', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b', { kind: 'calls' });
    g.addEdge('a', 'c', { kind: 'imports' });

    const filtered = g.filterEdges((_, __, attrs) => attrs.kind === 'calls');
    expect(filtered.nodeCount).toBe(3);
    expect(filtered.edgeCount).toBe(1);
    expect(filtered.hasEdge('a', 'b')).toBe(true);
    expect(filtered.hasEdge('a', 'c')).toBe(false);
  });
});

describe('CodeGraph — toEdgeArray', () => {
  it('returns {source, target} objects', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'c');
    const arr = g.toEdgeArray();
    expect(arr).toEqual([
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ]);
  });
});

describe('CodeGraph — toGraphology', () => {
  it('creates an undirected graphology graph', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    g.addEdge('b', 'c');

    const gy = g.toGraphology({ type: 'undirected' });
    expect(gy.order).toBe(3);
    expect(gy.size).toBe(2);
    expect(gy.type).toBe('undirected');
  });

  it('skips self-loops', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'a');
    g.addEdge('a', 'b');

    const gy = g.toGraphology({ type: 'undirected' });
    expect(gy.size).toBe(1);
  });
});

describe('CodeGraph — clone', () => {
  it('produces an independent copy', () => {
    const g = new CodeGraph();
    g.addEdge('a', 'b');
    const c = g.clone();

    c.addEdge('b', 'c');
    expect(g.edgeCount).toBe(1);
    expect(c.edgeCount).toBe(2);
  });
});

describe('CodeGraph — merge', () => {
  it('combines two graphs', () => {
    const g1 = new CodeGraph();
    g1.addEdge('a', 'b');
    const g2 = new CodeGraph();
    g2.addEdge('b', 'c');

    g1.merge(g2);
    expect(g1.nodeCount).toBe(3);
    expect(g1.edgeCount).toBe(2);
  });
});
