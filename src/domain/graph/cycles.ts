import { tarjan } from '../../graph/algorithms/tarjan.js';
import { buildDependencyGraph } from '../../graph/builders/dependency.js';
import { CodeGraph } from '../../graph/model.js';
import { loadNative } from '../../infrastructure/native.js';
import type { BetterSqlite3Database } from '../../types.js';

/**
 * Engine parity note — function-level cycle counts
 *
 * The native (Rust) and WASM engines may report different function-level cycle
 * counts even on the same codebase. This is expected behavior, not a bug in
 * the cycle detection algorithm (Tarjan SCC is identical in both engines).
 *
 * Root cause: the native engine extracts slightly more symbols and resolves
 * more call edges than WASM (e.g. 10883 nodes / 4000 calls native vs 10857
 * nodes / 3986 calls WASM on the codegraph repo). The additional precision
 * can both create new edges and — more commonly — resolve previously ambiguous
 * calls to their correct targets, which breaks false cycles that WASM reports.
 *
 * For file-level cycles the engines are in parity because import edges are
 * resolved identically. The gap only manifests at function-level granularity
 * where call-site extraction differs between the Rust and WASM parsers.
 *
 * See: https://github.com/nicobailon/codegraph/issues/597
 */
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
      idToLabel.set(id, attrs['file'] as string);
    } else {
      idToLabel.set(id, `${attrs['label']}|${attrs['file']}`);
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
