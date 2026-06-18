import { loadNative } from '../../infrastructure/native.js';
import type { CodeGraph } from '../model.js';

export interface BfsOpts {
  maxDepth?: number;
  direction?: 'forward' | 'backward' | 'both';
}

/** Resolve the neighbor list for a node given traversal direction. */
function getNeighbors(graph: CodeGraph, node: string, direction: string): string[] {
  if (direction === 'forward') return graph.successors(node);
  if (direction === 'backward') return graph.predecessors(node);
  return graph.neighbors(node);
}

/**
 * Breadth-first traversal on a CodeGraph.
 *
 * Tries the native Rust implementation first, falls back to a pure-JS queue.
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
    // Undirected graphs deduplicate edges to one canonical direction in toEdgeArray(),
    // so the Rust side must traverse both directions to preserve symmetry.
    const nativeDirection = !graph.directed ? 'both' : direction;
    const result = native.bfsTraversal(edges, starts, nativeMaxDepth, nativeDirection);
    const depths = new Map<string, number>();
    for (const entry of result) {
      depths.set(entry.node, entry.depth);
    }
    // The Rust side only knows nodes referenced by edges; restore any isolated start nodes.
    for (const startId of starts) {
      if (graph.hasNode(startId) && !depths.has(startId)) {
        depths.set(startId, 0);
      }
    }
    return depths;
  }

  return bfsJS(graph, starts, maxDepth, direction);
}

/**
 * Pure-JS BFS queue (used when native addon is unavailable).
 * Separated from bfs() to keep each function's complexity within thresholds.
 */
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

    for (const n of getNeighbors(graph, current, direction)) {
      if (!depths.has(n)) {
        depths.set(n, depth + 1);
        queue.push(n);
      }
    }
  }

  return depths;
}
