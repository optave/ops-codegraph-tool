import { isTestFile } from './infrastructure/test-filter.js';
import { loadNative } from './native.js';

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

  // Build adjacency list from SQLite (stays in JS — only the algorithm can move to Rust)
  let edges;
  if (fileLevel) {
    edges = db
      .prepare(`
      SELECT DISTINCT n1.file AS source, n2.file AS target
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE n1.file != n2.file AND e.kind IN ('imports', 'imports-type')
    `)
      .all();
    if (noTests) {
      edges = edges.filter((e) => !isTestFile(e.source) && !isTestFile(e.target));
    }
  } else {
    edges = db
      .prepare(`
      SELECT DISTINCT
        (n1.name || '|' || n1.file) AS source,
        (n2.name || '|' || n2.file) AS target
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE n1.kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module')
        AND n2.kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module')
        AND e.kind = 'calls'
        AND n1.id != n2.id
    `)
      .all();
    if (noTests) {
      edges = edges.filter((e) => {
        const sourceFile = e.source.split('|').pop();
        const targetFile = e.target.split('|').pop();
        return !isTestFile(sourceFile) && !isTestFile(targetFile);
      });
    }
  }

  // Try native Rust implementation
  const native = loadNative();
  if (native) {
    return native.detectCycles(edges);
  }

  // Fallback: JS Tarjan
  return findCyclesJS(edges);
}

/**
 * Pure-JS Tarjan's SCC implementation.
 */
export function findCyclesJS(edges) {
  const graph = new Map();
  for (const { source, target } of edges) {
    if (!graph.has(source)) graph.set(source, []);
    graph.get(source).push(target);
    if (!graph.has(target)) graph.set(target, []);
  }

  // Tarjan's strongly connected components algorithm
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowlinks = new Map();
  const sccs = [];

  function strongconnect(v) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of graph.get(v) || []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v), lowlinks.get(w)));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v), indices.get(w)));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) sccs.push(scc);
    }
  }

  for (const node of graph.keys()) {
    if (!indices.has(node)) strongconnect(node);
  }

  return sccs;
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
