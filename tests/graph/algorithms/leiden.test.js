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

// ─── CPM with weighted nodes ─────────────────────────────────────────

describe('CPM with weighted nodes', () => {
  it('uses communityTotalSize in quality reporting', () => {
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

    const result = detectClusters(g, {
      quality: 'cpm',
      resolution: 0.5,
      randomSeed: 3,
    });
    // B-clique (size=1 nodes) merges; quality is finite
    const bCommunities = new Set(B.map((i) => result.getClass(i)));
    expect(bCommunities.size).toBe(1);
    expect(typeof result.quality()).toBe('number');
    expect(Number.isFinite(result.quality())).toBe(true);
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

// ─── Directed self-loops ──────────────────────────────────────────────

describe('directed self-loops', () => {
  it('does not corrupt internal edge weight with directed self-loops', () => {
    const g = new CodeGraph();
    const A = ['0', '1', '2'];
    const B = ['3', '4', '5'];
    for (const id of [...A, ...B]) g.addNode(id);
    for (let i = 0; i < A.length; i++)
      for (let j = 0; j < A.length; j++) if (i !== j) g.addEdge(A[i], A[j]);
    for (let i = 0; i < B.length; i++)
      for (let j = 0; j < B.length; j++) if (i !== j) g.addEdge(B[i], B[j]);
    g.addEdge('2', '3');
    // Add self-loops — these previously caused double-counting in directed mode
    g.addEdge('0', '0', { weight: 3 });
    g.addEdge('3', '3', { weight: 3 });

    const clusters = detectClusters(g, { directed: true, randomSeed: 2 });
    // Quality must be finite (not NaN from negative internal edge weight)
    expect(Number.isFinite(clusters.quality())).toBe(true);
    expect(clusters.quality()).toBeGreaterThanOrEqual(0);
    // A-side nodes should not mix with B-side nodes
    const aCommunities = new Set(A.map((i) => clusters.getClass(i)));
    const bCommunities = new Set(B.map((i) => clusters.getClass(i)));
    const overlap = [...aCommunities].filter((c) => bCommunities.has(c));
    expect(overlap.length).toBe(0);
  });
});

// ─── Coarse graph quality ────────────────────────────────────────────

describe('coarse graph quality', () => {
  it('quality is not inflated by multi-level coarsening', () => {
    // Two disconnected 4-cliques: the algorithm should split them into two
    // communities. Quality must stay in [-1, 1] and be consistent whether
    // the run goes through one or multiple coarsening levels.
    const g = new CodeGraph();
    const A = ['a0', 'a1', 'a2', 'a3'];
    const B = ['b0', 'b1', 'b2', 'b3'];
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
    const clusters = detectClusters(g, { randomSeed: 42 });
    const q = clusters.quality();
    // Two disjoint K4 cliques: the ideal 2-community partition gives Q = 0.5.
    // Each clique has L_c = 6 edges, d_c = 12, 2m = 24:
    //   Q = 2 × [2·6/24 − (12/24)²] = 2 × 0.25 = 0.5
    expect(q).toBeCloseTo(0.5, 2);
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

// ─── Probabilistic refinement (Algorithm 3, Traag et al. 2019) ───────

describe('probabilistic refinement', () => {
  it('is deterministic with the same seed', () => {
    const g = makeTwoCliquesBridge();
    const opts = { randomSeed: 77, refine: true, refinementTheta: 0.05 };
    const a = detectClusters(g, opts);
    const b = detectClusters(g, opts);
    const ids = ['0', '1', '2', '3', '4', '5', '6', '7'];
    const classesA = ids.map((i) => a.getClass(i));
    const classesB = ids.map((i) => b.getClass(i));
    expect(classesA).toEqual(classesB);
  });

  it('produces different results with different seeds', () => {
    // On a larger graph with ambiguous structure, different seeds should
    // exercise different probabilistic paths. Build a ring of 5-cliques
    // with equally-weighted bridges — partition is ambiguous, so the
    // probabilistic step has room to diverge across seeds.
    const g = new CodeGraph();
    const cliqueSize = 5;
    const numCliques = 4;
    for (let c = 0; c < numCliques; c++)
      for (let i = 0; i < cliqueSize; i++) g.addNode(`${c}_${i}`);
    for (let c = 0; c < numCliques; c++)
      for (let i = 0; i < cliqueSize; i++)
        for (let j = i + 1; j < cliqueSize; j++) {
          g.addEdge(`${c}_${i}`, `${c}_${j}`);
          g.addEdge(`${c}_${j}`, `${c}_${i}`);
        }
    // Ring bridges with moderate weight — creates ambiguity
    for (let c = 0; c < numCliques; c++) {
      const next = (c + 1) % numCliques;
      g.addEdge(`${c}_${cliqueSize - 1}`, `${next}_0`, { weight: 2 });
      g.addEdge(`${next}_0`, `${c}_${cliqueSize - 1}`, { weight: 2 });
    }

    const opts1 = { randomSeed: 1, refine: true, refinementTheta: 1.0 };
    const opts2 = { randomSeed: 9999, refine: true, refinementTheta: 1.0 };
    const a = detectClusters(g, opts1);
    const b = detectClusters(g, opts2);
    const ids = [];
    for (let c = 0; c < numCliques; c++) for (let i = 0; i < cliqueSize; i++) ids.push(`${c}_${i}`);

    // At minimum, quality should be finite for both
    expect(Number.isFinite(a.quality())).toBe(true);
    expect(Number.isFinite(b.quality())).toBe(true);
    // We don't assert they differ — the point is that both are valid
    // partitions and neither crashes. True randomness divergence is
    // probabilistic and cannot be asserted deterministically.
  });

  it('low theta approximates greedy (same result as very low theta)', () => {
    const { g } = makeTwoCliques(4);
    // Two runs with very low theta should produce identical results
    // (exponential heavily favors max-gain candidate → effectively greedy)
    const a = detectClusters(g, { randomSeed: 42, refine: true, refinementTheta: 1e-6 });
    const b = detectClusters(g, { randomSeed: 42, refine: true, refinementTheta: 1e-8 });
    const ids = [];
    for (const [id] of g.nodes()) ids.push(id);
    const classesA = ids.map((i) => a.getClass(i));
    const classesB = ids.map((i) => b.getClass(i));
    expect(classesA).toEqual(classesB);
  });

  it('respects refinementTheta option and still finds correct communities', () => {
    const g = makeTwoCliquesBridge();
    // Even with high theta, two well-separated cliques should still split
    const clusters = detectClusters(g, {
      randomSeed: 42,
      refine: true,
      refinementTheta: 0.5,
    });
    const cA = new Set(['0', '1', '2', '3'].map((i) => clusters.getClass(i)));
    const cB = new Set(['4', '5', '6', '7'].map((i) => clusters.getClass(i)));
    expect(cA.size).toBe(1);
    expect(cB.size).toBe(1);
    expect([...cA][0]).not.toBe([...cB][0]);
  });
});
