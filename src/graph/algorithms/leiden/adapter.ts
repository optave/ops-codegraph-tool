/**
 * Graph adapter that converts a CodeGraph into the dense array format
 * expected by the Leiden optimiser.
 *
 * Vendored from ngraph.leiden (MIT) — adapted for CodeGraph.
 */

import type { CodeGraph, EdgeAttrs, NodeAttrs } from '../../model.js';

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

// Typed arrays always return a number for in-bounds access, but noUncheckedIndexedAccess
// widens the return to `number | undefined`. These helpers wrap compound assignment
// patterns (+=, -=) that appear frequently in this performance-critical code.
function taGet(a: Float64Array, i: number): number {
  return a[i] as number;
}

function taAdd(a: Float64Array, i: number, v: number): void {
  a[i] = taGet(a, i) + v;
}

function _taSub(a: Float64Array, i: number, v: number): void {
  a[i] = taGet(a, i) - v;
}

export function makeGraphAdapter(graph: CodeGraph, opts: GraphAdapterOptions = {}): GraphAdapter {
  const linkWeight: (attrs: EdgeAttrs) => number =
    opts.linkWeight ||
    // biome-ignore lint/complexity/useLiteralKeys: index signature requires bracket access
    ((attrs) => (attrs && typeof attrs['weight'] === 'number' ? attrs['weight'] : 1));
  const nodeSize: (attrs: NodeAttrs) => number =
    // biome-ignore lint/complexity/useLiteralKeys: index signature requires bracket access
    opts.nodeSize || ((attrs) => (attrs && typeof attrs['size'] === 'number' ? attrs['size'] : 1));
  const directed: boolean = !!opts.directed;
  const baseNodeIds: string[] | undefined = opts.baseNodeIds;

  // Build dense node index mapping
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
  const n: number = nodeIds.length;

  // Storage
  const size = new Float64Array(n);
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
  } else {
    // Undirected: symmetrize and average reciprocal pairs
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

    // Add self-loops into adjacency and strengths.
    // Note: uses single-w convention (not standard 2w) — the modularity formulas in
    // modularity.ts are written to match this convention, keeping the system self-consistent.
    for (let v = 0; v < n; v++) {
      const w: number = taGet(selfLoop, v);
      if (w !== 0) {
        (outEdges[v] as EdgeEntry[]).push({ to: v, w });
        (inEdges[v] as InEdgeEntry[]).push({ from: v, w });
        taAdd(strengthOut, v, w);
        taAdd(strengthIn, v, w);
      }
    }
  }

  // Node sizes
  for (const [id, attrs] of graph.nodes()) {
    const i = idToIndex.get(id);
    if (i != null) size[i] = +nodeSize(attrs) || 0;
  }

  // Totals
  const totalWeight: number = strengthOut.reduce((a, b) => a + b, 0);

  function forEachNeighbor(i: number, cb: (to: number, w: number) => void): void {
    const list = outEdges[i] as EdgeEntry[];
    for (let k = 0; k < list.length; k++) cb((list[k] as EdgeEntry).to, (list[k] as EdgeEntry).w);
  }

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
    forEachNeighbor,
  };
}
