import { describe, expect, it } from 'vitest';
import type { GraphAdapter } from '../../../src/graph/algorithms/leiden/adapter.js';
import { makePartition } from '../../../src/graph/algorithms/leiden/partition.js';

/**
 * Minimal 3-node undirected adapter: 0-1 (w=4), 1-2 (w=6), no self-loops.
 * Hand-built (not via makeGraphAdapter) to keep this a focused unit test of
 * partition.ts's own bookkeeping, independent of adapter.ts.
 */
function makeTestAdapter(): GraphAdapter {
  const outEdges: GraphAdapter['outEdges'] = [
    [{ to: 1, w: 4 }],
    [
      { to: 0, w: 4 },
      { to: 2, w: 6 },
    ],
    [{ to: 1, w: 6 }],
  ];
  const inEdges: GraphAdapter['inEdges'] = [
    [{ from: 1, w: 4 }],
    [
      { from: 0, w: 4 },
      { from: 2, w: 6 },
    ],
    [{ from: 1, w: 6 }],
  ];
  return {
    n: 3,
    nodeIds: ['0', '1', '2'],
    idToIndex: new Map([
      ['0', 0],
      ['1', 1],
      ['2', 2],
    ]),
    size: new Float64Array([1, 1, 1]),
    selfLoop: new Float64Array(3),
    strengthOut: new Float64Array([4, 10, 6]),
    strengthIn: new Float64Array([4, 10, 6]),
    outEdges,
    inEdges,
    directed: false,
    totalWeight: 20,
    forEachNeighbor: (i, cb) => {
      for (const e of outEdges[i] as { to: number; w: number }[]) cb(e.to, e.w);
    },
  };
}

describe('makePartition', () => {
  it('starts with each node in its own singleton community', () => {
    const p = makePartition(makeTestAdapter());
    p.initializeAggregates();
    expect(p.communityCount).toBe(3);
    expect(Array.from(p.nodeCommunity)).toEqual([0, 1, 2]);
    expect(p.getCommunityTotalSize(0)).toBe(1);
    expect(p.getCommunityTotalSize(1)).toBe(1);
    expect(p.getCommunityTotalSize(2)).toBe(1);
    expect(p.getCommunityNodeCount(0)).toBe(1);
  });

  it('getCommunityTotalSize/getCommunityNodeCount return 0 for an out-of-range id', () => {
    const p = makePartition(makeTestAdapter());
    p.initializeAggregates();
    expect(p.getCommunityTotalSize(99)).toBe(0);
    expect(p.getCommunityNodeCount(99)).toBe(0);
    expect(p.getCommunityTotalSize(-1)).toBe(0);
    expect(p.getCommunityNodeCount(-1)).toBe(0);
  });

  it('moveNodeToCommunity updates size/count for old and new communities', () => {
    const p = makePartition(makeTestAdapter());
    p.initializeAggregates();
    const moved = p.moveNodeToCommunity(0, 1);
    expect(moved).toBe(true);
    expect(p.getCommunityTotalSize(0)).toBe(0);
    expect(p.getCommunityNodeCount(0)).toBe(0);
    expect(p.getCommunityTotalSize(1)).toBe(2);
    expect(p.getCommunityNodeCount(1)).toBe(2);
    expect(Array.from(p.nodeCommunity)).toEqual([1, 1, 2]);
  });

  it('moveNodeToCommunity is a no-op when the node is already in that community', () => {
    const p = makePartition(makeTestAdapter());
    p.initializeAggregates();
    expect(p.moveNodeToCommunity(0, 0)).toBe(false);
  });

  it('accumulateNeighborCommunityEdgeWeights/getNeighborEdgeWeightToCommunity report per-community edge weight, and 0 for untouched or out-of-range ids', () => {
    const p = makePartition(makeTestAdapter());
    p.initializeAggregates();
    p.moveNodeToCommunity(0, 1);

    const candidateCount = p.accumulateNeighborCommunityEdgeWeights(1);
    // node 1's neighbors are 0 (now community 1) and 2 (community 2), plus its
    // own community 1 is always touched -- so 2 distinct candidate communities.
    expect(candidateCount).toBe(2);
    expect(p.getNeighborEdgeWeightToCommunity(1)).toBe(4);
    expect(p.getNeighborEdgeWeightToCommunity(2)).toBe(6);
    // Community 0 has no members and received no edge weight -- in-range zero.
    expect(p.getNeighborEdgeWeightToCommunity(0)).toBe(0);
    // Out-of-range id -- must not throw, must fall back to 0.
    expect(p.getNeighborEdgeWeightToCommunity(50)).toBe(0);
    expect(p.getOutEdgeWeightToCommunity(50)).toBe(0);
    expect(p.getInEdgeWeightFromCommunity(50)).toBe(0);
  });

  it('getCommunityMembers groups node indices by current community', () => {
    const p = makePartition(makeTestAdapter());
    p.initializeAggregates();
    p.moveNodeToCommunity(0, 1);
    const members = p.getCommunityMembers();
    expect(members[0]).toEqual([]);
    expect(members[1]).toEqual([0, 1]);
    expect(members[2]).toEqual([2]);
  });

  it('compactCommunityIds removes empty communities and remaps the rest', () => {
    const p = makePartition(makeTestAdapter());
    p.initializeAggregates();
    p.moveNodeToCommunity(0, 1);
    p.compactCommunityIds();
    expect(p.communityCount).toBe(2);
    // Both remaining communities' sizes should be 2 and 1, in descending-size order.
    const sizes = [p.getCommunityTotalSize(0), p.getCommunityTotalSize(1)].sort((a, b) => b - a);
    expect(sizes).toEqual([2, 1]);
  });

  it('respects a custom capacityGrowthFactor option', () => {
    const p = makePartition(makeTestAdapter(), { capacityGrowthFactor: 2 });
    p.initializeAggregates();
    p.resizeCommunities(10);
    expect(p.communityCount).toBe(10);
    expect(p.communityTotalSize.length).toBeGreaterThanOrEqual(10);
  });
});
