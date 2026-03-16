import { tarjan } from '../../graph/algorithms/tarjan.js';
import { buildDependencyGraph } from '../../graph/builders/dependency.js';
import { CodeGraph } from '../../graph/model.js';
import { loadNative } from '../../native.js';

/**
 * Detect circular dependencies in the codebase using Tarjan's SCC algorithm.
 * Dispatches to native Rust implementation when available, falls back to JS.
 * @param {object} db - Open SQLite database
 * @param {object} opts - { fileLevel: true, noTests: false }
 * @returns {string[][]} Array of cycles, each cycle is an array of file paths
 */
export function findCycles(db, opts = {}) {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;

  const graph = buildDependencyGraph(db, { fileLevel, noTests });

  // Build a label map: DB string ID → human-readable key
  // File-level: file path; Function-level: name|file composite (for native Rust compat)
  const idToLabel = new Map();
  for (const [id, attrs] of graph.nodes()) {
    if (fileLevel) {
      idToLabel.set(id, attrs.file);
    } else {
      idToLabel.set(id, `${attrs.label}|${attrs.file}`);
    }
  }

  // Build edge array with human-readable keys (for native engine)
  const edges = graph.toEdgeArray().map((e) => ({
    source: idToLabel.get(e.source),
    target: idToLabel.get(e.target),
  }));

  // Try native Rust implementation
  const native = loadNative();
  if (native) {
    return native.detectCycles(edges);
  }

  // Fallback: JS Tarjan via graph subsystem
  // Re-key graph with human-readable labels for consistent output
  const labelGraph = new CodeGraph();
  for (const { source, target } of edges) {
    labelGraph.addEdge(source, target);
  }
  return tarjan(labelGraph);
}

/**
 * Pure-JS Tarjan's SCC implementation.
 * Kept for backward compatibility — accepts raw {source, target}[] edges.
 */
export function findCyclesJS(edges) {
  const graph = new CodeGraph();
  for (const { source, target } of edges) {
    graph.addEdge(source, target);
  }
  return tarjan(graph);
}

/**
 * Format cycles for human-readable output.
 */
export function formatCycles(cycles) {
  if (cycles.length === 0) {
    return 'No circular dependencies detected.';
  }

  const lines = [`Found ${cycles.length} circular dependency cycle(s):\n`];
  for (let i = 0; i < cycles.length; i++) {
    const cycle = cycles[i];
    lines.push(`  Cycle ${i + 1} (${cycle.length} files):`);
    for (const file of cycle) {
      lines.push(`    -> ${file}`);
    }
    lines.push(`    -> ${cycle[0]} (back to start)`);
    lines.push('');
  }
  return lines.join('\n');
}
