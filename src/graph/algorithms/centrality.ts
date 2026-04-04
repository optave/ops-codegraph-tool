import { loadNative } from '../../infrastructure/native.js';
import type { CodeGraph } from '../model.js';

export interface FanInOut {
  fanIn: number;
  fanOut: number;
}

/**
 * Fan-in / fan-out centrality for all nodes in a CodeGraph.
 *
 * Tries the native Rust implementation first, falls back to JS.
 */
export function fanInOut(graph: CodeGraph): Map<string, FanInOut> {
  const native = loadNative();
  if (native?.fanInOut) {
    let edges = graph.toEdgeArray();
    if (!graph.directed) {
      // Undirected: toEdgeArray() deduplicates to one canonical direction;
      // mirror each edge so the Rust side counts symmetric in/out degrees.
      edges = [...edges, ...edges.map((e) => ({ source: e.target, target: e.source }))];
    }
    const nativeResult = native.fanInOut(edges);
    const result = new Map<string, FanInOut>();
    for (const entry of nativeResult) {
      result.set(entry.node, { fanIn: entry.fanIn, fanOut: entry.fanOut });
    }
    // Ensure isolated nodes (no edges) are included
    for (const id of graph.nodeIds()) {
      if (!result.has(id)) {
        result.set(id, { fanIn: 0, fanOut: 0 });
      }
    }
    return result;
  }

  return fanInOutJS(graph);
}

/** Pure JS fallback for fan-in/out. */
function fanInOutJS(graph: CodeGraph): Map<string, FanInOut> {
  const result = new Map<string, FanInOut>();
  for (const id of graph.nodeIds()) {
    result.set(id, {
      fanIn: graph.inDegree(id),
      fanOut: graph.outDegree(id),
    });
  }
  return result;
}
