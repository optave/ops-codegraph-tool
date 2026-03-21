import type { CodeGraph } from '../model.js';

export interface FanInOut {
  fanIn: number;
  fanOut: number;
}

/**
 * Fan-in / fan-out centrality for all nodes in a CodeGraph.
 */
export function fanInOut(graph: CodeGraph): Map<string, FanInOut> {
  const result = new Map<string, FanInOut>();
  for (const id of graph.nodeIds()) {
    result.set(id, {
      fanIn: graph.inDegree(id),
      fanOut: graph.outDegree(id),
    });
  }
  return result;
}
