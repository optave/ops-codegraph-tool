import {
  findCallees,
  findCallers,
  findFileNodes,
  findImportSources,
  findImportTargets,
  findNodesByFile,
  openReadonlyOrFail,
} from '../../db/index.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import { resolveMethodViaHierarchy } from '../../shared/hierarchy.js';
import { normalizeSymbol } from '../../shared/normalize.js';
import { paginateResult } from '../../shared/paginate.js';
import { findMatchingNodes } from './symbol-lookup.js';

export function fileDepsData(file, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const fileNodes = findFileNodes(db, `%${file}%`);
    if (fileNodes.length === 0) {
      return { file, results: [] };
    }

    const results = fileNodes.map((fn) => {
      let importsTo = findImportTargets(db, fn.id);
      if (noTests) importsTo = importsTo.filter((i) => !isTestFile(i.file));

      let importedBy = findImportSources(db, fn.id);
      if (noTests) importedBy = importedBy.filter((i) => !isTestFile(i.file));

      const defs = findNodesByFile(db, fn.file);

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

export function fnDepsData(name, customDbPath, opts = {}) {
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
      const callees = findCallees(db, node.id);
      const filteredCallees = noTests ? callees.filter((c) => !isTestFile(c.file)) : callees;

      let callers = findCallers(db, node.id);

      if (node.kind === 'method' && node.name.includes('.')) {
        const methodName = node.name.split('.').pop();
        const relatedMethods = resolveMethodViaHierarchy(db, methodName);
        for (const rm of relatedMethods) {
          if (rm.id === node.id) continue;
          const extraCallers = findCallers(db, rm.id);
          callers.push(...extraCallers.map((c) => ({ ...c, viaHierarchy: rm.name })));
        }
      }
      if (noTests) callers = callers.filter((c) => !isTestFile(c.file));

      // Transitive callers
      const transitiveCallers = {};
      if (depth > 1) {
        const visited = new Set([node.id]);
        let frontier = callers
          .map((c) => {
            const row = db
              .prepare('SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ? AND line = ?')
              .get(c.name, c.kind, c.file, c.line);
            return row ? { ...c, id: row.id } : null;
          })
          .filter(Boolean);

        for (let d = 2; d <= depth; d++) {
          const nextFrontier = [];
          for (const f of frontier) {
            if (visited.has(f.id)) continue;
            visited.add(f.id);
            const upstream = db
              .prepare(`
              SELECT n.name, n.kind, n.file, n.line
              FROM edges e JOIN nodes n ON e.source_id = n.id
              WHERE e.target_id = ? AND e.kind = 'calls'
            `)
              .all(f.id);
            for (const u of upstream) {
              if (noTests && isTestFile(u.file)) continue;
              const uid = db
                .prepare(
                  'SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ? AND line = ?',
                )
                .get(u.name, u.kind, u.file, u.line)?.id;
              if (uid && !visited.has(uid)) {
                nextFrontier.push({ ...u, id: uid });
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
      }

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

export function pathData(from, to, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const maxDepth = opts.maxDepth || 10;
    const edgeKinds = opts.edgeKinds || ['calls'];
    const reverse = opts.reverse || false;

    const fromNodes = findMatchingNodes(db, from, {
      noTests,
      file: opts.fromFile,
      kind: opts.kind,
    });
    if (fromNodes.length === 0) {
      return {
        from,
        to,
        found: false,
        error: `No symbol matching "${from}"`,
        fromCandidates: [],
        toCandidates: [],
      };
    }

    const toNodes = findMatchingNodes(db, to, {
      noTests,
      file: opts.toFile,
      kind: opts.kind,
    });
    if (toNodes.length === 0) {
      return {
        from,
        to,
        found: false,
        error: `No symbol matching "${to}"`,
        fromCandidates: fromNodes
          .slice(0, 5)
          .map((n) => ({ name: n.name, kind: n.kind, file: n.file, line: n.line })),
        toCandidates: [],
      };
    }

    const sourceNode = fromNodes[0];
    const targetNode = toNodes[0];

    const fromCandidates = fromNodes
      .slice(0, 5)
      .map((n) => ({ name: n.name, kind: n.kind, file: n.file, line: n.line }));
    const toCandidates = toNodes
      .slice(0, 5)
      .map((n) => ({ name: n.name, kind: n.kind, file: n.file, line: n.line }));

    // Self-path
    if (sourceNode.id === targetNode.id) {
      return {
        from,
        to,
        fromCandidates,
        toCandidates,
        found: true,
        hops: 0,
        path: [
          {
            name: sourceNode.name,
            kind: sourceNode.kind,
            file: sourceNode.file,
            line: sourceNode.line,
            edgeKind: null,
          },
        ],
        alternateCount: 0,
        edgeKinds,
        reverse,
        maxDepth,
      };
    }

    // Build edge kind filter
    const kindPlaceholders = edgeKinds.map(() => '?').join(', ');

    // BFS — direction depends on `reverse` flag
    // Forward: source_id → target_id (A calls... calls B)
    // Reverse: target_id → source_id (B is called by... called by A)
    const neighborQuery = reverse
      ? `SELECT n.id, n.name, n.kind, n.file, n.line, e.kind AS edge_kind
         FROM edges e JOIN nodes n ON e.source_id = n.id
         WHERE e.target_id = ? AND e.kind IN (${kindPlaceholders})`
      : `SELECT n.id, n.name, n.kind, n.file, n.line, e.kind AS edge_kind
         FROM edges e JOIN nodes n ON e.target_id = n.id
         WHERE e.source_id = ? AND e.kind IN (${kindPlaceholders})`;
    const neighborStmt = db.prepare(neighborQuery);

    const visited = new Set([sourceNode.id]);
    // parent map: nodeId → { parentId, edgeKind }
    const parent = new Map();
    let queue = [sourceNode.id];
    let found = false;
    let alternateCount = 0;
    let foundDepth = -1;

    for (let depth = 1; depth <= maxDepth; depth++) {
      const nextQueue = [];
      for (const currentId of queue) {
        const neighbors = neighborStmt.all(currentId, ...edgeKinds);
        for (const n of neighbors) {
          if (noTests && isTestFile(n.file)) continue;
          if (n.id === targetNode.id) {
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

    // alternateCount includes the one we kept; subtract 1 for "alternates"
    alternateCount = Math.max(0, alternateCount - 1);

    // Reconstruct path from target back to source
    const pathIds = [targetNode.id];
    let cur = targetNode.id;
    while (cur !== sourceNode.id) {
      const p = parent.get(cur);
      pathIds.push(p.parentId);
      cur = p.parentId;
    }
    pathIds.reverse();

    // Build path with node info
    const nodeCache = new Map();
    const getNode = (id) => {
      if (nodeCache.has(id)) return nodeCache.get(id);
      const row = db.prepare('SELECT name, kind, file, line FROM nodes WHERE id = ?').get(id);
      nodeCache.set(id, row);
      return row;
    };

    const resultPath = pathIds.map((id, idx) => {
      const node = getNode(id);
      const edgeKind = idx === 0 ? null : parent.get(id).edgeKind;
      return { name: node.name, kind: node.kind, file: node.file, line: node.line, edgeKind };
    });

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
