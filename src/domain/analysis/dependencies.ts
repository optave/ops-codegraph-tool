import {
  findCallees,
  findCallers,
  findFileNodes,
  findImportSources,
  findImportTargets,
  findNodesByFile,
  openReadonlyOrFail,
} from '../../db/index.js';
import { cachedStmt } from '../../db/repository/cached-stmt.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import { resolveMethodViaHierarchy } from '../../shared/hierarchy.js';
import { normalizeSymbol } from '../../shared/normalize.js';
import { paginateResult } from '../../shared/paginate.js';
import type {
  BetterSqlite3Database,
  ImportEdgeRow,
  NodeRow,
  RelatedNodeRow,
  StmtCache,
} from '../../types.js';
import { findMatchingNodes } from './symbol-lookup.js';

type UpstreamRow = { id: number; name: string; kind: string; file: string; line: number };
type NodeByIdRow = { name: string; kind: string; file: string; line: number };

const _upstreamStmtCache: StmtCache<UpstreamRow> = new WeakMap();
const _nodeByIdStmtCache: StmtCache<NodeByIdRow> = new WeakMap();

export function fileDepsData(
  file: string,
  customDbPath: string,
  opts: { noTests?: boolean; limit?: number; offset?: number } = {},
) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const fileNodes = findFileNodes(db, `%${file}%`) as NodeRow[];
    if (fileNodes.length === 0) {
      return { file, results: [] };
    }

    const results = fileNodes.map((fn) => {
      let importsTo = findImportTargets(db, fn.id) as ImportEdgeRow[];
      if (noTests) importsTo = importsTo.filter((i) => !isTestFile(i.file));

      let importedBy = findImportSources(db, fn.id) as ImportEdgeRow[];
      if (noTests) importedBy = importedBy.filter((i) => !isTestFile(i.file));

      const defs = findNodesByFile(db, fn.file) as NodeRow[];

      return {
        file: fn.file,
        imports: importsTo.map((i) => ({ file: i.file, typeOnly: i.edge_kind === 'imports-type' })),
        importedBy: importedBy.map((i) => ({ file: i.file })),
        definitions: defs.map((d) => ({ name: d.name, kind: d.kind, line: d.line })),
      };
    });

    const base = { file, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

/**
 * BFS transitive caller traversal starting from `callers` of `nodeId`.
 * Returns an object keyed by depth (2..depth) -> array of caller descriptors.
 */
function buildTransitiveCallers(
  db: BetterSqlite3Database,
  callers: Array<{ id: number; name: string; kind: string; file: string; line: number }>,
  nodeId: number,
  depth: number,
  noTests: boolean,
) {
  const transitiveCallers: Record<
    number,
    Array<{ name: string; kind: string; file: string; line: number }>
  > = {};
  if (depth <= 1) return transitiveCallers;

  const visited = new Set([nodeId]);
  let frontier = callers;

  const upstreamStmt = cachedStmt(
    _upstreamStmtCache,
    db,
    `
    SELECT n.id, n.name, n.kind, n.file, n.line
    FROM edges e JOIN nodes n ON e.source_id = n.id
    WHERE e.target_id = ? AND e.kind = 'calls'
  `,
  );

  for (let d = 2; d <= depth; d++) {
    const nextFrontier: typeof frontier = [];
    for (const f of frontier) {
      if (visited.has(f.id)) continue;
      visited.add(f.id);
      const upstream = upstreamStmt.all(f.id) as Array<{
        id: number;
        name: string;
        kind: string;
        file: string;
        line: number;
      }>;
      for (const u of upstream) {
        if (noTests && isTestFile(u.file)) continue;
        if (!visited.has(u.id)) {
          nextFrontier.push(u);
        }
      }
    }
    if (nextFrontier.length > 0) {
      transitiveCallers[d] = nextFrontier.map((n) => ({
        name: n.name,
        kind: n.kind,
        file: n.file,
        line: n.line,
      }));
    }
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return transitiveCallers;
}

export function fnDepsData(
  name: string,
  customDbPath: string,
  opts: {
    depth?: number;
    noTests?: boolean;
    file?: string;
    kind?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const depth = opts.depth || 3;
    const noTests = opts.noTests || false;
    const hc = new Map();

    const nodes = findMatchingNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    const results = nodes.map((node) => {
      const callees = findCallees(db, node.id) as RelatedNodeRow[];
      const filteredCallees = noTests ? callees.filter((c) => !isTestFile(c.file)) : callees;

      let callers: Array<RelatedNodeRow & { viaHierarchy?: string }> = findCallers(
        db,
        node.id,
      ) as RelatedNodeRow[];

      if (node.kind === 'method' && node.name.includes('.')) {
        const methodName = node.name.split('.').pop()!;
        const relatedMethods = resolveMethodViaHierarchy(db, methodName);
        for (const rm of relatedMethods) {
          if (rm.id === node.id) continue;
          const extraCallers = findCallers(db, rm.id) as RelatedNodeRow[];
          callers.push(...extraCallers.map((c) => ({ ...c, viaHierarchy: rm.name })));
        }
      }
      if (noTests) callers = callers.filter((c) => !isTestFile(c.file));

      const transitiveCallers = buildTransitiveCallers(db, callers, node.id, depth, noTests);

      return {
        ...normalizeSymbol(node, db, hc),
        callees: filteredCallees.map((c) => ({
          name: c.name,
          kind: c.kind,
          file: c.file,
          line: c.line,
        })),
        callers: callers.map((c) => ({
          name: c.name,
          kind: c.kind,
          file: c.file,
          line: c.line,
          viaHierarchy: c.viaHierarchy || undefined,
        })),
        transitiveCallers,
      };
    });

    const base = { name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

/**
 * Resolve from/to symbol names to node records.
 * Returns { sourceNode, targetNode, fromCandidates, toCandidates } on success,
 * or { earlyResult } when a caller-facing error/not-found response should be returned immediately.
 */
function resolveEndpoints(
  db: BetterSqlite3Database,
  from: string,
  to: string,
  opts: { noTests?: boolean; fromFile?: string; toFile?: string; kind?: string },
) {
  const { noTests = false } = opts;

  const fromNodes = findMatchingNodes(db, from, {
    noTests,
    file: opts.fromFile,
    kind: opts.kind,
  });
  if (fromNodes.length === 0) {
    return {
      earlyResult: {
        from,
        to,
        found: false,
        error: `No symbol matching "${from}"`,
        fromCandidates: [],
        toCandidates: [],
      },
    };
  }

  const toNodes = findMatchingNodes(db, to, {
    noTests,
    file: opts.toFile,
    kind: opts.kind,
  });
  if (toNodes.length === 0) {
    return {
      earlyResult: {
        from,
        to,
        found: false,
        error: `No symbol matching "${to}"`,
        fromCandidates: fromNodes
          .slice(0, 5)
          .map((n) => ({ name: n.name, kind: n.kind, file: n.file, line: n.line })),
        toCandidates: [],
      },
    };
  }

  const fromCandidates = fromNodes
    .slice(0, 5)
    .map((n) => ({ name: n.name, kind: n.kind, file: n.file, line: n.line }));
  const toCandidates = toNodes
    .slice(0, 5)
    .map((n) => ({ name: n.name, kind: n.kind, file: n.file, line: n.line }));

  return {
    sourceNode: fromNodes[0],
    targetNode: toNodes[0],
    fromCandidates,
    toCandidates,
  };
}

/**
 * BFS from sourceId toward targetId.
 * Returns { found, parent, alternateCount, foundDepth }.
 * `parent` maps nodeId -> { parentId, edgeKind }.
 */
function bfsShortestPath(
  db: BetterSqlite3Database,
  sourceId: number,
  targetId: number,
  edgeKinds: string[],
  reverse: boolean,
  maxDepth: number,
  noTests: boolean,
) {
  const kindPlaceholders = edgeKinds.map(() => '?').join(', ');

  // Forward: source_id -> target_id (A calls... calls B)
  // Reverse: target_id -> source_id (B is called by... called by A)
  const neighborQuery = reverse
    ? `SELECT n.id, n.name, n.kind, n.file, n.line, e.kind AS edge_kind
       FROM edges e JOIN nodes n ON e.source_id = n.id
       WHERE e.target_id = ? AND e.kind IN (${kindPlaceholders})`
    : `SELECT n.id, n.name, n.kind, n.file, n.line, e.kind AS edge_kind
       FROM edges e JOIN nodes n ON e.target_id = n.id
       WHERE e.source_id = ? AND e.kind IN (${kindPlaceholders})`;
  const neighborStmt = db.prepare(neighborQuery);

  const visited = new Set([sourceId]);
  const parent = new Map<number, { parentId: number; edgeKind: string }>();
  let queue = [sourceId];
  let found = false;
  let alternateCount = 0;
  let foundDepth = -1;

  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextQueue: number[] = [];
    for (const currentId of queue) {
      const neighbors = neighborStmt.all(currentId, ...edgeKinds) as Array<{
        id: number;
        name: string;
        kind: string;
        file: string;
        line: number;
        edge_kind: string;
      }>;
      for (const n of neighbors) {
        if (noTests && isTestFile(n.file)) continue;
        if (n.id === targetId) {
          if (!found) {
            found = true;
            foundDepth = depth;
            parent.set(n.id, { parentId: currentId, edgeKind: n.edge_kind });
          }
          alternateCount++;
          continue;
        }
        if (!visited.has(n.id)) {
          visited.add(n.id);
          parent.set(n.id, { parentId: currentId, edgeKind: n.edge_kind });
          nextQueue.push(n.id);
        }
      }
    }
    if (found) break;
    queue = nextQueue;
    if (queue.length === 0) break;
  }

  return { found, parent, alternateCount, foundDepth };
}

/**
 * Walk the parent map from targetId back to sourceId and return an ordered
 * array of node IDs source -> target.
 */
function reconstructPath(
  db: BetterSqlite3Database,
  pathIds: number[],
  parent: Map<number, { parentId: number; edgeKind: string }>,
) {
  const nodeCache = new Map<number, NodeByIdRow>();
  const nodeByIdStmt = cachedStmt(
    _nodeByIdStmtCache,
    db,
    'SELECT name, kind, file, line FROM nodes WHERE id = ?',
  );
  const getNode = (id: number) => {
    if (nodeCache.has(id)) return nodeCache.get(id)!;
    const row = nodeByIdStmt.get(id) as {
      name: string;
      kind: string;
      file: string;
      line: number;
    };
    nodeCache.set(id, row);
    return row;
  };

  return pathIds.map((id, idx) => {
    const node = getNode(id);
    const edgeKind = idx === 0 ? null : parent.get(id)!.edgeKind;
    return { name: node.name, kind: node.kind, file: node.file, line: node.line, edgeKind };
  });
}

export function pathData(
  from: string,
  to: string,
  customDbPath: string,
  opts: {
    noTests?: boolean;
    maxDepth?: number;
    edgeKinds?: string[];
    reverse?: boolean;
    fromFile?: string;
    toFile?: string;
    kind?: string;
  } = {},
) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const maxDepth = opts.maxDepth || 10;
    const edgeKinds = opts.edgeKinds || ['calls'];
    const reverse = opts.reverse || false;

    const resolved = resolveEndpoints(db, from, to, {
      noTests,
      fromFile: opts.fromFile,
      toFile: opts.toFile,
      kind: opts.kind,
    });
    if ('earlyResult' in resolved) return resolved.earlyResult;

    const { sourceNode, targetNode, fromCandidates, toCandidates } = resolved;

    // Self-path
    if (sourceNode!.id === targetNode!.id) {
      return {
        from,
        to,
        fromCandidates,
        toCandidates,
        found: true,
        hops: 0,
        path: [
          {
            name: sourceNode!.name,
            kind: sourceNode!.kind,
            file: sourceNode!.file,
            line: sourceNode!.line,
            edgeKind: null,
          },
        ],
        alternateCount: 0,
        edgeKinds,
        reverse,
        maxDepth,
      };
    }

    const {
      found,
      parent,
      alternateCount: rawAlternateCount,
      foundDepth,
    } = bfsShortestPath(db, sourceNode!.id, targetNode!.id, edgeKinds, reverse, maxDepth, noTests);

    if (!found) {
      return {
        from,
        to,
        fromCandidates,
        toCandidates,
        found: false,
        hops: null,
        path: [],
        alternateCount: 0,
        edgeKinds,
        reverse,
        maxDepth,
      };
    }

    // rawAlternateCount includes the one we kept; subtract 1 for "alternates"
    const alternateCount = Math.max(0, rawAlternateCount - 1);

    // Reconstruct path from target back to source
    const pathIds = [targetNode!.id];
    let cur = targetNode!.id;
    while (cur !== sourceNode!.id) {
      const p = parent.get(cur)!;
      pathIds.push(p.parentId);
      cur = p.parentId;
    }
    pathIds.reverse();

    const resultPath = reconstructPath(db, pathIds, parent);

    return {
      from,
      to,
      fromCandidates,
      toCandidates,
      found: true,
      hops: foundDepth,
      path: resultPath,
      alternateCount,
      edgeKinds,
      reverse,
      maxDepth,
    };
  } finally {
    db.close();
  }
}
