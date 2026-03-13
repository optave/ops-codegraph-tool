/**
 * Breadth-first traversal on a CodeGraph.
 *
 * @param {import('../model.js').CodeGraph} graph
 * @param {string|string[]} startIds - One or more starting node IDs
 * @param {{ maxDepth?: number, direction?: 'forward'|'backward'|'both' }} [opts]
 * @returns {Map<string, number>} nodeId → depth from nearest start node
 */
export function bfs(graph, startIds, opts = {}) {
  const maxDepth = opts.maxDepth ?? Infinity;
  const direction = opts.direction ?? 'forward';
  const starts = Array.isArray(startIds) ? startIds : [startIds];

  const depths = new Map();
  const queue = [];

  for (const id of starts) {
    const key = String(id);
    if (graph.hasNode(key)) {
      depths.set(key, 0);
      queue.push(key);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    const depth = depths.get(current);
    if (depth >= maxDepth) continue;

    let neighbors;
    if (direction === 'forward') {
      neighbors = graph.successors(current);
    } else if (direction === 'backward') {
      neighbors = graph.predecessors(current);
    } else {
      neighbors = graph.neighbors(current);
    }

    for (const n of neighbors) {
      if (!depths.has(n)) {
        depths.set(n, depth + 1);
        queue.push(n);
      }
    }
  }

  return depths;
}
