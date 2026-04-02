/**
 * Execution flow tracing — forward BFS from entry points through callees to leaves.
 *
 * Answers "what happens when a user hits POST /login?" by tracing from
 * framework entry points (routes, commands, events) through their call chains.
 */

import { openReadonlyOrFail } from '../db/index.js';
import { CORE_SYMBOL_KINDS, findMatchingNodes } from '../domain/queries.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import { paginateResult } from '../shared/paginate.js';
import { FRAMEWORK_ENTRY_PREFIXES } from './structure.js';

export function entryPointType(name: string): 'route' | 'event' | 'command' | 'exported' | null {
  for (const prefix of FRAMEWORK_ENTRY_PREFIXES) {
    if (name.startsWith(prefix)) {
      return prefix.slice(0, -1) as 'route' | 'event' | 'command'; // 'route:', 'event:', 'command:' → 'route', 'event', 'command'
    }
  }
  return null;
}

interface EntryPointRow {
  name: string;
  kind: string;
  file: string;
  line: number;
  role: string | null;
}

export function listEntryPointsData(
  dbPath?: string,
  opts: { noTests?: boolean; limit?: number; offset?: number } = {},
): Record<string, unknown> {
  const db = openReadonlyOrFail(dbPath);
  try {
    const noTests = opts.noTests || false;

    // Find all framework-prefixed nodes
    const prefixConditions = FRAMEWORK_ENTRY_PREFIXES.map(() => 'n.name LIKE ?').join(' OR ');
    const prefixParams = FRAMEWORK_ENTRY_PREFIXES.map((p) => `${p}%`);

    let rows = db
      .prepare<EntryPointRow>(
        `SELECT n.name, n.kind, n.file, n.line, n.role
         FROM nodes n
         WHERE (
           (${prefixConditions})
           OR n.role = 'entry'
         )
           AND n.kind NOT IN ('file', 'directory')
         ORDER BY n.name`,
      )
      .all(...prefixParams);

    if (noTests) rows = rows.filter((r) => !isTestFile(r.file));

    const entries = rows.map((r) => ({
      name: r.name,
      kind: r.kind,
      file: r.file,
      line: r.line,
      role: r.role,
      type: entryPointType(r.name) || (r.role === 'entry' ? 'exported' : null),
    }));

    const byType: Record<string, typeof entries> = {};
    for (const e of entries) {
      const t = e.type || 'other';
      if (!byType[t]) byType[t] = [];
      byType[t].push(e);
    }

    const base = { entries, byType, count: entries.length };
    return paginateResult(base, 'entries', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

interface CalleeRow {
  id: number;
  name: string;
  kind: string;
  file: string;
  line: number;
  role: string | null;
}

interface NodeInfo {
  name: string;
  kind: string;
  file: string;
  line: number;
  role?: string | null;
  type?: string;
}

/** Resolve the entry node by direct match or framework-prefix matching. */
function resolveEntryNode(
  db: ReturnType<typeof openReadonlyOrFail>,
  name: string,
  flowOpts: { noTests?: boolean; file?: string; kinds?: string[] },
): {
  id: number;
  name: string;
  kind: string;
  file: string;
  line: number;
  role?: string | null;
} | null {
  // Phase 1: Direct LIKE match on full name
  let matchNode = findMatchingNodes(db, name, flowOpts)[0] ?? null;

  // Phase 2: Prefix-stripped matching — try adding framework prefixes
  if (!matchNode) {
    for (const prefix of FRAMEWORK_ENTRY_PREFIXES) {
      matchNode = findMatchingNodes(db, `${prefix}${name}`, flowOpts)[0] ?? null;
      if (matchNode) break;
    }
  }

  return matchNode;
}

interface BfsState {
  visited: Set<number>;
  steps: Array<{ depth: number; nodes: NodeInfo[] }>;
  cycles: Array<{ from: string; to: string; depth: number }>;
  nodeDepths: Map<number, number>;
  idToNode: Map<number, NodeInfo>;
  truncated: boolean;
}

/** Forward BFS through callees, collecting steps, cycles, and node depth info. */
function bfsCallees(
  db: ReturnType<typeof openReadonlyOrFail>,
  entryId: number,
  entryInfo: NodeInfo,
  maxDepth: number,
  noTests: boolean,
): BfsState {
  const visited = new Set<number>([entryId]);
  let frontier = [entryId];
  const steps: Array<{ depth: number; nodes: NodeInfo[] }> = [];
  const cycles: Array<{ from: string; to: string; depth: number }> = [];
  const nodeDepths = new Map<number, number>();
  const idToNode = new Map<number, NodeInfo>();
  idToNode.set(entryId, entryInfo);
  let truncated = false;

  const calleesStmt = db.prepare<CalleeRow>(
    `SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line, n.role
     FROM edges e JOIN nodes n ON e.target_id = n.id
     WHERE e.source_id = ? AND e.kind = 'calls'`,
  );

  for (let d = 1; d <= maxDepth; d++) {
    const nextFrontier: number[] = [];
    const levelNodes: NodeInfo[] = [];

    for (const fid of frontier) {
      const callees = calleesStmt.all(fid);

      for (const c of callees) {
        if (noTests && isTestFile(c.file)) continue;

        if (visited.has(c.id)) {
          const fromNode = idToNode.get(fid);
          if (fromNode) {
            cycles.push({ from: fromNode.name, to: c.name, depth: d });
          }
          continue;
        }

        visited.add(c.id);
        nextFrontier.push(c.id);
        const nodeInfo: NodeInfo = { name: c.name, kind: c.kind, file: c.file, line: c.line };
        levelNodes.push(nodeInfo);
        nodeDepths.set(c.id, d);
        idToNode.set(c.id, nodeInfo);
      }
    }

    if (levelNodes.length > 0) {
      steps.push({ depth: d, nodes: levelNodes });
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
    if (d === maxDepth && frontier.length > 0) truncated = true;
  }

  return { visited, steps, cycles, nodeDepths, idToNode, truncated };
}

/** Identify leaf nodes — visited nodes with no outgoing 'calls' edges. */
function findLeafNodes(
  db: ReturnType<typeof openReadonlyOrFail>,
  nodeDepths: Map<number, number>,
  idToNode: Map<number, NodeInfo>,
): Array<NodeInfo & { depth: number }> {
  const leaves: Array<NodeInfo & { depth: number }> = [];
  const outgoingStmt = db.prepare<{ id: number }>(
    `SELECT DISTINCT n.id
     FROM edges e JOIN nodes n ON e.target_id = n.id
     WHERE e.source_id = ? AND e.kind = 'calls'`,
  );

  for (const [id, depth] of nodeDepths) {
    const outgoing = outgoingStmt.all(id);
    if (outgoing.length === 0) {
      const node = idToNode.get(id);
      if (node) leaves.push({ ...node, depth });
    }
  }

  return leaves;
}

export function flowData(
  name: string,
  dbPath?: string,
  opts: {
    depth?: number;
    noTests?: boolean;
    file?: string;
    kind?: string;
    limit?: number;
    offset?: number;
  } = {},
): Record<string, unknown> {
  const db = openReadonlyOrFail(dbPath);
  try {
    const maxDepth = opts.depth || 10;
    const noTests = opts.noTests || false;
    const flowOpts = {
      ...opts,
      kinds: opts.kind ? [opts.kind] : (CORE_SYMBOL_KINDS as unknown as string[]),
    };

    const matchNode = resolveEntryNode(db, name, flowOpts);

    if (!matchNode) {
      return {
        entry: null,
        depth: maxDepth,
        steps: [],
        leaves: [],
        cycles: [],
        totalReached: 0,
        truncated: false,
      };
    }

    const epType = entryPointType(matchNode.name);
    const entry: NodeInfo = {
      name: matchNode.name,
      kind: matchNode.kind,
      file: matchNode.file,
      line: matchNode.line,
      type: epType || 'exported',
      role: matchNode.role,
    };

    const bfs = bfsCallees(db, matchNode.id, entry, maxDepth, noTests);
    const leaves = findLeafNodes(db, bfs.nodeDepths, bfs.idToNode);

    const base = {
      entry,
      depth: maxDepth,
      steps: bfs.steps,
      leaves,
      cycles: bfs.cycles,
      totalReached: bfs.visited.size - 1,
      truncated: bfs.truncated,
    };
    return paginateResult(base, 'steps', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}
