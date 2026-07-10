import { getCallableNodes, getCallEdges, getFileNodesAll, getImportEdges } from '../../db/index.js';
import { loadNative } from '../../infrastructure/native.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import type { BetterSqlite3Database } from '../../types.js';

type Edge = { source: string; target: string; speculative?: boolean };
type DbEdge = {
  source_id: number;
  target_id: number;
  confidence?: number | null;
  dynamic?: 0 | 1;
};

/**
 * A detected circular dependency, classified by how solid its evidence is.
 */
export interface Cycle {
  /** Node labels forming the cycle (file paths for file-level, `name|file` for function-level). */
  nodes: string[];
  /**
   * True when every edge that closes this cycle is a low-confidence dynamic
   * resolution (`dynamic = 1 AND confidence < 1`) — i.e. the cycle
   * disappears once those resolver guesses are excluded from the graph, so
   * it has no confirmed structural basis. See issue #1844.
   */
  speculative: boolean;
}

/**
 * An edge only counts as a low-confidence dynamic guess — not confirmed
 * structural evidence — when it's flagged dynamic *and* the resolver wasn't
 * fully confident about it. `confidence == null` is treated as confirmed
 * (unknown, not guessed) so a missing value never manufactures a false
 * "speculative" classification.
 */
function isSpeculative(e: DbEdge): boolean {
  return e.dynamic === 1 && typeof e.confidence === 'number' && e.confidence < 1;
}

/**
 * Build a label-based edge list from DB rows, filtering to known nodes and
 * deduplicating. Self-loops are skipped (Tarjan treats them as trivial SCCs).
 *
 * When multiple DB edges collapse onto the same (source, target) label pair,
 * the pair is only marked `speculative` if *every* underlying edge is — one
 * confirmed edge between two nodes is enough to make that connection real,
 * even if a separate low-confidence dynamic call also happens to link them.
 */
function buildLabelEdges(dbEdges: DbEdge[], idToLabel: Map<number, string>): Edge[] {
  const byPair = new Map<string, Edge>();
  for (const e of dbEdges) {
    if (e.source_id === e.target_id) continue;
    const src = idToLabel.get(e.source_id);
    const tgt = idToLabel.get(e.target_id);
    if (src === undefined || tgt === undefined) continue;
    const key = `${src}\0${tgt}`;
    const speculative = isSpeculative(e);
    const existing = byPair.get(key);
    if (!existing) {
      byPair.set(key, { source: src, target: tgt, speculative });
    } else if (existing.speculative && !speculative) {
      existing.speculative = false;
    }
  }
  return [...byPair.values()];
}

function buildFileLevelEdges(db: BetterSqlite3Database, noTests: boolean): Edge[] {
  let nodes = getFileNodesAll(db);
  if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));
  const idToLabel = new Map<number, string>();
  for (const n of nodes) idToLabel.set(n.id, n.file);
  return buildLabelEdges(getImportEdges(db), idToLabel);
}

function buildCallableEdges(db: BetterSqlite3Database, noTests: boolean): Edge[] {
  let nodes = getCallableNodes(db);
  if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));
  const idToLabel = new Map<number, string>();
  for (const n of nodes) idToLabel.set(n.id, `${n.name}|${n.file}`);
  return buildLabelEdges(getCallEdges(db), idToLabel);
}

/** Run Tarjan's SCC (native when available, JS fallback otherwise) on a flat edge list. */
function runTarjan(edges: Edge[]): string[][] {
  const native = loadNative();
  if (native) {
    return native.detectCycles(edges) as string[][];
  }
  return tarjanFromEdges(edges);
}

/** Canonical, order-independent key for an SCC's node set. */
function sccKey(nodes: string[]): string {
  return [...nodes].sort().join('\0');
}

/**
 * Classify each cycle found in `edges` as confirmed or speculative.
 *
 * Runs Tarjan once on the full edge set (current behavior), then — only if
 * at least one edge is speculative — runs it again on the edges that remain
 * once low-confidence dynamic edges are removed. Removing edges can only
 * shrink or split SCCs, never grow them, so any full-graph cycle whose exact
 * node set doesn't reappear in the filtered run depended on a speculative
 * edge to close it.
 *
 * A speculative edge can also *merge* a genuinely confirmed cycle into a
 * larger SCC without destroying it — e.g. confirmed `A->B, B->C, C->B` plus
 * speculative `C->A` yields one full-graph SCC `{A,B,C}`, but the confirmed
 * sub-graph still has its own real cycle `{B,C}`. Matching `allCycles`
 * node-sets against `confirmedCycles` alone would mark the whole `{A,B,C}`
 * grouping speculative and never surface `{B,C}` on its own — silently
 * dropping a real cycle whenever `excludeSpeculative` is set (#1988 follow-
 * up). Every confirmed cycle is therefore always included in its own right,
 * in addition to whichever full-graph SCCs don't exactly match one.
 */
function classifyCycles(edges: Edge[]): Cycle[] {
  const allCycles = runTarjan(edges);
  if (allCycles.length === 0) return [];

  if (!edges.some((e) => e.speculative)) {
    return allCycles.map((nodes) => ({ nodes, speculative: false }));
  }

  const confirmedEdges = edges.filter((e) => !e.speculative);
  const confirmedCycles = runTarjan(confirmedEdges);
  const confirmedKeys = new Set(confirmedCycles.map(sccKey));

  const result: Cycle[] = confirmedCycles.map((nodes) => ({ nodes, speculative: false }));
  for (const nodes of allCycles) {
    if (!confirmedKeys.has(sccKey(nodes))) {
      result.push({ nodes, speculative: true });
    }
  }
  return result;
}

/**
 * Find cycles using Tarjan's SCC algorithm.
 *
 * Builds a label-based adjacency list directly from DB rows — no intermediate
 * CodeGraph construction. This is O(V + E) with minimal memory overhead.
 *
 * By default returns every detected cycle, each flagged `speculative` when
 * its only structural basis is a low-confidence dynamic edge. Pass
 * `excludeSpeculative: true` to drop those from the result entirely.
 */
export function findCycles(
  db: BetterSqlite3Database,
  opts: { fileLevel?: boolean; noTests?: boolean; excludeSpeculative?: boolean } = {},
): Cycle[] {
  const fileLevel = opts.fileLevel !== false;
  const noTests = opts.noTests || false;

  const edges = fileLevel ? buildFileLevelEdges(db, noTests) : buildCallableEdges(db, noTests);
  const cycles = classifyCycles(edges);
  return opts.excludeSpeculative ? cycles.filter((c) => !c.speculative) : cycles;
}

export function findCyclesJS(edges: Edge[]): string[][] {
  return tarjanFromEdges(edges);
}

function buildAdjacency(edges: Edge[]): { adj: Map<string, string[]>; allNodes: Set<string> } {
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
  return { adj, allNodes };
}

/**
 * Run Tarjan's SCC on a flat edge list. Returns SCCs with length > 1 (cycles).
 * Uses a simple adjacency-list Map instead of a full CodeGraph.
 */
function tarjanFromEdges(edges: Edge[]): string[][] {
  const { adj, allNodes } = buildAdjacency(edges);

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

export function formatCycles(cycles: Cycle[]): string {
  if (cycles.length === 0) {
    return 'No circular dependencies detected.';
  }

  const lines: string[] = [`Found ${cycles.length} circular dependency cycle(s):\n`];
  for (let i = 0; i < cycles.length; i++) {
    const { nodes, speculative } = cycles[i]!;
    const tag = speculative
      ? '  [speculative — only closes via a low-confidence dynamic call]'
      : '';
    lines.push(`  Cycle ${i + 1} (${nodes.length} files):${tag}`);
    for (const file of nodes) {
      lines.push(`    -> ${file}`);
    }
    lines.push(`    -> ${nodes[0]} (back to start)`);
    lines.push('');
  }
  return lines.join('\n');
}
