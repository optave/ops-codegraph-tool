import type { CodeGraph } from '../model.js';

/**
 * BFS-based shortest path on a CodeGraph.
 *
 * @returns Path from fromId to toId (inclusive), or null if unreachable
 */
export function shortestPath(graph: CodeGraph, fromId: string, toId: string): string[] | null {
  const from = String(fromId);
  const to = String(toId);

  if (!graph.hasNode(from) || !graph.hasNode(to)) return null;
  if (from === to) return [from];

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
        // Reconstruct path
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
