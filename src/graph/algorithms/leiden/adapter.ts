/**
 * Graph adapter that converts a CodeGraph into the dense array format
 * expected by the Leiden optimiser.
 *
 * Vendored from ngraph.leiden (MIT) — adapted for CodeGraph.
 */

import type { CodeGraph, EdgeAttrs, NodeAttrs } from '../../model.js';
import { fget, taAdd } from './typed-array-helpers.js';

export interface EdgeEntry {
  to: number;
  w: number;
}

export interface InEdgeEntry {
  from: number;
  w: number;
}

export interface GraphAdapterOptions {
  directed?: boolean;
  linkWeight?: (attrs: EdgeAttrs) => number;
  nodeSize?: (attrs: NodeAttrs) => number;
  baseNodeIds?: string[];
}

export interface GraphAdapter {
  n: number;
  nodeIds: string[];
  idToIndex: Map<string, number>;
  size: Float64Array;
  selfLoop: Float64Array;
  strengthOut: Float64Array;
  strengthIn: Float64Array;
  outEdges: EdgeEntry[][];
  inEdges: InEdgeEntry[][];
  directed: boolean;
  totalWeight: number;
  forEachNeighbor: (i: number, cb: (to: number, w: number) => void) => void;
}

/**
 * Populate edge arrays for a directed graph. Each edge is stored once in
 * outEdges[from] and inEdges[to]. Self-loops are tracked in both the selfLoop
 * array and the adjacency lists (partition.ts accounts for this).
 */
function populateDirectedEdges(
  graph: CodeGraph,
  idToIndex: Map<string, number>,
  linkWeight: (attrs: EdgeAttrs) => number,
  selfLoop: Float64Array,
  outEdges: EdgeEntry[][],
  inEdges: InEdgeEntry[][],
  strengthOut: Float64Array,
  strengthIn: Float64Array,
): void {
  for (const [src, tgt, attrs] of graph.edges()) {
    const from = idToIndex.get(src);
    const to = idToIndex.get(tgt);
    if (from == null || to == null) continue;
    const w: number = +linkWeight(attrs) || 0;
    if (from === to) {
      taAdd(selfLoop, from, w);
      // Self-loop is intentionally kept in outEdges/inEdges as well.
      // partition.ts's moveNodeToCommunity (directed path) accounts for this
      // by subtracting selfLoopWeight once from outToOld+inFromOld to avoid
      // triple-counting (see partition.ts moveNodeToCommunity directed block).
    }
    (outEdges[from] as EdgeEntry[]).push({ to, w });
    (inEdges[to] as InEdgeEntry[]).push({ from, w });
    taAdd(strengthOut, from, w);
    taAdd(strengthIn, to, w);
  }
}

/** Fold a single a→b weight into the unordered-pair aggregate, tracking which direction(s) were seen. */
function recordUndirectedPairWeight(
  pairAgg: Map<string, { sum: number; seenAB: number; seenBA: number }>,
  a: number,
  b: number,
  w: number,
): void {
  const i = a < b ? a : b;
  const j = a < b ? b : a;
  const key = `${i}:${j}`;
  let rec = pairAgg.get(key);
  if (!rec) {
    rec = { sum: 0, seenAB: 0, seenBA: 0 };
    pairAgg.set(key, rec);
  }
  rec.sum += w;
  if (a === i) rec.seenAB = 1;
  else rec.seenBA = 1;
}

/** Aggregate raw undirected edges into one weighted record per unordered node pair. */
function aggregateUndirectedPairs(
  graph: CodeGraph,
  idToIndex: Map<string, number>,
  linkWeight: (attrs: EdgeAttrs) => number,
  selfLoop: Float64Array,
): Map<string, { sum: number; seenAB: number; seenBA: number }> {
  const pairAgg = new Map<string, { sum: number; seenAB: number; seenBA: number }>();

  for (const [src, tgt, attrs] of graph.edges()) {
    const a = idToIndex.get(src);
    const b = idToIndex.get(tgt);
    if (a == null || b == null) continue;
    const w: number = +linkWeight(attrs) || 0;
    if (a === b) {
      taAdd(selfLoop, a, w);
      continue;
    }
    recordUndirectedPairWeight(pairAgg, a, b, w);
  }

  return pairAgg;
}

/** Emit symmetrized undirected edges (averaged over any reciprocal pairs) into the adjacency lists. */
function emitUndirectedPairs(
  pairAgg: Map<string, { sum: number; seenAB: number; seenBA: number }>,
  outEdges: EdgeEntry[][],
  inEdges: InEdgeEntry[][],
  strengthOut: Float64Array,
  strengthIn: Float64Array,
): void {
  for (const [key, rec] of pairAgg.entries()) {
    const parts = key.split(':');
    const i = +(parts[0] as string);
    const j = +(parts[1] as string);
    const dirCount: number = (rec.seenAB ? 1 : 0) + (rec.seenBA ? 1 : 0);
    const w: number = dirCount > 0 ? rec.sum / dirCount : 0;
    if (w === 0) continue;
    (outEdges[i] as EdgeEntry[]).push({ to: j, w });
    (outEdges[j] as EdgeEntry[]).push({ to: i, w });
    (inEdges[i] as InEdgeEntry[]).push({ from: j, w });
    (inEdges[j] as InEdgeEntry[]).push({ from: i, w });
    taAdd(strengthOut, i, w);
    taAdd(strengthOut, j, w);
    taAdd(strengthIn, i, w);
    taAdd(strengthIn, j, w);
  }
}

/**
 * Add self-loops into adjacency and strengths.
 * Note: uses single-w convention (not standard 2w) — the modularity formulas in
 * modularity.ts are written to match this convention, keeping the system self-consistent.
 */
function applyUndirectedSelfLoops(
  n: number,
  selfLoop: Float64Array,
  outEdges: EdgeEntry[][],
  inEdges: InEdgeEntry[][],
  strengthOut: Float64Array,
  strengthIn: Float64Array,
): void {
  for (let v = 0; v < n; v++) {
    const w: number = fget(selfLoop, v);
    if (w !== 0) {
      (outEdges[v] as EdgeEntry[]).push({ to: v, w });
      (inEdges[v] as InEdgeEntry[]).push({ from: v, w });
      taAdd(strengthOut, v, w);
      taAdd(strengthIn, v, w);
    }
  }
}

/**
 * Populate edge arrays for an undirected graph. Reciprocal pairs are
 * symmetrized and averaged to produce a single weight per undirected edge.
 * Self-loops use single-w convention (matching modularity.ts formulas).
 */
function populateUndirectedEdges(
  graph: CodeGraph,
  idToIndex: Map<string, number>,
  linkWeight: (attrs: EdgeAttrs) => number,
  n: number,
  selfLoop: Float64Array,
  outEdges: EdgeEntry[][],
  inEdges: InEdgeEntry[][],
  strengthOut: Float64Array,
  strengthIn: Float64Array,
): void {
  const pairAgg = aggregateUndirectedPairs(graph, idToIndex, linkWeight, selfLoop);
  emitUndirectedPairs(pairAgg, outEdges, inEdges, strengthOut, strengthIn);
  applyUndirectedSelfLoops(n, selfLoop, outEdges, inEdges, strengthOut, strengthIn);
}

interface ResolvedAdapterOptions {
  linkWeight: (attrs: EdgeAttrs) => number;
  nodeSize: (attrs: NodeAttrs) => number;
  directed: boolean;
  baseNodeIds: string[] | undefined;
}

/** Apply GraphAdapterOptions defaults (weight=1, size=1, directed=false). */
function resolveAdapterOptions(opts: GraphAdapterOptions): ResolvedAdapterOptions {
  return {
    linkWeight:
      opts.linkWeight ||
      ((attrs) => (attrs && typeof attrs.weight === 'number' ? attrs.weight : 1)),
    nodeSize:
      opts.nodeSize || ((attrs) => (attrs && typeof attrs.size === 'number' ? attrs.size : 1)),
    directed: !!opts.directed,
    baseNodeIds: opts.baseNodeIds,
  };
}

/**
 * Build the dense node index mapping. When `baseNodeIds` is provided, node
 * order/indices are pinned to it (used to align adapters built from related
 * graphs); otherwise indices are assigned in CodeGraph iteration order.
 */
function buildNodeIndex(
  graph: CodeGraph,
  baseNodeIds: string[] | undefined,
): { nodeIds: string[]; idToIndex: Map<string, number> } {
  const nodeIds: string[] = [];
  const idToIndex = new Map<string, number>();
  if (Array.isArray(baseNodeIds) && baseNodeIds.length > 0) {
    for (let i = 0; i < baseNodeIds.length; i++) {
      const id = baseNodeIds[i] as string;
      if (!graph.hasNode(id)) throw new Error(`Missing node: ${id}`);
      idToIndex.set(id, i);
      nodeIds.push(id);
    }
  } else {
    for (const [id] of graph.nodes()) {
      idToIndex.set(id, nodeIds.length);
      nodeIds.push(id);
    }
  }
  return { nodeIds, idToIndex };
}

/** Resolve per-node sizes via the adapter's nodeSize accessor, dense-indexed. */
function computeNodeSizes(
  graph: CodeGraph,
  idToIndex: Map<string, number>,
  n: number,
  nodeSize: (attrs: NodeAttrs) => number,
): Float64Array {
  const size = new Float64Array(n);
  for (const [id, attrs] of graph.nodes()) {
    const i = idToIndex.get(id);
    if (i != null) size[i] = +nodeSize(attrs) || 0;
  }
  return size;
}

function makeForEachNeighbor(
  outEdges: EdgeEntry[][],
): (i: number, cb: (to: number, w: number) => void) => void {
  return (i, cb) => {
    const list = outEdges[i] as EdgeEntry[];
    for (let k = 0; k < list.length; k++) cb((list[k] as EdgeEntry).to, (list[k] as EdgeEntry).w);
  };
}

export function makeGraphAdapter(graph: CodeGraph, opts: GraphAdapterOptions = {}): GraphAdapter {
  const { linkWeight, nodeSize, directed, baseNodeIds } = resolveAdapterOptions(opts);
  const { nodeIds, idToIndex } = buildNodeIndex(graph, baseNodeIds);
  const n: number = nodeIds.length;

  // Storage
  const selfLoop = new Float64Array(n);
  const strengthOut = new Float64Array(n);
  const strengthIn = new Float64Array(n);

  // Edge list by source for fast iteration
  const outEdges: EdgeEntry[][] = new Array(n);
  const inEdges: InEdgeEntry[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    outEdges[i] = [];
    inEdges[i] = [];
  }

  // Populate from graph
  if (directed) {
    populateDirectedEdges(
      graph,
      idToIndex,
      linkWeight,
      selfLoop,
      outEdges,
      inEdges,
      strengthOut,
      strengthIn,
    );
  } else {
    populateUndirectedEdges(
      graph,
      idToIndex,
      linkWeight,
      n,
      selfLoop,
      outEdges,
      inEdges,
      strengthOut,
      strengthIn,
    );
  }

  const size = computeNodeSizes(graph, idToIndex, n, nodeSize);

  // Totals
  const totalWeight: number = strengthOut.reduce((a, b) => a + b, 0);

  return {
    n,
    nodeIds,
    idToIndex,
    size,
    selfLoop,
    strengthOut,
    strengthIn,
    outEdges,
    inEdges,
    directed,
    totalWeight,
    forEachNeighbor: makeForEachNeighbor(outEdges),
  };
}
