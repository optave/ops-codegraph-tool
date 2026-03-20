import { describe, expect, it } from 'vitest';
import { detectClusters } from '../../../src/graph/algorithms/leiden/index.js';
import { CodeGraph } from '../../../src/graph/model.js';

// ─── Helpers ──────────────────────────────────────────────────────────

/** Two 4-node cliques connected by a single weak bridge. */
function makeTwoCliquesBridge() {
  const g = new CodeGraph();
  const A = ['0', '1', '2', '3'];
  const B = ['4', '5', '6', '7'];
  for (const id of [...A, ...B]) g.addNode(id);
  for (let i = 0; i < A.length; i++)
    for (let j = i + 1; j < A.length; j++) {
      g.addEdge(A[i], A[j]);
      g.addEdge(A[j], A[i]);
    }
  for (let i = 0; i < B.length; i++)
    for (let j = i + 1; j < B.length; j++) {
      g.addEdge(B[i], B[j]);
      g.addEdge(B[j], B[i]);
    }
  g.addEdge('3', '4');
  g.addEdge('4', '3');
  return g;
}

function makeTwoCliques(n = 4) {
  const g = new CodeGraph();
  const A = Array.from({ length: n }, (_, i) => `a${i}`);
  const B = Array.from({ length: n }, (_, i) => `b${i}`);
  for (const id of [...A, ...B]) g.addNode(id);
  for (let i = 0; i < A.length; i++)
    for (let j = i + 1; j < A.length; j++) {
      g.addEdge(A[i], A[j]);
      g.addEdge(A[j], A[i]);
    }
  for (let i = 0; i < B.length; i++)
    for (let j = i + 1; j < B.length; j++) {
      g.addEdge(B[i], B[j]);
      g.addEdge(B[j], B[i]);
    }
  g.addEdge(A[A.length - 1], B[0]);
  g.addEdge(B[0], A[A.length - 1]);
  return { g, A, B };
}

// ─── Basic ────────────────────────────────────────────────────────────

describe('detectClusters', () => {
  it('splits two cliques with a weak bridge', () => {
    const g = makeTwoCliquesBridge();
    const clusters = detectClusters(g, { randomSeed: 1 });
    const cA = new Set(['0', '1', '2', '3'].map((i) => clusters.getClass(i)));
    const cB = new Set(['4', '5', '6', '7'].map((i) => clusters.getClass(i)));
    expect(cA.size).toBe(1);
    expect(cB.size).toBe(1);
    expect([...cA][0]).not.toBe([...cB][0]);
  });
});

// ─── CPM ──────────────────────────────────────────────────────────────

describe('CPM resolution tuning', () => {
  it('splits more with higher gamma', () => {
    const g = makeTwoCliquesBridge();
    const low = detectClusters(g, { quality: 'cpm', resolution: 0.01, randomSeed: 1 });
    const high = detectClusters(g, { quality: 'cpm', resolution: 10.0, randomSeed: 1 });
    const ids = ['0', '1', '2', '3', '4', '5', '6', '7'];
    const countCommunities = (clusters) => new Set(ids.map((i) => clusters.getClass(i))).size;
    expect(countCommunities(low)).toBeLessThanOrEqual(countCommunities(high));
  });
});

// ─── CPM size-aware ───────────────────────────────────────────────────

describe('CPM size-aware mode', () => {
  it('penalizes large-size communities more than unit mode', () => {
    const g = new CodeGraph();
    const A = ['0', '1', '2', '3'];
    const B = ['4', '5', '6', '7'];
    for (const id of [...A, ...B]) g.addNode(id, { size: A.includes(id) ? 5 : 1 });
    for (let i = 0; i < A.length; i++)
      for (let j = i + 1; j < A.length; j++) {
        g.addEdge(A[i], A[j]);
        g.addEdge(A[j], A[i]);
      }
    for (let i = 0; i < B.length; i++)
      for (let j = i + 1; j < B.length; j++) {
        g.addEdge(B[i], B[j]);
        g.addEdge(B[j], B[i]);
      }
    g.addEdge('3', '4');
    g.addEdge('4', '3');

    const gamma = 0.5;
    const unit = detectClusters(g, {
      quality: 'cpm',
      cpmMode: 'unit',
      resolution: gamma,
      randomSeed: 3,
    });
    const sized = detectClusters(g, {
      quality: 'cpm',
      cpmMode: 'size-aware',
      resolution: gamma,
      randomSeed: 3,
    });
    expect(sized.quality()).toBeLessThanOrEqual(unit.quality());
    const ids = [...A, ...B];
    const count = (cl) => new Set(ids.map((i) => cl.getClass(i))).size;
    expect(count(unit)).toBe(2);
    expect(count(sized)).toBe(2);
  });
});

// ─── Directed ─────────────────────────────────────────────────────────

describe('directed modularity', () => {
  it('finds two communities in directed case', () => {
    const g = new CodeGraph();
    const A = ['0', '1', '2'];
    const B = ['3', '4', '5'];
    for (const id of [...A, ...B]) g.addNode(id);
    for (let i = 0; i < A.length; i++)
      for (let j = 0; j < A.length; j++) if (i !== j) g.addEdge(A[i], A[j]);
    for (let i = 0; i < B.length; i++)
      for (let j = 0; j < B.length; j++) if (i !== j) g.addEdge(B[i], B[j]);
    g.addEdge('2', '3');

    const clusters = detectClusters(g, { directed: true, randomSeed: 2 });
    const cA = new Set(A.map((i) => clusters.getClass(i)));
    const cB = new Set(B.map((i) => clusters.getClass(i)));
    expect(cA.size).toBe(1);
    expect(cB.size).toBe(1);
    expect([...cA][0]).not.toBe([...cB][0]);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────

describe('edge cases', () => {
  it('keeps isolated node as its own community', () => {
    const g = new CodeGraph();
    g.addNode('x');
    g.addNode('y');
    g.addNode('z');
    g.addEdge('x', 'y');
    g.addEdge('y', 'x');

    const clusters = detectClusters(g, { randomSeed: 123 });
    expect(clusters.getClass('x')).toBe(clusters.getClass('y'));
    expect(clusters.getClass('z')).not.toBe(clusters.getClass('x'));
  });

  it('handles negative weights and preserves intuitive split', () => {
    const g = new CodeGraph();
    const A = ['a1', 'a2', 'a3', 'a4'];
    const B = ['b1', 'b2', 'b3', 'b4'];
    for (const id of [...A, ...B]) g.addNode(id);
    for (let i = 0; i < A.length; i++)
      for (let j = i + 1; j < A.length; j++) {
        g.addEdge(A[i], A[j]);
        g.addEdge(A[j], A[i]);
      }
    for (let i = 0; i < B.length; i++)
      for (let j = i + 1; j < B.length; j++) {
        g.addEdge(B[i], B[j]);
        g.addEdge(B[j], B[i]);
      }
    g.addEdge('a4', 'b1', { weight: -2 });
    g.addEdge('b1', 'a4', { weight: -2 });
    g.addEdge('a3', 'b2', { weight: -1 });
    g.addEdge('b2', 'a3', { weight: -1 });

    const clusters = detectClusters(g, { randomSeed: 7 });
    const cA = new Set(A.map((i) => clusters.getClass(i)));
    const cB = new Set(B.map((i) => clusters.getClass(i)));
    expect(cA.size).toBe(1);
    expect(cB.size).toBe(1);
    expect([...cA][0]).not.toBe([...cB][0]);
  });

  it('self-loop biases node to remain separate under weak external ties (CPM)', () => {
    const g = new CodeGraph();
    g.addNode('a');
    g.addNode('b');
    g.addEdge('a', 'a', { weight: 5 });
    g.addEdge('a', 'b', { weight: 0.1 });
    g.addEdge('b', 'a', { weight: 0.1 });

    const clusters = detectClusters(g, {
      randomSeed: 5,
      quality: 'cpm',
      resolution: 1.0,
    });
    expect(clusters.getClass('a')).not.toBe(clusters.getClass('b'));
  });

  it('treats a disconnected clique as its own isolated community', () => {
    const g = new CodeGraph();
    const A = ['a1', 'a2', 'a3'];
    const B = ['b1', 'b2'];
    for (const id of [...A, ...B]) g.addNode(id);
    for (let i = 0; i < A.length; i++)
      for (let j = i + 1; j < A.length; j++) {
        g.addEdge(A[i], A[j]);
        g.addEdge(A[j], A[i]);
      }
    g.addEdge('b1', 'b2');
    g.addEdge('b2', 'b1');

    const clusters = detectClusters(g, { randomSeed: 321 });
    const cA = new Set(A.map((i) => clusters.getClass(i)));
    const cB = new Set(B.map((i) => clusters.getClass(i)));
    expect(cA.size).toBe(1);
    expect(cB.size).toBe(1);
    expect([...cA][0]).not.toBe([...cB][0]);
  });
});

// ─── Ergonomics & constraints ─────────────────────────────────────────

describe('ergonomics & constraints', () => {
  it('maxCommunitySize is enforced', () => {
    const { g, A, B } = makeTwoCliques(3);
    const clusters = detectClusters(g, { randomSeed: 123, maxCommunitySize: 3 });
    const cA = new Set(A.map((i) => clusters.getClass(i)));
    const cB = new Set(B.map((i) => clusters.getClass(i)));
    expect(cA.size).toBe(1);
    expect(cB.size).toBe(1);
    expect([...cA][0]).not.toBe([...cB][0]);
  });

  it('deterministic with fixed seed even with random strategies', () => {
    const { g } = makeTwoCliques(4);
    const opts = { randomSeed: 2024, candidateStrategy: 'random-neighbor' };
    const a = detectClusters(g, opts);
    const b = detectClusters(g, opts);
    const classesA = new Map();
    const classesB = new Map();
    for (const [id] of g.nodes()) {
      classesA.set(id, a.getClass(id));
      classesB.set(id, b.getClass(id));
    }
    expect(JSON.stringify([...classesA.entries()].sort())).toBe(
      JSON.stringify([...classesB.entries()].sort()),
    );
  });
});

// ─── Fixed nodes ──────────────────────────────────────────────────────

describe('fixed nodes', () => {
  it('does not force fixed nodes to leave their clique communities', () => {
    const g = makeTwoCliquesBridge();
    const fixedRun = detectClusters(g, {
      randomSeed: 11,
      refine: true,
      fixedNodes: new Set(['3', '4']),
    });
    const c3 = fixedRun.getClass('3');
    const c4 = fixedRun.getClass('4');
    expect(fixedRun.getClass('0')).toBe(c3);
    expect(fixedRun.getClass('1')).toBe(c3);
    expect(fixedRun.getClass('2')).toBe(c3);
    expect(fixedRun.getClass('4')).not.toBe(c3);
    expect(fixedRun.getClass('5')).toBe(c4);
    expect(fixedRun.getClass('6')).toBe(c4);
    expect(fixedRun.getClass('7')).toBe(c4);
  });
});

// ─── Refinement ───────────────────────────────────────────────────────

describe('refinement', () => {
  it('keeps cliques separated across refinement', () => {
    const g = new CodeGraph();
    const groups = [
      Array.from({ length: 5 }, (_, i) => String(i)),
      Array.from({ length: 5 }, (_, i) => String(i + 5)),
      Array.from({ length: 5 }, (_, i) => String(i + 10)),
    ];
    for (const group of groups) for (const v of group) g.addNode(v);
    for (const group of groups) {
      for (let i = 0; i < group.length; i++)
        for (let j = i + 1; j < group.length; j++) {
          g.addEdge(group[i], group[j]);
          g.addEdge(group[j], group[i]);
        }
    }
    g.addEdge('4', '5');
    g.addEdge('5', '4');
    g.addEdge('9', '10');
    g.addEdge('10', '9');

    const clusters = detectClusters(g, { randomSeed: 1, refine: true });
    const c0 = new Set(['0', '1', '2', '3', '4'].map((i) => clusters.getClass(i)));
    const c1 = new Set(['5', '6', '7', '8', '9'].map((i) => clusters.getClass(i)));
    const c2 = new Set(['10', '11', '12', '13', '14'].map((i) => clusters.getClass(i)));
    expect(c0.size).toBe(1);
    expect(c1.size).toBe(1);
    expect(c2.size).toBe(1);
    expect([...c0][0]).not.toBe([...c1][0]);
    expect([...c1][0]).not.toBe([...c2][0]);
  });
});
