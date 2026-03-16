/**
 * Fan-in / fan-out centrality for all nodes in a CodeGraph.
 *
 * @param {import('../model.js').CodeGraph} graph
 * @returns {Map<string, { fanIn: number, fanOut: number }>}
 */
export function fanInOut(graph) {
  const result = new Map();
  for (const id of graph.nodeIds()) {
    result.set(id, {
      fanIn: graph.inDegree(id),
      fanOut: graph.outDegree(id),
    });
  }
  return result;
}
