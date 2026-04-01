import { loadNative } from '../../infrastructure/native.js';
import type { CodeGraph } from '../model.js';

/**
 * BFS-based shortest path on a CodeGraph.
 *
 * Tries the native Rust implementation first, falls back to JS.
 *
 * @returns Path from fromId to toId (inclusive), or null if unreachable
 */
export function shortestPath(graph: CodeGraph, fromId: string, toId: string): string[] | null {
  const from = String(fromId);
  const to = String(toId);

  if (!graph.hasNode(from) || !graph.hasNode(to)) return null;
  if (from === to) return [from];

  const native = loadNative();
  if (native?.shortestPath) {
    let edges = graph.toEdgeArray();
    if (!graph.directed) {
      // Undirected: toEdgeArray() deduplicates to one canonical direction;
      // mirror each edge so the Rust BFS can traverse in both directions.
      edges = [...edges, ...edges.map((e) => ({ source: e.target, target: e.source }))];
    }
    const result = native.shortestPath(edges, from, to);
    return result.length > 0 ? result : null;
  }

  return shortestPathJS(graph, from, to);
}

/** Pure JS fallback for shortest path. */
function shortestPathJS(graph: CodeGraph, from: string, to: string): string[] | null {
  const parent = new Map<string, string | null>();
  parent.set(from, null);
  const queue = [from];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++]!;
    for (const neighbor of graph.successors(current)) {
      if (parent.has(neighbor)) continue;
      parent.set(neighbor, current);
      if (neighbor === to) {
        const path: string[] = [];
        let node: string | null = to;
        while (node !== null) {
          path.push(node);
          node = parent.get(node) ?? null;
        }
        return path.reverse();
      }
      queue.push(neighbor);
    }
  }

  return null;
}
