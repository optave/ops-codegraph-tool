import { tarjan } from '../../graph/algorithms/tarjan.js';
import { buildDependencyGraph } from '../../graph/builders/dependency.js';
import { CodeGraph } from '../../graph/model.js';
import { loadNative } from '../../infrastructure/native.js';
import type { BetterSqlite3Database } from '../../types.js';

export function findCycles(
  db: BetterSqlite3Database,
  opts: { fileLevel?: boolean; noTests?: boolean } = {},
): string[][] {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;

  const graph = buildDependencyGraph(db, { fileLevel, noTests });

  const idToLabel = new Map<string, string>();
  for (const [id, attrs] of graph.nodes()) {
    if (fileLevel) {
      idToLabel.set(id, attrs.file as string);
    } else {
      idToLabel.set(id, `${attrs.label}|${attrs.file}`);
    }
  }

  const edges = graph.toEdgeArray().map((e) => ({
    source: idToLabel.get(e.source) ?? e.source,
    target: idToLabel.get(e.target) ?? e.target,
  }));

  const native = loadNative();
  if (native) {
    return native.detectCycles(edges) as string[][];
  }

  const labelGraph = new CodeGraph();
  for (const { source, target } of edges) {
    labelGraph.addEdge(source, target);
  }
  return tarjan(labelGraph);
}

export function findCyclesJS(edges: Array<{ source: string; target: string }>): string[][] {
  const graph = new CodeGraph();
  for (const { source, target } of edges) {
    graph.addEdge(source, target);
  }
  return tarjan(graph);
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
