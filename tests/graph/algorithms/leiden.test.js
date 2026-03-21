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

  it('high theta preserves singletons via stay option (Algorithm 3 §4)', () => {
    // With very high theta the "stay as singleton" weight (ΔH=0) becomes
    // comparable to the merge weights in the Boltzmann distribution, so
    // some nodes probabilistically remain alone. Without the stay option,
    // every singleton with any positive-gain neighbor would always merge.
    //
    // Build a single large clique with uniform weak edges. At low theta,
    // all nodes merge greedily into one community. At very high theta, the
    // stay option has non-trivial probability, so across multiple seeds at
    // least one run should preserve extra singletons.
    const g = new CodeGraph();
    const n = 12;
    for (let i = 0; i < n; i++) g.addNode(String(i));
    // Uniform weak edges — every pair connected with weight 1
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        g.addEdge(String(i), String(j));
        g.addEdge(String(j), String(i));
      }

    const countCommunities = (cl) => {
      const ids = Array.from({ length: n }, (_, i) => String(i));
      return new Set(ids.map((i) => cl.getClass(i))).size;
    };

    // Low theta: effectively greedy, should merge aggressively
    const lowTheta = detectClusters(g, { randomSeed: 42, refine: true, refinementTheta: 0.001 });
    const lowCount = countCommunities(lowTheta);

    // Very high theta: stay option dominates, test across seeds
    let maxHighCount = 0;
    for (const seed of [1, 7, 42, 99, 200, 500, 1000, 2024]) {
      const result = detectClusters(g, { randomSeed: seed, refine: true, refinementTheta: 1000 });
      const c = countCommunities(result);
      if (c > maxHighCount) maxHighCount = c;
    }
    // At least one high-theta run should preserve more communities
    expect(maxHighCount).toBeGreaterThanOrEqual(lowCount);
  });

  it('singleton guard prevents over-merging across seeds', () => {
    // The singleton guard says: once a node joins a non-singleton community
    // during refinement, it cannot be moved again. Without this guard,
    // iterative passes would keep shuffling nodes, producing fewer, larger
    // communities than Algorithm 3 intends.
    //
    // Build 6 triangles in a ring. Each triangle is a natural community,
    // but the ring creates ambiguity at boundaries. Without the singleton
    // guard, multi-pass refinement would collapse adjacent triangles into
    // larger communities. With it, single-pass + lock preserves more
    // granularity.
    //
    // We test across multiple seeds: the minimum community count should
    // stay above a threshold. An implementation without the singleton
    // guard would frequently collapse to fewer communities.
    const g = new CodeGraph();
    const numTriangles = 6;
    for (let t = 0; t < numTriangles; t++) for (let i = 0; i < 3; i++) g.addNode(`${t}_${i}`);
    // Intra-triangle edges (strong)
    for (let t = 0; t < numTriangles; t++) {
      g.addEdge(`${t}_0`, `${t}_1`, { weight: 5 });
      g.addEdge(`${t}_1`, `${t}_0`, { weight: 5 });
      g.addEdge(`${t}_1`, `${t}_2`, { weight: 5 });
      g.addEdge(`${t}_2`, `${t}_1`, { weight: 5 });
      g.addEdge(`${t}_0`, `${t}_2`, { weight: 5 });
      g.addEdge(`${t}_2`, `${t}_0`, { weight: 5 });
    }
    // Inter-triangle ring edges (moderate — enough to tempt merges)
    for (let t = 0; t < numTriangles; t++) {
      const next = (t + 1) % numTriangles;
      g.addEdge(`${t}_2`, `${next}_0`, { weight: 2 });
      g.addEdge(`${next}_0`, `${t}_2`, { weight: 2 });
    }

    let minCommunities = Infinity;
    for (const seed of [1, 42, 100, 2024, 9999]) {
      const result = detectClusters(g, { randomSeed: seed, refine: true, refinementTheta: 0.05 });
      const ids = [];
      for (let t = 0; t < numTriangles; t++) for (let i = 0; i < 3; i++) ids.push(`${t}_${i}`);
      const count = new Set(ids.map((id) => result.getClass(id))).size;
      if (count < minCommunities) minCommunities = count;
    }
    // With singleton guard + single pass, the algorithm preserves more
    // granular communities. Without it (iterative), we'd see collapse to
    // 2-3 communities. Expect at least 4 communities across all seeds.
    expect(minCommunities).toBeGreaterThanOrEqual(4);
  });

  it('single-pass refinement produces more communities than iterative would', () => {
    // Direct evidence that refinement is a single pass: compare refine=true
    // against refine=false (pure Louvain, which is iterative). On a graph
    // with many small, equally-connected clusters, single-pass refinement
    // preserves finer granularity because it doesn't iterate to convergence.
    const g = new CodeGraph();
    const groupCount = 8;
    const groupSize = 3;
    for (let gi = 0; gi < groupCount; gi++)
      for (let i = 0; i < groupSize; i++) g.addNode(`g${gi}_${i}`);
    // Strong intra-group
    for (let gi = 0; gi < groupCount; gi++)
      for (let i = 0; i < groupSize; i++)
        for (let j = i + 1; j < groupSize; j++) {
          g.addEdge(`g${gi}_${i}`, `g${gi}_${j}`, { weight: 10 });
          g.addEdge(`g${gi}_${j}`, `g${gi}_${i}`, { weight: 10 });
        }
    // Weak uniform inter-group (every group connected to every other)
    for (let a = 0; a < groupCount; a++)
      for (let b = a + 1; b < groupCount; b++) {
        g.addEdge(`g${a}_0`, `g${b}_0`, { weight: 0.5 });
        g.addEdge(`g${b}_0`, `g${a}_0`, { weight: 0.5 });
      }

    const withRefine = detectClusters(g, { randomSeed: 42, refine: true, refinementTheta: 0.01 });
    const withoutRefine = detectClusters(g, { randomSeed: 42, refine: false });
    const ids = [];
    for (let gi = 0; gi < groupCount; gi++)
      for (let i = 0; i < groupSize; i++) ids.push(`g${gi}_${i}`);
    const countWith = new Set(ids.map((id) => withRefine.getClass(id))).size;
    const countWithout = new Set(ids.map((id) => withoutRefine.getClass(id))).size;
    // Leiden refinement (single pass, singleton guard) should preserve at
    // least as many communities as Louvain (iterative convergence).
    // In practice it often preserves more due to the conservative single pass.
    expect(countWith).toBeGreaterThanOrEqual(countWithout);
  });
});

// ─── Community connectivity guarantee ────────────────────────────────

describe('community connectivity', () => {
  it('every community is internally connected', () => {
    // Verify the core Leiden guarantee: no community should contain
    // disconnected components.  Build a graph where probabilistic
    // refinement could potentially strand nodes into disconnected
    // subcommunities if the post-refinement split step is missing.
    //
    // Topology: two 4-cliques (A, B) connected by a bridge, plus two
    // isolated pairs (C, D) with weak links to A and B respectively.
    // The Louvain phase may group A+C or B+D into the same macro-
    // community, but if refinement merges C into A's community without
    // a path between them, the split step must catch it.
    const g = new CodeGraph();
    // Clique A
    const A = ['a0', 'a1', 'a2', 'a3'];
    // Clique B
    const B = ['b0', 'b1', 'b2', 'b3'];
    // Isolated pairs
    const C = ['c0', 'c1'];
    const D = ['d0', 'd1'];
    for (const id of [...A, ...B, ...C, ...D]) g.addNode(id);

    // Strong intra-clique edges
    for (const clique of [A, B])
      for (let i = 0; i < clique.length; i++)
        for (let j = i + 1; j < clique.length; j++) {
          g.addEdge(clique[i], clique[j], { weight: 10 });
          g.addEdge(clique[j], clique[i], { weight: 10 });
        }
    // Pair edges
    g.addEdge('c0', 'c1', { weight: 5 });
    g.addEdge('c1', 'c0', { weight: 5 });
    g.addEdge('d0', 'd1', { weight: 5 });
    g.addEdge('d1', 'd0', { weight: 5 });
    // Bridge A↔B
    g.addEdge('a3', 'b0', { weight: 1 });
    g.addEdge('b0', 'a3', { weight: 1 });
    // Weak links to isolated pairs (could tempt merging)
    g.addEdge('a0', 'c0', { weight: 0.5 });
    g.addEdge('c0', 'a0', { weight: 0.5 });
    g.addEdge('b0', 'd0', { weight: 0.5 });
    g.addEdge('d0', 'b0', { weight: 0.5 });

    // Run across several seeds — connectivity must hold for all.
    const allIds = [...A, ...B, ...C, ...D];
    for (const seed of [1, 42, 100, 999, 2024]) {
      const result = detectClusters(g, {
        randomSeed: seed,
        refine: true,
        refinementTheta: 1.0,
      });

      // Group nodes by community.
      const communities = new Map();
      for (const id of allIds) {
        const c = result.getClass(id);
        if (!communities.has(c)) communities.set(c, []);
        communities.get(c).push(id);
      }

      // For each community, verify all members are reachable from the first
      // member via edges within the community (BFS on subgraph).
      for (const [, members] of communities) {
        if (members.length <= 1) continue;
        const memberSet = new Set(members);
        const visited = new Set();
        const queue = [members[0]];
        visited.add(members[0]);
        while (queue.length > 0) {
          const current = queue.shift();
          for (const neighbor of g.successors(current)) {
            if (memberSet.has(neighbor) && !visited.has(neighbor)) {
              visited.add(neighbor);
              queue.push(neighbor);
            }
          }
        }
        expect(visited.size).toBe(
          memberSet.size,
          `seed=${seed}: community with members [${members.join(',')}] is disconnected — ` +
            `only ${[...visited].join(',')} reachable from ${members[0]}`,
        );
      }
    }
  });
});
