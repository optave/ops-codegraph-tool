import { getCallableNodes, getCallEdges, getFileNodesAll, getImportEdges } from '../../db/index.js';
import { loadNative } from '../../infrastructure/native.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import type { BetterSqlite3Database } from '../../types.js';

/**
 * Find cycles using Tarjan's SCC algorithm.
 *
 * Builds a label-based adjacency list directly from DB rows — no intermediate
 * CodeGraph construction. This is O(V + E) with minimal memory overhead.
 */
export function findCycles(
  db: BetterSqlite3Database,
  opts: { fileLevel?: boolean; noTests?: boolean } = {},
): string[][] {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;

  const edges: Array<{ source: string; target: string }> = [];
  const seen = new Set<string>();

  if (fileLevel) {
    let nodes = getFileNodesAll(db);
    if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));
    const nodeIds = new Set<number>();
    const idToFile = new Map<number, string>();
    for (const n of nodes) {
      nodeIds.add(n.id);
      idToFile.set(n.id, n.file);
    }
    for (const e of getImportEdges(db)) {
      if (!nodeIds.has(e.source_id) || !nodeIds.has(e.target_id)) continue;
      if (e.source_id === e.target_id) continue;
      const src = idToFile.get(e.source_id)!;
      const tgt = idToFile.get(e.target_id)!;
      const key = `${src}\0${tgt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: src, target: tgt });
    }
  } else {
    let nodes = getCallableNodes(db);
    if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));
    const nodeIds = new Set<number>();
    const idToLabel = new Map<number, string>();
    for (const n of nodes) {
      nodeIds.add(n.id);
      idToLabel.set(n.id, `${n.name}|${n.file}`);
    }
    for (const e of getCallEdges(db)) {
      if (!nodeIds.has(e.source_id) || !nodeIds.has(e.target_id)) continue;
      if (e.source_id === e.target_id) continue;
      const src = idToLabel.get(e.source_id)!;
      const tgt = idToLabel.get(e.target_id)!;
      const key = `${src}\0${tgt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: src, target: tgt });
    }
  }

  const native = loadNative();
  if (native) {
    return native.detectCycles(edges) as string[][];
  }

  return tarjanFromEdges(edges);
}

export function findCyclesJS(edges: Array<{ source: string; target: string }>): string[][] {
  return tarjanFromEdges(edges);
}

/**
 * Run Tarjan's SCC on a flat edge list. Returns SCCs with length > 1 (cycles).
 * Uses a simple adjacency-list Map instead of a full CodeGraph.
 */
function tarjanFromEdges(edges: Array<{ source: string; target: string }>): string[][] {
  const adj = new Map<string, string[]>();
  const allNodes = new Set<string>();
  for (const { source, target } of edges) {
    allNodes.add(source);
    allNodes.add(target);
    let list = adj.get(source);
    if (!list) {
      list = [];
      adj.set(source, list);
    }
    list.push(target);
  }

  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const sccs: string[][] = [];

  function strongconnect(v: string): void {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    const successors = adj.get(v);
    if (successors) {
      for (const w of successors) {
        if (!indices.has(w)) {
          strongconnect(w);
          lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
        } else if (onStack.has(w)) {
          lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
        }
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) sccs.push(scc);
    }
  }

  for (const id of allNodes) {
    if (!indices.has(id)) strongconnect(id);
  }

  return sccs;
}

export function formatCycles(cycles: string[][]): string {
  if (cycles.length === 0) {
    return 'No circular dependencies detected.';
  }

  const lines: string[] = [`Found ${cycles.length} circular dependency cycle(s):\n`];
  for (let i = 0; i < cycles.length; i++) {
    const cycle = cycles[i]!;
    lines.push(`  Cycle ${i + 1} (${cycle.length} files):`);
    for (const file of cycle) {
      lines.push(`    -> ${file}`);
    }
    lines.push(`    -> ${cycle[0]} (back to start)`);
    lines.push('');
  }
  return lines.join('\n');
}
