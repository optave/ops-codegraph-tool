import type { CodeGraph } from '../model.js';

export interface BfsOpts {
  maxDepth?: number;
  direction?: 'forward' | 'backward' | 'both';
}

/**
 * Breadth-first traversal on a CodeGraph.
 *
 * @returns nodeId → depth from nearest start node
 */
export function bfs(
  graph: CodeGraph,
  startIds: string | string[],
  opts: BfsOpts = {},
): Map<string, number> {
  const maxDepth = opts.maxDepth ?? Infinity;
  const direction = opts.direction ?? 'forward';
  const starts = Array.isArray(startIds) ? startIds : [startIds];

  const depths = new Map<string, number>();
  const queue: string[] = [];

  for (const id of starts) {
    const key = String(id);
    if (graph.hasNode(key)) {
      depths.set(key, 0);
      queue.push(key);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const current = queue[head++]!;
    const depth = depths.get(current)!;
    if (depth >= maxDepth) continue;

    let neighbors: string[];
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
