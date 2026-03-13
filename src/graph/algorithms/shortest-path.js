/**
 * BFS-based shortest path on a CodeGraph.
 *
 * @param {import('../model.js').CodeGraph} graph
 * @param {string} fromId
 * @param {string} toId
 * @returns {string[]|null} Path from fromId to toId (inclusive), or null if unreachable
 */
export function shortestPath(graph, fromId, toId) {
  const from = String(fromId);
  const to = String(toId);

  if (!graph.hasNode(from) || !graph.hasNode(to)) return null;
  if (from === to) return [from];

  const parent = new Map();
  parent.set(from, null);
  const queue = [from];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++];
    for (const neighbor of graph.successors(current)) {
      if (parent.has(neighbor)) continue;
      parent.set(neighbor, current);
      if (neighbor === to) {
        // Reconstruct path
        const path = [];
        let node = to;
        while (node !== null) {
          path.push(node);
          node = parent.get(node);
        }
        return path.reverse();
      }
      queue.push(neighbor);
    }
  }

  return null;
}
