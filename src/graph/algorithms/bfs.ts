import { loadNative } from '../../infrastructure/native.js';
import type { CodeGraph } from '../model.js';

export interface BfsOpts {
  maxDepth?: number;
  direction?: 'forward' | 'backward' | 'both';
}

/**
 * Breadth-first traversal on a CodeGraph.
 *
 * Tries the native Rust implementation first, falls back to JS.
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

  const native = loadNative();
  if (native?.bfsTraversal) {
    const edges = graph.toEdgeArray();
    const nativeMaxDepth = maxDepth === Infinity ? null : maxDepth;
    const result = native.bfsTraversal(edges, starts, nativeMaxDepth, direction);
    const depths = new Map<string, number>();
    for (const entry of result) {
      depths.set(entry.node, entry.depth);
    }
    return depths;
  }

  return bfsJS(graph, starts, maxDepth, direction);
}

/** Pure JS fallback for BFS (used when native addon is unavailable). */
function bfsJS(
  graph: CodeGraph,
  starts: string[],
  maxDepth: number,
  direction: string,
): Map<string, number> {
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
