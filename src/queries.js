import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateBoundaries } from './boundaries.js';
import { coChangeForFiles } from './cochange.js';
import { loadConfig } from './config.js';
import { findCycles } from './cycles.js';
import { findDbPath, openReadonlyOrFail } from './db.js';
import { debug } from './logger.js';
import { ownersForFiles } from './owners.js';
import { paginateResult, printNdjson } from './paginate.js';
import { LANGUAGE_REGISTRY } from './parser.js';

/**
 * Resolve a file path relative to repoRoot, rejecting traversal outside the repo.
 * Returns null if the resolved path escapes repoRoot.
 */
function safePath(repoRoot, file) {
  const resolved = path.resolve(repoRoot, file);
  if (!resolved.startsWith(repoRoot + path.sep) && resolved !== repoRoot) return null;
  return resolved;
}

const TEST_PATTERN = /\.(test|spec)\.|__test__|__tests__|\.stories\./;
export function isTestFile(filePath) {
  return TEST_PATTERN.test(filePath);
}

export const FALSE_POSITIVE_NAMES = new Set([
  'run',
  'get',
  'set',
  'init',
  'start',
  'handle',
  'main',
  'new',
  'create',
  'update',
  'delete',
  'process',
  'execute',
  'call',
  'apply',
  'setup',
  'render',
  'build',
  'load',
  'save',
  'find',
  'make',
  'open',
  'close',
  'reset',
  'send',
  'read',
  'write',
]);
export const FALSE_POSITIVE_CALLER_THRESHOLD = 20;

const FUNCTION_KINDS = ['function', 'method', 'class'];

// Original 10 kinds — used as default query scope
export const CORE_SYMBOL_KINDS = [
  'function',
  'method',
  'class',
  'interface',
  'type',
  'struct',
  'enum',
  'trait',
  'record',
  'module',
];

// Sub-declaration kinds (Phase 1)
export const EXTENDED_SYMBOL_KINDS = [
  'parameter',
  'property',
  'constant',
  // Phase 2 (reserved, not yet extracted):
  // 'constructor', 'namespace', 'decorator', 'getter', 'setter',
];

// Full set for --kind validation and MCP enum
export const EVERY_SYMBOL_KIND = [...CORE_SYMBOL_KINDS, ...EXTENDED_SYMBOL_KINDS];

// Backward compat: ALL_SYMBOL_KINDS stays as the core 10
export const ALL_SYMBOL_KINDS = CORE_SYMBOL_KINDS;

// ── Edge kind constants ─────────────────────────────────────────────
// Core edge kinds — coupling and dependency relationships
export const CORE_EDGE_KINDS = [
  'imports',
  'imports-type',
  'reexports',
  'calls',
  'extends',
  'implements',
  'contains',
];

// Structural edge kinds — parent/child and type relationships
export const STRUCTURAL_EDGE_KINDS = ['parameter_of', 'receiver'];

// Full set for MCP enum and validation
export const EVERY_EDGE_KIND = [...CORE_EDGE_KINDS, ...STRUCTURAL_EDGE_KINDS];

export const VALID_ROLES = ['entry', 'core', 'utility', 'adapter', 'dead', 'leaf'];

/**
 * Get all ancestor class names for a given class using extends edges.
 */
function getClassHierarchy(db, classNodeId) {
  const ancestors = new Set();
  const queue = [classNodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    const parents = db
      .prepare(`
      SELECT n.id, n.name FROM edges e JOIN nodes n ON e.target_id = n.id
      WHERE e.source_id = ? AND e.kind = 'extends'
    `)
      .all(current);
    for (const p of parents) {
      if (!ancestors.has(p.id)) {
        ancestors.add(p.id);
        queue.push(p.id);
      }
    }
  }
  return ancestors;
}

function resolveMethodViaHierarchy(db, methodName) {
  const methods = db
    .prepare(`SELECT * FROM nodes WHERE kind = 'method' AND name LIKE ?`)
    .all(`%.${methodName}`);

  const results = [...methods];
  for (const m of methods) {
    const className = m.name.split('.')[0];
    const classNode = db
      .prepare(`SELECT * FROM nodes WHERE name = ? AND kind = 'class' AND file = ?`)
      .get(className, m.file);
    if (!classNode) continue;

    const ancestors = getClassHierarchy(db, classNode.id);
    for (const ancestorId of ancestors) {
      const ancestor = db.prepare('SELECT name FROM nodes WHERE id = ?').get(ancestorId);
      if (!ancestor) continue;
      const parentMethods = db
        .prepare(`SELECT * FROM nodes WHERE name = ? AND kind = 'method'`)
        .all(`${ancestor.name}.${methodName}`);
      results.push(...parentMethods);
    }
  }
  return results;
}

/**
 * Find nodes matching a name query, ranked by relevance.
 * Scoring: exact=100, prefix=60, word-boundary=40, substring=10, plus fan-in tiebreaker.
 */
function findMatchingNodes(db, name, opts = {}) {
  const kinds = opts.kind ? [opts.kind] : FUNCTION_KINDS;
  const placeholders = kinds.map(() => '?').join(', ');
  const params = [`%${name}%`, ...kinds];

  let fileCondition = '';
  if (opts.file) {
    fileCondition = ' AND n.file LIKE ?';
    params.push(`%${opts.file}%`);
  }

  const rows = db
    .prepare(`
      SELECT n.*, COALESCE(fi.cnt, 0) AS fan_in
      FROM nodes n
      LEFT JOIN (
        SELECT target_id, COUNT(*) AS cnt FROM edges WHERE kind = 'calls' GROUP BY target_id
      ) fi ON fi.target_id = n.id
      WHERE n.name LIKE ? AND n.kind IN (${placeholders})${fileCondition}
    `)
    .all(...params);

  const nodes = opts.noTests ? rows.filter((n) => !isTestFile(n.file)) : rows;

  const lowerQuery = name.toLowerCase();
  for (const node of nodes) {
    const lowerName = node.name.toLowerCase();
    const bareName = lowerName.includes('.') ? lowerName.split('.').pop() : lowerName;

    let matchScore;
    if (lowerName === lowerQuery || bareName === lowerQuery) {
      matchScore = 100;
    } else if (lowerName.startsWith(lowerQuery) || bareName.startsWith(lowerQuery)) {
      matchScore = 60;
    } else if (lowerName.includes(`.${lowerQuery}`) || lowerName.includes(`${lowerQuery}.`)) {
      matchScore = 40;
    } else {
      matchScore = 10;
    }

    const fanInBonus = Math.min(Math.log2(node.fan_in + 1) * 5, 25);
    node._relevance = matchScore + fanInBonus;
  }

  nodes.sort((a, b) => b._relevance - a._relevance);
  return nodes;
}

export function kindIcon(kind) {
  switch (kind) {
    case 'function':
      return 'f';
    case 'class':
      return '*';
    case 'method':
      return 'o';
    case 'file':
      return '#';
    case 'interface':
      return 'I';
    case 'type':
      return 'T';
    case 'parameter':
      return 'p';
    case 'property':
      return '.';
    case 'constant':
      return 'C';
    default:
      return '-';
  }
}

// ─── Data-returning functions ───────────────────────────────────────────

export function queryNameData(name, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;
  let nodes = db.prepare(`SELECT * FROM nodes WHERE name LIKE ?`).all(`%${name}%`);
  if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));
  if (nodes.length === 0) {
    db.close();
    return { query: name, results: [] };
  }

  const hc = new Map();
  const results = nodes.map((node) => {
    let callees = db
      .prepare(`
      SELECT n.name, n.kind, n.file, n.line, e.kind as edge_kind
      FROM edges e JOIN nodes n ON e.target_id = n.id
      WHERE e.source_id = ?
    `)
      .all(node.id);

    let callers = db
      .prepare(`
      SELECT n.name, n.kind, n.file, n.line, e.kind as edge_kind
      FROM edges e JOIN nodes n ON e.source_id = n.id
      WHERE e.target_id = ?
    `)
      .all(node.id);

    if (noTests) {
      callees = callees.filter((c) => !isTestFile(c.file));
      callers = callers.filter((c) => !isTestFile(c.file));
    }

    return {
      ...normalizeSymbol(node, db, hc),
      callees: callees.map((c) => ({
        name: c.name,
        kind: c.kind,
        file: c.file,
        line: c.line,
        edgeKind: c.edge_kind,
      })),
      callers: callers.map((c) => ({
        name: c.name,
        kind: c.kind,
        file: c.file,
        line: c.line,
        edgeKind: c.edge_kind,
      })),
    };
  });

  db.close();
  const base = { query: name, results };
  return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
}

export function impactAnalysisData(file, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;
  const fileNodes = db
    .prepare(`SELECT * FROM nodes WHERE file LIKE ? AND kind = 'file'`)
    .all(`%${file}%`);
  if (fileNodes.length === 0) {
    db.close();
    return { file, sources: [], levels: {}, totalDependents: 0 };
  }

  const visited = new Set();
  const queue = [];
  const levels = new Map();

  for (const fn of fileNodes) {
    visited.add(fn.id);
    queue.push(fn.id);
    levels.set(fn.id, 0);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const level = levels.get(current);
    const dependents = db
      .prepare(`
      SELECT n.* FROM edges e JOIN nodes n ON e.source_id = n.id
      WHERE e.target_id = ? AND e.kind IN ('imports', 'imports-type')
    `)
      .all(current);
    for (const dep of dependents) {
      if (!visited.has(dep.id) && (!noTests || !isTestFile(dep.file))) {
        visited.add(dep.id);
        queue.push(dep.id);
        levels.set(dep.id, level + 1);
      }
    }
  }

  const byLevel = {};
  for (const [id, level] of levels) {
    if (level === 0) continue;
    if (!byLevel[level]) byLevel[level] = [];
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
    if (node) byLevel[level].push({ file: node.file });
  }

  db.close();
  return {
    file,
    sources: fileNodes.map((f) => f.file),
    levels: byLevel,
    totalDependents: visited.size - fileNodes.length,
  };
}

export function moduleMapData(customDbPath, limit = 20, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;

  const testFilter = noTests
    ? `AND n.file NOT LIKE '%.test.%'
      AND n.file NOT LIKE '%.spec.%'
      AND n.file NOT LIKE '%__test__%'
      AND n.file NOT LIKE '%__tests__%'
      AND n.file NOT LIKE '%.stories.%'`
    : '';

  const nodes = db
    .prepare(`
    SELECT n.*,
      (SELECT COUNT(*) FROM edges WHERE source_id = n.id AND kind NOT IN ('contains', 'parameter_of', 'receiver')) as out_edges,
      (SELECT COUNT(*) FROM edges WHERE target_id = n.id AND kind NOT IN ('contains', 'parameter_of', 'receiver')) as in_edges
    FROM nodes n
    WHERE n.kind = 'file'
      ${testFilter}
    ORDER BY (SELECT COUNT(*) FROM edges WHERE target_id = n.id AND kind NOT IN ('contains', 'parameter_of', 'receiver')) DESC
    LIMIT ?
  `)
    .all(limit);

  const topNodes = nodes.map((n) => ({
    file: n.file,
    dir: path.dirname(n.file) || '.',
    inEdges: n.in_edges,
    outEdges: n.out_edges,
    coupling: n.in_edges + n.out_edges,
  }));

  const totalNodes = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
  const totalEdges = db.prepare('SELECT COUNT(*) as c FROM edges').get().c;
  const totalFiles = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'file'").get().c;

  db.close();
  return { limit, topNodes, stats: { totalFiles, totalNodes, totalEdges } };
}

export function fileDepsData(file, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;
  const fileNodes = db
    .prepare(`SELECT * FROM nodes WHERE file LIKE ? AND kind = 'file'`)
    .all(`%${file}%`);
  if (fileNodes.length === 0) {
    db.close();
    return { file, results: [] };
  }

  const results = fileNodes.map((fn) => {
    let importsTo = db
      .prepare(`
      SELECT n.file, e.kind as edge_kind FROM edges e JOIN nodes n ON e.target_id = n.id
      WHERE e.source_id = ? AND e.kind IN ('imports', 'imports-type')
    `)
      .all(fn.id);
    if (noTests) importsTo = importsTo.filter((i) => !isTestFile(i.file));

    let importedBy = db
      .prepare(`
      SELECT n.file, e.kind as edge_kind FROM edges e JOIN nodes n ON e.source_id = n.id
      WHERE e.target_id = ? AND e.kind IN ('imports', 'imports-type')
    `)
      .all(fn.id);
    if (noTests) importedBy = importedBy.filter((i) => !isTestFile(i.file));

    const defs = db
      .prepare(`SELECT * FROM nodes WHERE file = ? AND kind != 'file' ORDER BY line`)
      .all(fn.file);

    return {
      file: fn.file,
      imports: importsTo.map((i) => ({ file: i.file, typeOnly: i.edge_kind === 'imports-type' })),
      importedBy: importedBy.map((i) => ({ file: i.file })),
      definitions: defs.map((d) => ({ name: d.name, kind: d.kind, line: d.line })),
    };
  });

  db.close();
  const base = { file, results };
  return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
}

export function fnDepsData(name, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const depth = opts.depth || 3;
  const noTests = opts.noTests || false;
  const hc = new Map();

  const nodes = findMatchingNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
  if (nodes.length === 0) {
    db.close();
    return { name, results: [] };
  }

  const results = nodes.map((node) => {
    const callees = db
      .prepare(`
      SELECT n.name, n.kind, n.file, n.line, e.kind as edge_kind
      FROM edges e JOIN nodes n ON e.target_id = n.id
      WHERE e.source_id = ? AND e.kind = 'calls'
    `)
      .all(node.id);
    const filteredCallees = noTests ? callees.filter((c) => !isTestFile(c.file)) : callees;

    let callers = db
      .prepare(`
      SELECT n.name, n.kind, n.file, n.line, e.kind as edge_kind
      FROM edges e JOIN nodes n ON e.source_id = n.id
      WHERE e.target_id = ? AND e.kind = 'calls'
    `)
      .all(node.id);

    if (node.kind === 'method' && node.name.includes('.')) {
      const methodName = node.name.split('.').pop();
      const relatedMethods = resolveMethodViaHierarchy(db, methodName);
      for (const rm of relatedMethods) {
        if (rm.id === node.id) continue;
        const extraCallers = db
          .prepare(`
          SELECT n.name, n.kind, n.file, n.line, e.kind as edge_kind
          FROM edges e JOIN nodes n ON e.source_id = n.id
          WHERE e.target_id = ? AND e.kind = 'calls'
        `)
          .all(rm.id);
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
              .prepare('SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ? AND line = ?')
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

  db.close();
  const base = { name, results };
  return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
}

export function fnImpactData(name, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const maxDepth = opts.depth || 5;
  const noTests = opts.noTests || false;
  const hc = new Map();

  const nodes = findMatchingNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
  if (nodes.length === 0) {
    db.close();
    return { name, results: [] };
  }

  const results = nodes.map((node) => {
    const visited = new Set([node.id]);
    const levels = {};
    let frontier = [node.id];

    for (let d = 1; d <= maxDepth; d++) {
      const nextFrontier = [];
      for (const fid of frontier) {
        const callers = db
          .prepare(`
          SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line
          FROM edges e JOIN nodes n ON e.source_id = n.id
          WHERE e.target_id = ? AND e.kind = 'calls'
        `)
          .all(fid);
        for (const c of callers) {
          if (!visited.has(c.id) && (!noTests || !isTestFile(c.file))) {
            visited.add(c.id);
            nextFrontier.push(c.id);
            if (!levels[d]) levels[d] = [];
            levels[d].push({ name: c.name, kind: c.kind, file: c.file, line: c.line });
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    return {
      ...normalizeSymbol(node, db, hc),
      levels,
      totalDependents: visited.size - 1,
    };
  });

  db.close();
  const base = { name, results };
  return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
}

export function pathData(from, to, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
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
    db.close();
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
    db.close();
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
    db.close();
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
    db.close();
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

  db.close();
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
}

export function symbolPath(from, to, customDbPath, opts = {}) {
  const data = pathData(from, to, customDbPath, opts);
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.error) {
    console.log(data.error);
    return;
  }

  if (!data.found) {
    const dir = data.reverse ? 'reverse ' : '';
    console.log(`No ${dir}path from "${from}" to "${to}" within ${data.maxDepth} hops.`);
    if (data.fromCandidates.length > 1) {
      console.log(
        `\n  "${from}" matched ${data.fromCandidates.length} symbols — using top match: ${data.fromCandidates[0].name} (${data.fromCandidates[0].file}:${data.fromCandidates[0].line})`,
      );
    }
    if (data.toCandidates.length > 1) {
      console.log(
        `  "${to}" matched ${data.toCandidates.length} symbols — using top match: ${data.toCandidates[0].name} (${data.toCandidates[0].file}:${data.toCandidates[0].line})`,
      );
    }
    return;
  }

  if (data.hops === 0) {
    console.log(`\n"${from}" and "${to}" resolve to the same symbol (0 hops):`);
    const n = data.path[0];
    console.log(`  ${kindIcon(n.kind)} ${n.name} (${n.kind}) -- ${n.file}:${n.line}\n`);
    return;
  }

  const dir = data.reverse ? ' (reverse)' : '';
  console.log(
    `\nPath from ${from} to ${to} (${data.hops} ${data.hops === 1 ? 'hop' : 'hops'})${dir}:\n`,
  );
  for (let i = 0; i < data.path.length; i++) {
    const n = data.path[i];
    const indent = '  '.repeat(i + 1);
    if (i === 0) {
      console.log(`${indent}${kindIcon(n.kind)} ${n.name} (${n.kind}) -- ${n.file}:${n.line}`);
    } else {
      console.log(
        `${indent}--[${n.edgeKind}]--> ${kindIcon(n.kind)} ${n.name} (${n.kind}) -- ${n.file}:${n.line}`,
      );
    }
  }

  if (data.alternateCount > 0) {
    console.log(
      `\n  (${data.alternateCount} alternate shortest ${data.alternateCount === 1 ? 'path' : 'paths'} at same depth)`,
    );
  }
  console.log();
}

/**
 * Fix #2: Shell injection vulnerability.
 * Uses execFileSync instead of execSync to prevent shell interpretation of user input.
 */
export function diffImpactData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;
  const maxDepth = opts.depth || 3;

  const dbPath = findDbPath(customDbPath);
  const repoRoot = path.resolve(path.dirname(dbPath), '..');

  // Verify we're in a git repository before running git diff
  let checkDir = repoRoot;
  let isGitRepo = false;
  while (checkDir) {
    if (fs.existsSync(path.join(checkDir, '.git'))) {
      isGitRepo = true;
      break;
    }
    const parent = path.dirname(checkDir);
    if (parent === checkDir) break;
    checkDir = parent;
  }
  if (!isGitRepo) {
    db.close();
    return { error: `Not a git repository: ${repoRoot}` };
  }

  let diffOutput;
  try {
    const args = opts.staged
      ? ['diff', '--cached', '--unified=0', '--no-color']
      : ['diff', opts.ref || 'HEAD', '--unified=0', '--no-color'];
    diffOutput = execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    db.close();
    return { error: `Failed to run git diff: ${e.message}` };
  }

  if (!diffOutput.trim()) {
    db.close();
    return {
      changedFiles: 0,
      newFiles: [],
      affectedFunctions: [],
      affectedFiles: [],
      summary: null,
    };
  }

  const changedRanges = new Map();
  const newFiles = new Set();
  let currentFile = null;
  let prevIsDevNull = false;
  for (const line of diffOutput.split('\n')) {
    if (line.startsWith('--- /dev/null')) {
      prevIsDevNull = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      prevIsDevNull = false;
      continue;
    }
    const fileMatch = line.match(/^\+\+\+ b\/(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!changedRanges.has(currentFile)) changedRanges.set(currentFile, []);
      if (prevIsDevNull) newFiles.add(currentFile);
      prevIsDevNull = false;
      continue;
    }
    const hunkMatch = line.match(/^@@ .+ \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      const start = parseInt(hunkMatch[1], 10);
      const count = parseInt(hunkMatch[2] || '1', 10);
      changedRanges.get(currentFile).push({ start, end: start + count - 1 });
    }
  }

  if (changedRanges.size === 0) {
    db.close();
    return {
      changedFiles: 0,
      newFiles: [],
      affectedFunctions: [],
      affectedFiles: [],
      summary: null,
    };
  }

  const affectedFunctions = [];
  for (const [file, ranges] of changedRanges) {
    if (noTests && isTestFile(file)) continue;
    const defs = db
      .prepare(
        `SELECT * FROM nodes WHERE file = ? AND kind IN ('function', 'method', 'class') ORDER BY line`,
      )
      .all(file);
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      const endLine = def.end_line || (defs[i + 1] ? defs[i + 1].line - 1 : 999999);
      for (const range of ranges) {
        if (range.start <= endLine && range.end >= def.line) {
          affectedFunctions.push(def);
          break;
        }
      }
    }
  }

  const allAffected = new Set();
  const functionResults = affectedFunctions.map((fn) => {
    const visited = new Set([fn.id]);
    let frontier = [fn.id];
    let totalCallers = 0;
    const levels = {};
    const edges = [];
    const idToKey = new Map();
    idToKey.set(fn.id, `${fn.file}::${fn.name}:${fn.line}`);
    for (let d = 1; d <= maxDepth; d++) {
      const nextFrontier = [];
      for (const fid of frontier) {
        const callers = db
          .prepare(`
          SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line
          FROM edges e JOIN nodes n ON e.source_id = n.id
          WHERE e.target_id = ? AND e.kind = 'calls'
        `)
          .all(fid);
        for (const c of callers) {
          if (!visited.has(c.id) && (!noTests || !isTestFile(c.file))) {
            visited.add(c.id);
            nextFrontier.push(c.id);
            allAffected.add(`${c.file}:${c.name}`);
            const callerKey = `${c.file}::${c.name}:${c.line}`;
            idToKey.set(c.id, callerKey);
            if (!levels[d]) levels[d] = [];
            levels[d].push({ name: c.name, kind: c.kind, file: c.file, line: c.line });
            edges.push({ from: idToKey.get(fid), to: callerKey });
            totalCallers++;
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }
    return {
      name: fn.name,
      kind: fn.kind,
      file: fn.file,
      line: fn.line,
      transitiveCallers: totalCallers,
      levels,
      edges,
    };
  });

  const affectedFiles = new Set();
  for (const key of allAffected) affectedFiles.add(key.split(':')[0]);

  // Look up historically coupled files from co-change data
  let historicallyCoupled = [];
  try {
    db.prepare('SELECT 1 FROM co_changes LIMIT 1').get();
    const changedFilesList = [...changedRanges.keys()];
    const coResults = coChangeForFiles(changedFilesList, db, {
      minJaccard: 0.3,
      limit: 20,
      noTests,
    });
    // Exclude files already found via static analysis
    historicallyCoupled = coResults.filter((r) => !affectedFiles.has(r.file));
  } catch {
    /* co_changes table doesn't exist — skip silently */
  }

  // Look up CODEOWNERS for changed + affected files
  let ownership = null;
  try {
    const allFilePaths = [...new Set([...changedRanges.keys(), ...affectedFiles])];
    const ownerResult = ownersForFiles(allFilePaths, repoRoot);
    if (ownerResult.affectedOwners.length > 0) {
      ownership = {
        owners: Object.fromEntries(ownerResult.owners),
        affectedOwners: ownerResult.affectedOwners,
        suggestedReviewers: ownerResult.suggestedReviewers,
      };
    }
  } catch {
    /* CODEOWNERS missing or unreadable — skip silently */
  }

  // Check boundary violations scoped to changed files
  let boundaryViolations = [];
  let boundaryViolationCount = 0;
  try {
    const config = loadConfig(repoRoot);
    const boundaryConfig = config.manifesto?.boundaries;
    if (boundaryConfig) {
      const result = evaluateBoundaries(db, boundaryConfig, {
        scopeFiles: [...changedRanges.keys()],
        noTests,
      });
      boundaryViolations = result.violations;
      boundaryViolationCount = result.violationCount;
    }
  } catch {
    /* boundary check failed — skip silently */
  }

  db.close();
  const base = {
    changedFiles: changedRanges.size,
    newFiles: [...newFiles],
    affectedFunctions: functionResults,
    affectedFiles: [...affectedFiles],
    historicallyCoupled,
    ownership,
    boundaryViolations,
    boundaryViolationCount,
    summary: {
      functionsChanged: affectedFunctions.length,
      callersAffected: allAffected.size,
      filesAffected: affectedFiles.size,
      historicallyCoupledCount: historicallyCoupled.length,
      ownersAffected: ownership ? ownership.affectedOwners.length : 0,
      boundaryViolationCount,
    },
  };
  return paginateResult(base, 'affectedFunctions', { limit: opts.limit, offset: opts.offset });
}

export function diffImpactMermaid(customDbPath, opts = {}) {
  const data = diffImpactData(customDbPath, opts);
  if (data.error) return data.error;
  if (data.changedFiles === 0 || data.affectedFunctions.length === 0) {
    return 'flowchart TB\n    none["No impacted functions detected"]';
  }

  const newFileSet = new Set(data.newFiles || []);
  const lines = ['flowchart TB'];

  // Assign stable Mermaid node IDs
  let nodeCounter = 0;
  const nodeIdMap = new Map();
  const nodeLabels = new Map();
  function nodeId(key, label) {
    if (!nodeIdMap.has(key)) {
      nodeIdMap.set(key, `n${nodeCounter++}`);
      if (label) nodeLabels.set(key, label);
    }
    return nodeIdMap.get(key);
  }

  // Register all nodes (changed functions + their callers)
  for (const fn of data.affectedFunctions) {
    nodeId(`${fn.file}::${fn.name}:${fn.line}`, fn.name);
    for (const callers of Object.values(fn.levels || {})) {
      for (const c of callers) {
        nodeId(`${c.file}::${c.name}:${c.line}`, c.name);
      }
    }
  }

  // Collect all edges and determine blast radius
  const allEdges = new Set();
  const edgeFromNodes = new Set();
  const edgeToNodes = new Set();
  const changedKeys = new Set();

  for (const fn of data.affectedFunctions) {
    changedKeys.add(`${fn.file}::${fn.name}:${fn.line}`);
    for (const edge of fn.edges || []) {
      const edgeKey = `${edge.from}|${edge.to}`;
      if (!allEdges.has(edgeKey)) {
        allEdges.add(edgeKey);
        edgeFromNodes.add(edge.from);
        edgeToNodes.add(edge.to);
      }
    }
  }

  // Blast radius: caller nodes that are never a source (leaf nodes of the impact tree)
  const blastRadiusKeys = new Set();
  for (const key of edgeToNodes) {
    if (!edgeFromNodes.has(key) && !changedKeys.has(key)) {
      blastRadiusKeys.add(key);
    }
  }

  // Intermediate callers: not changed, not blast radius
  const intermediateKeys = new Set();
  for (const key of edgeToNodes) {
    if (!changedKeys.has(key) && !blastRadiusKeys.has(key)) {
      intermediateKeys.add(key);
    }
  }

  // Group changed functions by file
  const fileGroups = new Map();
  for (const fn of data.affectedFunctions) {
    if (!fileGroups.has(fn.file)) fileGroups.set(fn.file, []);
    fileGroups.get(fn.file).push(fn);
  }

  // Emit changed-file subgraphs
  let sgCounter = 0;
  for (const [file, fns] of fileGroups) {
    const isNew = newFileSet.has(file);
    const tag = isNew ? 'new' : 'modified';
    const sgId = `sg${sgCounter++}`;
    lines.push(`    subgraph ${sgId}["${file} **(${tag})**"]`);
    for (const fn of fns) {
      const key = `${fn.file}::${fn.name}:${fn.line}`;
      lines.push(`        ${nodeIdMap.get(key)}["${fn.name}"]`);
    }
    lines.push('    end');
    const style = isNew ? 'fill:#e8f5e9,stroke:#4caf50' : 'fill:#fff3e0,stroke:#ff9800';
    lines.push(`    style ${sgId} ${style}`);
  }

  // Emit intermediate caller nodes (outside subgraphs)
  for (const key of intermediateKeys) {
    lines.push(`    ${nodeIdMap.get(key)}["${nodeLabels.get(key)}"]`);
  }

  // Emit blast radius subgraph
  if (blastRadiusKeys.size > 0) {
    const sgId = `sg${sgCounter++}`;
    lines.push(`    subgraph ${sgId}["Callers **(blast radius)**"]`);
    for (const key of blastRadiusKeys) {
      lines.push(`        ${nodeIdMap.get(key)}["${nodeLabels.get(key)}"]`);
    }
    lines.push('    end');
    lines.push(`    style ${sgId} fill:#f3e5f5,stroke:#9c27b0`);
  }

  // Emit edges (impact flows from changed fn toward callers)
  for (const edgeKey of allEdges) {
    const [from, to] = edgeKey.split('|');
    lines.push(`    ${nodeIdMap.get(from)} --> ${nodeIdMap.get(to)}`);
  }

  return lines.join('\n');
}

export function listFunctionsData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;
  const kinds = ['function', 'method', 'class'];
  const placeholders = kinds.map(() => '?').join(', ');

  const conditions = [`kind IN (${placeholders})`];
  const params = [...kinds];

  if (opts.file) {
    conditions.push('file LIKE ?');
    params.push(`%${opts.file}%`);
  }
  if (opts.pattern) {
    conditions.push('name LIKE ?');
    params.push(`%${opts.pattern}%`);
  }

  let rows = db
    .prepare(
      `SELECT name, kind, file, line, end_line, role FROM nodes WHERE ${conditions.join(' AND ')} ORDER BY file, line`,
    )
    .all(...params);

  if (noTests) rows = rows.filter((r) => !isTestFile(r.file));

  const hc = new Map();
  const functions = rows.map((r) => normalizeSymbol(r, db, hc));
  db.close();
  const base = { count: functions.length, functions };
  return paginateResult(base, 'functions', { limit: opts.limit, offset: opts.offset });
}

/**
 * Generator: stream functions one-by-one using .iterate() for memory efficiency.
 * @param {string} [customDbPath]
 * @param {object} [opts]
 * @param {boolean} [opts.noTests]
 * @param {string} [opts.file]
 * @param {string} [opts.pattern]
 * @yields {{ name: string, kind: string, file: string, line: number, role: string|null }}
 */
export function* iterListFunctions(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const kinds = ['function', 'method', 'class'];
    const placeholders = kinds.map(() => '?').join(', ');

    const conditions = [`kind IN (${placeholders})`];
    const params = [...kinds];

    if (opts.file) {
      conditions.push('file LIKE ?');
      params.push(`%${opts.file}%`);
    }
    if (opts.pattern) {
      conditions.push('name LIKE ?');
      params.push(`%${opts.pattern}%`);
    }

    const stmt = db.prepare(
      `SELECT name, kind, file, line, end_line, role FROM nodes WHERE ${conditions.join(' AND ')} ORDER BY file, line`,
    );
    for (const row of stmt.iterate(...params)) {
      if (noTests && isTestFile(row.file)) continue;
      yield {
        name: row.name,
        kind: row.kind,
        file: row.file,
        line: row.line,
        endLine: row.end_line ?? null,
        role: row.role ?? null,
      };
    }
  } finally {
    db.close();
  }
}

/**
 * Generator: stream role-classified symbols one-by-one.
 * @param {string} [customDbPath]
 * @param {object} [opts]
 * @param {boolean} [opts.noTests]
 * @param {string} [opts.role]
 * @param {string} [opts.file]
 * @yields {{ name: string, kind: string, file: string, line: number, endLine: number|null, role: string }}
 */
export function* iterRoles(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const conditions = ['role IS NOT NULL'];
    const params = [];

    if (opts.role) {
      conditions.push('role = ?');
      params.push(opts.role);
    }
    if (opts.file) {
      conditions.push('file LIKE ?');
      params.push(`%${opts.file}%`);
    }

    const stmt = db.prepare(
      `SELECT name, kind, file, line, end_line, role FROM nodes WHERE ${conditions.join(' AND ')} ORDER BY role, file, line`,
    );
    for (const row of stmt.iterate(...params)) {
      if (noTests && isTestFile(row.file)) continue;
      yield {
        name: row.name,
        kind: row.kind,
        file: row.file,
        line: row.line,
        endLine: row.end_line ?? null,
        role: row.role ?? null,
      };
    }
  } finally {
    db.close();
  }
}

/**
 * Generator: stream symbol lookup results one-by-one.
 * @param {string} target - Symbol name to search for (partial match)
 * @param {string} [customDbPath]
 * @param {object} [opts]
 * @param {boolean} [opts.noTests]
 * @yields {{ name: string, kind: string, file: string, line: number, role: string|null, exported: boolean, uses: object[] }}
 */
export function* iterWhere(target, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const placeholders = ALL_SYMBOL_KINDS.map(() => '?').join(', ');
    const stmt = db.prepare(
      `SELECT * FROM nodes WHERE name LIKE ? AND kind IN (${placeholders}) ORDER BY file, line`,
    );
    const crossFileCallersStmt = db.prepare(
      `SELECT COUNT(*) as cnt FROM edges e JOIN nodes n ON e.source_id = n.id
       WHERE e.target_id = ? AND e.kind = 'calls' AND n.file != ?`,
    );
    const usesStmt = db.prepare(
      `SELECT n.name, n.file, n.line FROM edges e JOIN nodes n ON e.source_id = n.id
       WHERE e.target_id = ? AND e.kind = 'calls'`,
    );
    for (const node of stmt.iterate(`%${target}%`, ...ALL_SYMBOL_KINDS)) {
      if (noTests && isTestFile(node.file)) continue;

      const crossFileCallers = crossFileCallersStmt.get(node.id, node.file);
      const exported = crossFileCallers.cnt > 0;

      let uses = usesStmt.all(node.id);
      if (noTests) uses = uses.filter((u) => !isTestFile(u.file));

      yield {
        name: node.name,
        kind: node.kind,
        file: node.file,
        line: node.line,
        role: node.role || null,
        exported,
        uses: uses.map((u) => ({ name: u.name, file: u.file, line: u.line })),
      };
    }
  } finally {
    db.close();
  }
}

export function statsData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;

  // Build set of test file IDs for filtering nodes and edges
  let testFileIds = null;
  if (noTests) {
    const allFileNodes = db.prepare("SELECT id, file FROM nodes WHERE kind = 'file'").all();
    testFileIds = new Set();
    const testFiles = new Set();
    for (const n of allFileNodes) {
      if (isTestFile(n.file)) {
        testFileIds.add(n.id);
        testFiles.add(n.file);
      }
    }
    // Also collect non-file node IDs that belong to test files
    const allNodes = db.prepare('SELECT id, file FROM nodes').all();
    for (const n of allNodes) {
      if (testFiles.has(n.file)) testFileIds.add(n.id);
    }
  }

  // Node breakdown by kind
  let nodeRows;
  if (noTests) {
    const allNodes = db.prepare('SELECT id, kind, file FROM nodes').all();
    const filtered = allNodes.filter((n) => !testFileIds.has(n.id));
    const counts = {};
    for (const n of filtered) counts[n.kind] = (counts[n.kind] || 0) + 1;
    nodeRows = Object.entries(counts).map(([kind, c]) => ({ kind, c }));
  } else {
    nodeRows = db.prepare('SELECT kind, COUNT(*) as c FROM nodes GROUP BY kind').all();
  }
  const nodesByKind = {};
  let totalNodes = 0;
  for (const r of nodeRows) {
    nodesByKind[r.kind] = r.c;
    totalNodes += r.c;
  }

  // Edge breakdown by kind
  let edgeRows;
  if (noTests) {
    const allEdges = db.prepare('SELECT source_id, target_id, kind FROM edges').all();
    const filtered = allEdges.filter(
      (e) => !testFileIds.has(e.source_id) && !testFileIds.has(e.target_id),
    );
    const counts = {};
    for (const e of filtered) counts[e.kind] = (counts[e.kind] || 0) + 1;
    edgeRows = Object.entries(counts).map(([kind, c]) => ({ kind, c }));
  } else {
    edgeRows = db.prepare('SELECT kind, COUNT(*) as c FROM edges GROUP BY kind').all();
  }
  const edgesByKind = {};
  let totalEdges = 0;
  for (const r of edgeRows) {
    edgesByKind[r.kind] = r.c;
    totalEdges += r.c;
  }

  // File/language distribution — map extensions via LANGUAGE_REGISTRY
  const extToLang = new Map();
  for (const entry of LANGUAGE_REGISTRY) {
    for (const ext of entry.extensions) {
      extToLang.set(ext, entry.id);
    }
  }
  let fileNodes = db.prepare("SELECT file FROM nodes WHERE kind = 'file'").all();
  if (noTests) fileNodes = fileNodes.filter((n) => !isTestFile(n.file));
  const byLanguage = {};
  for (const row of fileNodes) {
    const ext = path.extname(row.file).toLowerCase();
    const lang = extToLang.get(ext) || 'other';
    byLanguage[lang] = (byLanguage[lang] || 0) + 1;
  }
  const langCount = Object.keys(byLanguage).length;

  // Cycles
  const fileCycles = findCycles(db, { fileLevel: true, noTests });
  const fnCycles = findCycles(db, { fileLevel: false, noTests });

  // Top 5 coupling hotspots (fan-in + fan-out, file nodes)
  const testFilter = noTests
    ? `AND n.file NOT LIKE '%.test.%'
       AND n.file NOT LIKE '%.spec.%'
       AND n.file NOT LIKE '%__test__%'
       AND n.file NOT LIKE '%__tests__%'
       AND n.file NOT LIKE '%.stories.%'`
    : '';
  const hotspotRows = db
    .prepare(`
    SELECT n.file,
      (SELECT COUNT(*) FROM edges WHERE target_id = n.id) as fan_in,
      (SELECT COUNT(*) FROM edges WHERE source_id = n.id) as fan_out
    FROM nodes n
    WHERE n.kind = 'file' ${testFilter}
    ORDER BY (SELECT COUNT(*) FROM edges WHERE target_id = n.id)
           + (SELECT COUNT(*) FROM edges WHERE source_id = n.id) DESC
  `)
    .all();
  const filteredHotspots = noTests ? hotspotRows.filter((r) => !isTestFile(r.file)) : hotspotRows;
  const hotspots = filteredHotspots.slice(0, 5).map((r) => ({
    file: r.file,
    fanIn: r.fan_in,
    fanOut: r.fan_out,
  }));

  // Embeddings metadata
  let embeddings = null;
  try {
    const count = db.prepare('SELECT COUNT(*) as c FROM embeddings').get();
    if (count && count.c > 0) {
      const meta = {};
      const metaRows = db.prepare('SELECT key, value FROM embedding_meta').all();
      for (const r of metaRows) meta[r.key] = r.value;
      embeddings = {
        count: count.c,
        model: meta.model || null,
        dim: meta.dim ? parseInt(meta.dim, 10) : null,
        builtAt: meta.built_at || null,
      };
    }
  } catch {
    /* embeddings table may not exist */
  }

  // Graph quality metrics
  const qualityTestFilter = testFilter.replace(/n\.file/g, 'file');
  const totalCallable = db
    .prepare(
      `SELECT COUNT(*) as c FROM nodes WHERE kind IN ('function', 'method') ${qualityTestFilter}`,
    )
    .get().c;
  const callableWithCallers = db
    .prepare(`
      SELECT COUNT(DISTINCT e.target_id) as c FROM edges e
      JOIN nodes n ON e.target_id = n.id
      WHERE e.kind = 'calls' AND n.kind IN ('function', 'method') ${testFilter}
    `)
    .get().c;
  const callerCoverage = totalCallable > 0 ? callableWithCallers / totalCallable : 0;

  const totalCallEdges = db.prepare("SELECT COUNT(*) as c FROM edges WHERE kind = 'calls'").get().c;
  const highConfCallEdges = db
    .prepare("SELECT COUNT(*) as c FROM edges WHERE kind = 'calls' AND confidence >= 0.7")
    .get().c;
  const callConfidence = totalCallEdges > 0 ? highConfCallEdges / totalCallEdges : 0;

  // False-positive warnings: generic names with > threshold callers
  const fpRows = db
    .prepare(`
      SELECT n.name, n.file, n.line, COUNT(e.source_id) as caller_count
      FROM nodes n
      LEFT JOIN edges e ON n.id = e.target_id AND e.kind = 'calls'
      WHERE n.kind IN ('function', 'method')
      GROUP BY n.id
      HAVING caller_count > ?
      ORDER BY caller_count DESC
    `)
    .all(FALSE_POSITIVE_CALLER_THRESHOLD);
  const falsePositiveWarnings = fpRows
    .filter((r) =>
      FALSE_POSITIVE_NAMES.has(r.name.includes('.') ? r.name.split('.').pop() : r.name),
    )
    .map((r) => ({ name: r.name, file: r.file, line: r.line, callerCount: r.caller_count }));

  // Edges from suspicious nodes
  let fpEdgeCount = 0;
  for (const fp of falsePositiveWarnings) fpEdgeCount += fp.callerCount;
  const falsePositiveRatio = totalCallEdges > 0 ? fpEdgeCount / totalCallEdges : 0;

  const score = Math.round(
    callerCoverage * 40 + callConfidence * 40 + (1 - falsePositiveRatio) * 20,
  );

  const quality = {
    score,
    callerCoverage: {
      ratio: callerCoverage,
      covered: callableWithCallers,
      total: totalCallable,
    },
    callConfidence: {
      ratio: callConfidence,
      highConf: highConfCallEdges,
      total: totalCallEdges,
    },
    falsePositiveWarnings,
  };

  // Role distribution
  let roleRows;
  if (noTests) {
    const allRoleNodes = db.prepare('SELECT role, file FROM nodes WHERE role IS NOT NULL').all();
    const filtered = allRoleNodes.filter((n) => !isTestFile(n.file));
    const counts = {};
    for (const n of filtered) counts[n.role] = (counts[n.role] || 0) + 1;
    roleRows = Object.entries(counts).map(([role, c]) => ({ role, c }));
  } else {
    roleRows = db
      .prepare('SELECT role, COUNT(*) as c FROM nodes WHERE role IS NOT NULL GROUP BY role')
      .all();
  }
  const roles = {};
  for (const r of roleRows) roles[r.role] = r.c;

  // Complexity summary
  let complexity = null;
  try {
    const cRows = db
      .prepare(
        `SELECT fc.cognitive, fc.cyclomatic, fc.max_nesting, fc.maintainability_index
       FROM function_complexity fc JOIN nodes n ON fc.node_id = n.id
       WHERE n.kind IN ('function','method') ${testFilter}`,
      )
      .all();
    if (cRows.length > 0) {
      const miValues = cRows.map((r) => r.maintainability_index || 0);
      complexity = {
        analyzed: cRows.length,
        avgCognitive: +(cRows.reduce((s, r) => s + r.cognitive, 0) / cRows.length).toFixed(1),
        avgCyclomatic: +(cRows.reduce((s, r) => s + r.cyclomatic, 0) / cRows.length).toFixed(1),
        maxCognitive: Math.max(...cRows.map((r) => r.cognitive)),
        maxCyclomatic: Math.max(...cRows.map((r) => r.cyclomatic)),
        avgMI: +(miValues.reduce((s, v) => s + v, 0) / miValues.length).toFixed(1),
        minMI: +Math.min(...miValues).toFixed(1),
      };
    }
  } catch {
    /* table may not exist in older DBs */
  }

  db.close();
  return {
    nodes: { total: totalNodes, byKind: nodesByKind },
    edges: { total: totalEdges, byKind: edgesByKind },
    files: { total: fileNodes.length, languages: langCount, byLanguage },
    cycles: { fileLevel: fileCycles.length, functionLevel: fnCycles.length },
    hotspots,
    embeddings,
    quality,
    roles,
    complexity,
  };
}

export async function stats(customDbPath, opts = {}) {
  const data = statsData(customDbPath, { noTests: opts.noTests });

  // Community detection summary (async import for lazy-loading)
  try {
    const { communitySummaryForStats } = await import('./communities.js');
    data.communities = communitySummaryForStats(customDbPath, { noTests: opts.noTests });
  } catch {
    /* graphology may not be available */
  }

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Human-readable output
  console.log('\n# Codegraph Stats\n');

  // Nodes
  console.log(`Nodes:     ${data.nodes.total} total`);
  const kindEntries = Object.entries(data.nodes.byKind).sort((a, b) => b[1] - a[1]);
  const kindParts = kindEntries.map(([k, v]) => `${k} ${v}`);
  // Print in rows of 3
  for (let i = 0; i < kindParts.length; i += 3) {
    const row = kindParts
      .slice(i, i + 3)
      .map((p) => p.padEnd(18))
      .join('');
    console.log(`  ${row}`);
  }

  // Edges
  console.log(`\nEdges:     ${data.edges.total} total`);
  const edgeEntries = Object.entries(data.edges.byKind).sort((a, b) => b[1] - a[1]);
  const edgeParts = edgeEntries.map(([k, v]) => `${k} ${v}`);
  for (let i = 0; i < edgeParts.length; i += 3) {
    const row = edgeParts
      .slice(i, i + 3)
      .map((p) => p.padEnd(18))
      .join('');
    console.log(`  ${row}`);
  }

  // Files
  console.log(`\nFiles:     ${data.files.total} (${data.files.languages} languages)`);
  const langEntries = Object.entries(data.files.byLanguage).sort((a, b) => b[1] - a[1]);
  const langParts = langEntries.map(([k, v]) => `${k} ${v}`);
  for (let i = 0; i < langParts.length; i += 3) {
    const row = langParts
      .slice(i, i + 3)
      .map((p) => p.padEnd(18))
      .join('');
    console.log(`  ${row}`);
  }

  // Cycles
  console.log(
    `\nCycles:    ${data.cycles.fileLevel} file-level, ${data.cycles.functionLevel} function-level`,
  );

  // Hotspots
  if (data.hotspots.length > 0) {
    console.log(`\nTop ${data.hotspots.length} coupling hotspots:`);
    for (let i = 0; i < data.hotspots.length; i++) {
      const h = data.hotspots[i];
      console.log(
        `  ${String(i + 1).padStart(2)}. ${h.file.padEnd(35)} fan-in: ${String(h.fanIn).padStart(3)}  fan-out: ${String(h.fanOut).padStart(3)}`,
      );
    }
  }

  // Embeddings
  if (data.embeddings) {
    const e = data.embeddings;
    console.log(
      `\nEmbeddings: ${e.count} vectors (${e.model || 'unknown'}, ${e.dim || '?'}d) built ${e.builtAt || 'unknown'}`,
    );
  } else {
    console.log('\nEmbeddings: not built');
  }

  // Quality
  if (data.quality) {
    const q = data.quality;
    const cc = q.callerCoverage;
    const cf = q.callConfidence;
    console.log(`\nGraph Quality: ${q.score}/100`);
    console.log(
      `  Caller coverage:  ${(cc.ratio * 100).toFixed(1)}% (${cc.covered}/${cc.total} functions have >=1 caller)`,
    );
    console.log(
      `  Call confidence:  ${(cf.ratio * 100).toFixed(1)}% (${cf.highConf}/${cf.total} call edges are high-confidence)`,
    );
    if (q.falsePositiveWarnings.length > 0) {
      console.log('  False-positive warnings:');
      for (const fp of q.falsePositiveWarnings) {
        console.log(`    ! ${fp.name} (${fp.callerCount} callers) -- ${fp.file}:${fp.line}`);
      }
    }
  }

  // Roles
  if (data.roles && Object.keys(data.roles).length > 0) {
    const total = Object.values(data.roles).reduce((a, b) => a + b, 0);
    console.log(`\nRoles:     ${total} classified symbols`);
    const roleParts = Object.entries(data.roles)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`);
    for (let i = 0; i < roleParts.length; i += 3) {
      const row = roleParts
        .slice(i, i + 3)
        .map((p) => p.padEnd(18))
        .join('');
      console.log(`  ${row}`);
    }
  }

  // Complexity
  if (data.complexity) {
    const cx = data.complexity;
    const miPart = cx.avgMI != null ? ` | avg MI: ${cx.avgMI} | min MI: ${cx.minMI}` : '';
    console.log(
      `\nComplexity: ${cx.analyzed} functions | avg cognitive: ${cx.avgCognitive} | avg cyclomatic: ${cx.avgCyclomatic} | max cognitive: ${cx.maxCognitive}${miPart}`,
    );
  }

  // Communities
  if (data.communities) {
    const cm = data.communities;
    console.log(
      `\nCommunities: ${cm.communityCount} detected | modularity: ${cm.modularity} | drift: ${cm.driftScore}%`,
    );
  }

  console.log();
}

// ─── Human-readable output (original formatting) ───────────────────────

export function queryName(name, customDbPath, opts = {}) {
  const data = queryNameData(name, customDbPath, {
    noTests: opts.noTests,
    limit: opts.limit,
    offset: opts.offset,
  });
  if (opts.ndjson) {
    printNdjson(data, 'results');
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.results.length === 0) {
    console.log(`No results for "${name}"`);
    return;
  }

  console.log(`\nResults for "${name}":\n`);
  for (const r of data.results) {
    console.log(`  ${kindIcon(r.kind)} ${r.name} (${r.kind}) -- ${r.file}:${r.line}`);
    if (r.callees.length > 0) {
      console.log(`    -> calls/uses:`);
      for (const c of r.callees.slice(0, 15))
        console.log(`      -> ${c.name} (${c.edgeKind}) ${c.file}:${c.line}`);
      if (r.callees.length > 15) console.log(`      ... and ${r.callees.length - 15} more`);
    }
    if (r.callers.length > 0) {
      console.log(`    <- called by:`);
      for (const c of r.callers.slice(0, 15))
        console.log(`      <- ${c.name} (${c.edgeKind}) ${c.file}:${c.line}`);
      if (r.callers.length > 15) console.log(`      ... and ${r.callers.length - 15} more`);
    }
    console.log();
  }
}

export function impactAnalysis(file, customDbPath, opts = {}) {
  const data = impactAnalysisData(file, customDbPath, opts);
  if (opts.ndjson) {
    printNdjson(data, 'sources');
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.sources.length === 0) {
    console.log(`No file matching "${file}" in graph`);
    return;
  }

  console.log(`\nImpact analysis for files matching "${file}":\n`);
  for (const s of data.sources) console.log(`  # ${s} (source)`);

  const levels = data.levels;
  if (Object.keys(levels).length === 0) {
    console.log(`  No dependents found.`);
  } else {
    for (const level of Object.keys(levels).sort((a, b) => a - b)) {
      const nodes = levels[level];
      console.log(
        `\n  ${'--'.repeat(parseInt(level, 10))} Level ${level} (${nodes.length} files):`,
      );
      for (const n of nodes.slice(0, 30))
        console.log(`    ${'  '.repeat(parseInt(level, 10))}^ ${n.file}`);
      if (nodes.length > 30) console.log(`    ... and ${nodes.length - 30} more`);
    }
  }
  console.log(`\n  Total: ${data.totalDependents} files transitively depend on "${file}"\n`);
}

export function moduleMap(customDbPath, limit = 20, opts = {}) {
  const data = moduleMapData(customDbPath, limit, { noTests: opts.noTests });
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`\nModule map (top ${limit} most-connected nodes):\n`);
  const dirs = new Map();
  for (const n of data.topNodes) {
    if (!dirs.has(n.dir)) dirs.set(n.dir, []);
    dirs.get(n.dir).push(n);
  }
  for (const [dir, files] of [...dirs].sort()) {
    console.log(`  [${dir}/]`);
    for (const f of files) {
      const coupling = f.inEdges + f.outEdges;
      const bar = '#'.repeat(Math.min(coupling, 40));
      console.log(
        `    ${path.basename(f.file).padEnd(35)} <-${String(f.inEdges).padStart(3)} ->${String(f.outEdges).padStart(3)}  =${String(coupling).padStart(3)}  ${bar}`,
      );
    }
  }
  console.log(
    `\n  Total: ${data.stats.totalFiles} files, ${data.stats.totalNodes} symbols, ${data.stats.totalEdges} edges\n`,
  );
}

export function fileDeps(file, customDbPath, opts = {}) {
  const data = fileDepsData(file, customDbPath, opts);
  if (opts.ndjson) {
    printNdjson(data, 'results');
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.results.length === 0) {
    console.log(`No file matching "${file}" in graph`);
    return;
  }

  for (const r of data.results) {
    console.log(`\n# ${r.file}\n`);
    console.log(`  -> Imports (${r.imports.length}):`);
    for (const i of r.imports) {
      const typeTag = i.typeOnly ? ' (type-only)' : '';
      console.log(`    -> ${i.file}${typeTag}`);
    }
    console.log(`\n  <- Imported by (${r.importedBy.length}):`);
    for (const i of r.importedBy) console.log(`    <- ${i.file}`);
    if (r.definitions.length > 0) {
      console.log(`\n  Definitions (${r.definitions.length}):`);
      for (const d of r.definitions.slice(0, 30))
        console.log(`    ${kindIcon(d.kind)} ${d.name} :${d.line}`);
      if (r.definitions.length > 30) console.log(`    ... and ${r.definitions.length - 30} more`);
    }
    console.log();
  }
}

export function fnDeps(name, customDbPath, opts = {}) {
  const data = fnDepsData(name, customDbPath, opts);
  if (opts.ndjson) {
    printNdjson(data, 'results');
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.results.length === 0) {
    console.log(`No function/method/class matching "${name}"`);
    return;
  }

  for (const r of data.results) {
    console.log(`\n${kindIcon(r.kind)} ${r.name} (${r.kind}) -- ${r.file}:${r.line}\n`);
    if (r.callees.length > 0) {
      console.log(`  -> Calls (${r.callees.length}):`);
      for (const c of r.callees)
        console.log(`    -> ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
    }
    if (r.callers.length > 0) {
      console.log(`\n  <- Called by (${r.callers.length}):`);
      for (const c of r.callers) {
        const via = c.viaHierarchy ? ` (via ${c.viaHierarchy})` : '';
        console.log(`    <- ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}${via}`);
      }
    }
    for (const [d, fns] of Object.entries(r.transitiveCallers)) {
      console.log(
        `\n  ${'<-'.repeat(parseInt(d, 10))} Transitive callers (depth ${d}, ${fns.length}):`,
      );
      for (const n of fns.slice(0, 20))
        console.log(
          `    ${'  '.repeat(parseInt(d, 10) - 1)}<- ${kindIcon(n.kind)} ${n.name}  ${n.file}:${n.line}`,
        );
      if (fns.length > 20) console.log(`    ... and ${fns.length - 20} more`);
    }
    if (r.callees.length === 0 && r.callers.length === 0) {
      console.log(`  (no call edges found -- may be invoked dynamically or via re-exports)`);
    }
    console.log();
  }
}

// ─── Context helpers (private) ──────────────────────────────────────────

function readSourceRange(repoRoot, file, startLine, endLine) {
  try {
    const absPath = safePath(repoRoot, file);
    if (!absPath) return null;
    const content = fs.readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, (startLine || 1) - 1);
    const end = Math.min(lines.length, endLine || startLine + 50);
    return lines.slice(start, end).join('\n');
  } catch (e) {
    debug(`readSourceRange failed for ${file}: ${e.message}`);
    return null;
  }
}

function extractSummary(fileLines, line) {
  if (!fileLines || !line || line <= 1) return null;
  const idx = line - 2; // line above the definition (0-indexed)
  // Scan up to 10 lines above for JSDoc or comment
  let jsdocEnd = -1;
  for (let i = idx; i >= Math.max(0, idx - 10); i--) {
    const trimmed = fileLines[i].trim();
    if (trimmed.endsWith('*/')) {
      jsdocEnd = i;
      break;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
      // Single-line comment immediately above
      const text = trimmed
        .replace(/^\/\/\s*/, '')
        .replace(/^#\s*/, '')
        .trim();
      return text.length > 100 ? `${text.slice(0, 100)}...` : text;
    }
    if (trimmed !== '' && !trimmed.startsWith('*') && !trimmed.startsWith('/*')) break;
  }
  if (jsdocEnd >= 0) {
    // Find opening /**
    for (let i = jsdocEnd; i >= Math.max(0, jsdocEnd - 20); i--) {
      if (fileLines[i].trim().startsWith('/**')) {
        // Extract first non-tag, non-empty line
        for (let j = i + 1; j <= jsdocEnd; j++) {
          const docLine = fileLines[j]
            .trim()
            .replace(/^\*\s?/, '')
            .trim();
          if (docLine && !docLine.startsWith('@') && docLine !== '/' && docLine !== '*/') {
            return docLine.length > 100 ? `${docLine.slice(0, 100)}...` : docLine;
          }
        }
        break;
      }
    }
  }
  return null;
}

function extractSignature(fileLines, line) {
  if (!fileLines || !line) return null;
  const idx = line - 1;
  // Gather up to 5 lines to handle multi-line params
  const chunk = fileLines.slice(idx, Math.min(fileLines.length, idx + 5)).join('\n');

  // JS/TS: function name(params) or (params) => or async function
  let m = chunk.match(
    /(?:export\s+)?(?:async\s+)?function\s*\*?\s*\w*\s*\(([^)]*)\)\s*(?::\s*([^\n{]+))?/,
  );
  if (m) {
    return {
      params: m[1].trim() || null,
      returnType: m[2] ? m[2].trim().replace(/\s*\{$/, '') : null,
    };
  }
  // Arrow: const name = (params) => or (params):ReturnType =>
  m = chunk.match(/=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*([^=>\n{]+))?\s*=>/);
  if (m) {
    return {
      params: m[1].trim() || null,
      returnType: m[2] ? m[2].trim() : null,
    };
  }
  // Python: def name(params) -> return:
  m = chunk.match(/def\s+\w+\s*\(([^)]*)\)\s*(?:->\s*([^:\n]+))?/);
  if (m) {
    return {
      params: m[1].trim() || null,
      returnType: m[2] ? m[2].trim() : null,
    };
  }
  // Go: func (recv) name(params) (returns)
  m = chunk.match(/func\s+(?:\([^)]*\)\s+)?\w+\s*\(([^)]*)\)\s*(?:\(([^)]+)\)|(\w[^\n{]*))?/);
  if (m) {
    return {
      params: m[1].trim() || null,
      returnType: (m[2] || m[3] || '').trim() || null,
    };
  }
  // Rust: fn name(params) -> ReturnType
  m = chunk.match(/fn\s+\w+\s*\(([^)]*)\)\s*(?:->\s*([^\n{]+))?/);
  if (m) {
    return {
      params: m[1].trim() || null,
      returnType: m[2] ? m[2].trim() : null,
    };
  }
  return null;
}

// ─── contextData ────────────────────────────────────────────────────────

export function contextData(name, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const depth = opts.depth || 0;
  const noSource = opts.noSource || false;
  const noTests = opts.noTests || false;
  const includeTests = opts.includeTests || false;

  const dbPath = findDbPath(customDbPath);
  const repoRoot = path.resolve(path.dirname(dbPath), '..');

  const nodes = findMatchingNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
  if (nodes.length === 0) {
    db.close();
    return { name, results: [] };
  }

  // No hardcoded slice — pagination handles bounding via limit/offset

  // File-lines cache to avoid re-reading the same file
  const fileCache = new Map();
  function getFileLines(file) {
    if (fileCache.has(file)) return fileCache.get(file);
    try {
      const absPath = safePath(repoRoot, file);
      if (!absPath) {
        fileCache.set(file, null);
        return null;
      }
      const lines = fs.readFileSync(absPath, 'utf-8').split('\n');
      fileCache.set(file, lines);
      return lines;
    } catch (e) {
      debug(`getFileLines failed for ${file}: ${e.message}`);
      fileCache.set(file, null);
      return null;
    }
  }

  const results = nodes.map((node) => {
    const fileLines = getFileLines(node.file);

    // Source
    const source = noSource ? null : readSourceRange(repoRoot, node.file, node.line, node.end_line);

    // Signature
    const signature = fileLines ? extractSignature(fileLines, node.line) : null;

    // Callees
    const calleeRows = db
      .prepare(
        `SELECT n.id, n.name, n.kind, n.file, n.line, n.end_line
       FROM edges e JOIN nodes n ON e.target_id = n.id
       WHERE e.source_id = ? AND e.kind = 'calls'`,
      )
      .all(node.id);
    const filteredCallees = noTests ? calleeRows.filter((c) => !isTestFile(c.file)) : calleeRows;

    const callees = filteredCallees.map((c) => {
      const cLines = getFileLines(c.file);
      const summary = cLines ? extractSummary(cLines, c.line) : null;
      let calleeSource = null;
      if (depth >= 1) {
        calleeSource = readSourceRange(repoRoot, c.file, c.line, c.end_line);
      }
      return {
        name: c.name,
        kind: c.kind,
        file: c.file,
        line: c.line,
        endLine: c.end_line || null,
        summary,
        source: calleeSource,
      };
    });

    // Deep callee expansion via BFS (depth > 1, capped at 5)
    if (depth > 1) {
      const visited = new Set(filteredCallees.map((c) => c.id));
      visited.add(node.id);
      let frontier = filteredCallees.map((c) => c.id);
      const maxDepth = Math.min(depth, 5);
      for (let d = 2; d <= maxDepth; d++) {
        const nextFrontier = [];
        for (const fid of frontier) {
          const deeper = db
            .prepare(
              `SELECT n.id, n.name, n.kind, n.file, n.line, n.end_line
             FROM edges e JOIN nodes n ON e.target_id = n.id
             WHERE e.source_id = ? AND e.kind = 'calls'`,
            )
            .all(fid);
          for (const c of deeper) {
            if (!visited.has(c.id) && (!noTests || !isTestFile(c.file))) {
              visited.add(c.id);
              nextFrontier.push(c.id);
              const cLines = getFileLines(c.file);
              callees.push({
                name: c.name,
                kind: c.kind,
                file: c.file,
                line: c.line,
                endLine: c.end_line || null,
                summary: cLines ? extractSummary(cLines, c.line) : null,
                source: readSourceRange(repoRoot, c.file, c.line, c.end_line),
              });
            }
          }
        }
        frontier = nextFrontier;
        if (frontier.length === 0) break;
      }
    }

    // Callers
    let callerRows = db
      .prepare(
        `SELECT n.name, n.kind, n.file, n.line
       FROM edges e JOIN nodes n ON e.source_id = n.id
       WHERE e.target_id = ? AND e.kind = 'calls'`,
      )
      .all(node.id);

    // Method hierarchy resolution
    if (node.kind === 'method' && node.name.includes('.')) {
      const methodName = node.name.split('.').pop();
      const relatedMethods = resolveMethodViaHierarchy(db, methodName);
      for (const rm of relatedMethods) {
        if (rm.id === node.id) continue;
        const extraCallers = db
          .prepare(
            `SELECT n.name, n.kind, n.file, n.line
           FROM edges e JOIN nodes n ON e.source_id = n.id
           WHERE e.target_id = ? AND e.kind = 'calls'`,
          )
          .all(rm.id);
        callerRows.push(...extraCallers.map((c) => ({ ...c, viaHierarchy: rm.name })));
      }
    }
    if (noTests) callerRows = callerRows.filter((c) => !isTestFile(c.file));

    const callers = callerRows.map((c) => ({
      name: c.name,
      kind: c.kind,
      file: c.file,
      line: c.line,
      viaHierarchy: c.viaHierarchy || undefined,
    }));

    // Related tests: callers that live in test files
    const testCallerRows = db
      .prepare(
        `SELECT n.name, n.kind, n.file, n.line
       FROM edges e JOIN nodes n ON e.source_id = n.id
       WHERE e.target_id = ? AND e.kind = 'calls'`,
      )
      .all(node.id);
    const testCallers = testCallerRows.filter((c) => isTestFile(c.file));

    const testsByFile = new Map();
    for (const tc of testCallers) {
      if (!testsByFile.has(tc.file)) testsByFile.set(tc.file, []);
      testsByFile.get(tc.file).push(tc);
    }

    const relatedTests = [];
    for (const [file] of testsByFile) {
      const tLines = getFileLines(file);
      const testNames = [];
      if (tLines) {
        for (const tl of tLines) {
          const tm = tl.match(/(?:it|test|describe)\s*\(\s*['"`]([^'"`]+)['"`]/);
          if (tm) testNames.push(tm[1]);
        }
      }
      const testSource = includeTests && tLines ? tLines.join('\n') : undefined;
      relatedTests.push({
        file,
        testCount: testNames.length,
        testNames,
        source: testSource,
      });
    }

    // Complexity metrics
    let complexityMetrics = null;
    try {
      const cRow = db
        .prepare(
          'SELECT cognitive, cyclomatic, max_nesting, maintainability_index, halstead_volume FROM function_complexity WHERE node_id = ?',
        )
        .get(node.id);
      if (cRow) {
        complexityMetrics = {
          cognitive: cRow.cognitive,
          cyclomatic: cRow.cyclomatic,
          maxNesting: cRow.max_nesting,
          maintainabilityIndex: cRow.maintainability_index || 0,
          halsteadVolume: cRow.halstead_volume || 0,
        };
      }
    } catch {
      /* table may not exist */
    }

    // Children (parameters, properties, constants)
    let nodeChildren = [];
    try {
      nodeChildren = db
        .prepare('SELECT name, kind, line, end_line FROM nodes WHERE parent_id = ? ORDER BY line')
        .all(node.id)
        .map((c) => ({ name: c.name, kind: c.kind, line: c.line, endLine: c.end_line || null }));
    } catch {
      /* parent_id column may not exist */
    }

    return {
      name: node.name,
      kind: node.kind,
      file: node.file,
      line: node.line,
      role: node.role || null,
      endLine: node.end_line || null,
      source,
      signature,
      complexity: complexityMetrics,
      children: nodeChildren.length > 0 ? nodeChildren : undefined,
      callees,
      callers,
      relatedTests,
    };
  });

  db.close();
  const base = { name, results };
  return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
}

export function context(name, customDbPath, opts = {}) {
  const data = contextData(name, customDbPath, opts);
  if (opts.ndjson) {
    printNdjson(data, 'results');
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.results.length === 0) {
    console.log(`No function/method/class matching "${name}"`);
    return;
  }

  for (const r of data.results) {
    const lineRange = r.endLine ? `${r.line}-${r.endLine}` : `${r.line}`;
    const roleTag = r.role ? ` [${r.role}]` : '';
    console.log(`\n# ${r.name} (${r.kind})${roleTag} — ${r.file}:${lineRange}\n`);

    // Signature
    if (r.signature) {
      console.log('## Type/Shape Info');
      if (r.signature.params != null) console.log(`  Parameters: (${r.signature.params})`);
      if (r.signature.returnType) console.log(`  Returns: ${r.signature.returnType}`);
      console.log();
    }

    // Children
    if (r.children && r.children.length > 0) {
      console.log(`## Children (${r.children.length})`);
      for (const c of r.children) {
        console.log(`  ${kindIcon(c.kind)} ${c.name}  :${c.line}`);
      }
      console.log();
    }

    // Complexity
    if (r.complexity) {
      const cx = r.complexity;
      const miPart = cx.maintainabilityIndex ? ` | MI: ${cx.maintainabilityIndex}` : '';
      console.log('## Complexity');
      console.log(
        `  Cognitive: ${cx.cognitive} | Cyclomatic: ${cx.cyclomatic} | Max Nesting: ${cx.maxNesting}${miPart}`,
      );
      console.log();
    }

    // Source
    if (r.source) {
      console.log('## Source');
      for (const line of r.source.split('\n')) {
        console.log(`  ${line}`);
      }
      console.log();
    }

    // Callees
    if (r.callees.length > 0) {
      console.log(`## Direct Dependencies (${r.callees.length})`);
      for (const c of r.callees) {
        const summary = c.summary ? ` — ${c.summary}` : '';
        console.log(`  ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}${summary}`);
        if (c.source) {
          for (const line of c.source.split('\n').slice(0, 10)) {
            console.log(`    | ${line}`);
          }
        }
      }
      console.log();
    }

    // Callers
    if (r.callers.length > 0) {
      console.log(`## Callers (${r.callers.length})`);
      for (const c of r.callers) {
        const via = c.viaHierarchy ? ` (via ${c.viaHierarchy})` : '';
        console.log(`  ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}${via}`);
      }
      console.log();
    }

    // Related tests
    if (r.relatedTests.length > 0) {
      console.log('## Related Tests');
      for (const t of r.relatedTests) {
        console.log(`  ${t.file} — ${t.testCount} tests`);
        for (const tn of t.testNames) {
          console.log(`    - ${tn}`);
        }
        if (t.source) {
          console.log('    Source:');
          for (const line of t.source.split('\n').slice(0, 20)) {
            console.log(`    | ${line}`);
          }
        }
      }
      console.log();
    }

    if (r.callees.length === 0 && r.callers.length === 0 && r.relatedTests.length === 0) {
      console.log(
        '  (no call edges or tests found — may be invoked dynamically or via re-exports)',
      );
      console.log();
    }
  }
}

// ─── childrenData ───────────────────────────────────────────────────────

export function childrenData(name, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;

  const nodes = findMatchingNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
  if (nodes.length === 0) {
    db.close();
    return { name, results: [] };
  }

  const results = nodes.map((node) => {
    let children;
    try {
      children = db
        .prepare('SELECT name, kind, line, end_line FROM nodes WHERE parent_id = ? ORDER BY line')
        .all(node.id);
    } catch {
      children = [];
    }
    if (noTests) children = children.filter((c) => !isTestFile(c.file || node.file));
    return {
      name: node.name,
      kind: node.kind,
      file: node.file,
      line: node.line,
      children: children.map((c) => ({
        name: c.name,
        kind: c.kind,
        line: c.line,
        endLine: c.end_line || null,
      })),
    };
  });

  db.close();
  const base = { name, results };
  return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
}

export function children(name, customDbPath, opts = {}) {
  const data = childrenData(name, customDbPath, opts);
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.results.length === 0) {
    console.log(`No symbol matching "${name}"`);
    return;
  }
  for (const r of data.results) {
    console.log(`\n${kindIcon(r.kind)} ${r.name}  ${r.file}:${r.line}`);
    if (r.children.length === 0) {
      console.log('  (no children)');
    } else {
      for (const c of r.children) {
        console.log(`  ${kindIcon(c.kind)} ${c.name}  :${c.line}`);
      }
    }
  }
}

// ─── explainData ────────────────────────────────────────────────────────

function isFileLikeTarget(target) {
  if (target.includes('/') || target.includes('\\')) return true;
  const ext = path.extname(target).toLowerCase();
  if (!ext) return false;
  for (const entry of LANGUAGE_REGISTRY) {
    if (entry.extensions.includes(ext)) return true;
  }
  return false;
}

function explainFileImpl(db, target, getFileLines) {
  const fileNodes = db
    .prepare(`SELECT * FROM nodes WHERE file LIKE ? AND kind = 'file'`)
    .all(`%${target}%`);
  if (fileNodes.length === 0) return [];

  return fileNodes.map((fn) => {
    const symbols = db
      .prepare(`SELECT * FROM nodes WHERE file = ? AND kind != 'file' ORDER BY line`)
      .all(fn.file);

    // IDs of symbols that have incoming calls from other files (public)
    const publicIds = new Set(
      db
        .prepare(
          `SELECT DISTINCT e.target_id FROM edges e
           JOIN nodes caller ON e.source_id = caller.id
           JOIN nodes target ON e.target_id = target.id
           WHERE target.file = ? AND caller.file != ? AND e.kind = 'calls'`,
        )
        .all(fn.file, fn.file)
        .map((r) => r.target_id),
    );

    const fileLines = getFileLines(fn.file);
    const mapSymbol = (s) => ({
      name: s.name,
      kind: s.kind,
      line: s.line,
      role: s.role || null,
      summary: fileLines ? extractSummary(fileLines, s.line) : null,
      signature: fileLines ? extractSignature(fileLines, s.line) : null,
    });

    const publicApi = symbols.filter((s) => publicIds.has(s.id)).map(mapSymbol);
    const internal = symbols.filter((s) => !publicIds.has(s.id)).map(mapSymbol);

    // Imports / importedBy
    const imports = db
      .prepare(
        `SELECT n.file FROM edges e JOIN nodes n ON e.target_id = n.id
         WHERE e.source_id = ? AND e.kind IN ('imports', 'imports-type')`,
      )
      .all(fn.id)
      .map((r) => ({ file: r.file }));

    const importedBy = db
      .prepare(
        `SELECT n.file FROM edges e JOIN nodes n ON e.source_id = n.id
         WHERE e.target_id = ? AND e.kind IN ('imports', 'imports-type')`,
      )
      .all(fn.id)
      .map((r) => ({ file: r.file }));

    // Intra-file data flow
    const intraEdges = db
      .prepare(
        `SELECT caller.name as caller_name, callee.name as callee_name
         FROM edges e
         JOIN nodes caller ON e.source_id = caller.id
         JOIN nodes callee ON e.target_id = callee.id
         WHERE caller.file = ? AND callee.file = ? AND e.kind = 'calls'
         ORDER BY caller.line`,
      )
      .all(fn.file, fn.file);

    const dataFlowMap = new Map();
    for (const edge of intraEdges) {
      if (!dataFlowMap.has(edge.caller_name)) dataFlowMap.set(edge.caller_name, []);
      dataFlowMap.get(edge.caller_name).push(edge.callee_name);
    }
    const dataFlow = [...dataFlowMap.entries()].map(([caller, callees]) => ({
      caller,
      callees,
    }));

    // Line count: prefer node_metrics (actual), fall back to MAX(end_line)
    const metric = db
      .prepare(`SELECT nm.line_count FROM node_metrics nm WHERE nm.node_id = ?`)
      .get(fn.id);
    let lineCount = metric?.line_count || null;
    if (!lineCount) {
      const maxLine = db
        .prepare(`SELECT MAX(end_line) as max_end FROM nodes WHERE file = ?`)
        .get(fn.file);
      lineCount = maxLine?.max_end || null;
    }

    return {
      file: fn.file,
      lineCount,
      symbolCount: symbols.length,
      publicApi,
      internal,
      imports,
      importedBy,
      dataFlow,
    };
  });
}

function explainFunctionImpl(db, target, noTests, getFileLines) {
  let nodes = db
    .prepare(
      `SELECT * FROM nodes WHERE name LIKE ? AND kind IN ('function','method','class','interface','type','struct','enum','trait','record','module') ORDER BY file, line`,
    )
    .all(`%${target}%`);
  if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));
  if (nodes.length === 0) return [];

  const hc = new Map();
  return nodes.slice(0, 10).map((node) => {
    const fileLines = getFileLines(node.file);
    const lineCount = node.end_line ? node.end_line - node.line + 1 : null;
    const summary = fileLines ? extractSummary(fileLines, node.line) : null;
    const signature = fileLines ? extractSignature(fileLines, node.line) : null;

    const callees = db
      .prepare(
        `SELECT n.name, n.kind, n.file, n.line
         FROM edges e JOIN nodes n ON e.target_id = n.id
         WHERE e.source_id = ? AND e.kind = 'calls'`,
      )
      .all(node.id)
      .map((c) => ({ name: c.name, kind: c.kind, file: c.file, line: c.line }));

    let callers = db
      .prepare(
        `SELECT n.name, n.kind, n.file, n.line
         FROM edges e JOIN nodes n ON e.source_id = n.id
         WHERE e.target_id = ? AND e.kind = 'calls'`,
      )
      .all(node.id)
      .map((c) => ({ name: c.name, kind: c.kind, file: c.file, line: c.line }));
    if (noTests) callers = callers.filter((c) => !isTestFile(c.file));

    const testCallerRows = db
      .prepare(
        `SELECT DISTINCT n.file FROM edges e JOIN nodes n ON e.source_id = n.id
         WHERE e.target_id = ? AND e.kind = 'calls'`,
      )
      .all(node.id);
    const relatedTests = testCallerRows
      .filter((r) => isTestFile(r.file))
      .map((r) => ({ file: r.file }));

    // Complexity metrics
    let complexityMetrics = null;
    try {
      const cRow = db
        .prepare(
          'SELECT cognitive, cyclomatic, max_nesting, maintainability_index, halstead_volume FROM function_complexity WHERE node_id = ?',
        )
        .get(node.id);
      if (cRow) {
        complexityMetrics = {
          cognitive: cRow.cognitive,
          cyclomatic: cRow.cyclomatic,
          maxNesting: cRow.max_nesting,
          maintainabilityIndex: cRow.maintainability_index || 0,
          halsteadVolume: cRow.halstead_volume || 0,
        };
      }
    } catch {
      /* table may not exist */
    }

    return {
      ...normalizeSymbol(node, db, hc),
      lineCount,
      summary,
      signature,
      complexity: complexityMetrics,
      callees,
      callers,
      relatedTests,
    };
  });
}

export function explainData(target, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;
  const depth = opts.depth || 0;
  const kind = isFileLikeTarget(target) ? 'file' : 'function';

  const dbPath = findDbPath(customDbPath);
  const repoRoot = path.resolve(path.dirname(dbPath), '..');

  const fileCache = new Map();
  function getFileLines(file) {
    if (fileCache.has(file)) return fileCache.get(file);
    try {
      const absPath = safePath(repoRoot, file);
      if (!absPath) {
        fileCache.set(file, null);
        return null;
      }
      const lines = fs.readFileSync(absPath, 'utf-8').split('\n');
      fileCache.set(file, lines);
      return lines;
    } catch (e) {
      debug(`getFileLines failed for ${file}: ${e.message}`);
      fileCache.set(file, null);
      return null;
    }
  }

  const results =
    kind === 'file'
      ? explainFileImpl(db, target, getFileLines)
      : explainFunctionImpl(db, target, noTests, getFileLines);

  // Recursive dependency explanation for function targets
  if (kind === 'function' && depth > 0 && results.length > 0) {
    const visited = new Set(results.map((r) => `${r.name}:${r.file}:${r.line}`));

    function explainCallees(parentResults, currentDepth) {
      if (currentDepth <= 0) return;
      for (const r of parentResults) {
        const newCallees = [];
        for (const callee of r.callees) {
          const key = `${callee.name}:${callee.file}:${callee.line}`;
          if (visited.has(key)) continue;
          visited.add(key);
          const calleeResults = explainFunctionImpl(db, callee.name, noTests, getFileLines);
          const exact = calleeResults.find(
            (cr) => cr.file === callee.file && cr.line === callee.line,
          );
          if (exact) {
            exact._depth = (r._depth || 0) + 1;
            newCallees.push(exact);
          }
        }
        if (newCallees.length > 0) {
          r.depDetails = newCallees;
          explainCallees(newCallees, currentDepth - 1);
        }
      }
    }

    explainCallees(results, depth);
  }

  db.close();
  const base = { target, kind, results };
  return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
}

export function explain(target, customDbPath, opts = {}) {
  const data = explainData(target, customDbPath, opts);
  if (opts.ndjson) {
    printNdjson(data, 'results');
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.results.length === 0) {
    console.log(`No ${data.kind === 'file' ? 'file' : 'function/symbol'} matching "${target}"`);
    return;
  }

  if (data.kind === 'file') {
    for (const r of data.results) {
      const publicCount = r.publicApi.length;
      const internalCount = r.internal.length;
      const lineInfo = r.lineCount ? `${r.lineCount} lines, ` : '';
      console.log(`\n# ${r.file}`);
      console.log(
        `  ${lineInfo}${r.symbolCount} symbols (${publicCount} exported, ${internalCount} internal)`,
      );

      if (r.imports.length > 0) {
        console.log(`  Imports: ${r.imports.map((i) => i.file).join(', ')}`);
      }
      if (r.importedBy.length > 0) {
        console.log(`  Imported by: ${r.importedBy.map((i) => i.file).join(', ')}`);
      }

      if (r.publicApi.length > 0) {
        console.log(`\n## Exported`);
        for (const s of r.publicApi) {
          const sig = s.signature?.params != null ? `(${s.signature.params})` : '';
          const roleTag = s.role ? ` [${s.role}]` : '';
          const summary = s.summary ? `  -- ${s.summary}` : '';
          console.log(`  ${kindIcon(s.kind)} ${s.name}${sig}${roleTag} :${s.line}${summary}`);
        }
      }

      if (r.internal.length > 0) {
        console.log(`\n## Internal`);
        for (const s of r.internal) {
          const sig = s.signature?.params != null ? `(${s.signature.params})` : '';
          const roleTag = s.role ? ` [${s.role}]` : '';
          const summary = s.summary ? `  -- ${s.summary}` : '';
          console.log(`  ${kindIcon(s.kind)} ${s.name}${sig}${roleTag} :${s.line}${summary}`);
        }
      }

      if (r.dataFlow.length > 0) {
        console.log(`\n## Data Flow`);
        for (const df of r.dataFlow) {
          console.log(`  ${df.caller} -> ${df.callees.join(', ')}`);
        }
      }
      console.log();
    }
  } else {
    function printFunctionExplain(r, indent = '') {
      const lineRange = r.endLine ? `${r.line}-${r.endLine}` : `${r.line}`;
      const lineInfo = r.lineCount ? `${r.lineCount} lines` : '';
      const summaryPart = r.summary ? ` | ${r.summary}` : '';
      const roleTag = r.role ? ` [${r.role}]` : '';
      const depthLevel = r._depth || 0;
      const heading = depthLevel === 0 ? '#' : '##'.padEnd(depthLevel + 2, '#');
      console.log(`\n${indent}${heading} ${r.name} (${r.kind})${roleTag}  ${r.file}:${lineRange}`);
      if (lineInfo || r.summary) {
        console.log(`${indent}  ${lineInfo}${summaryPart}`);
      }
      if (r.signature) {
        if (r.signature.params != null)
          console.log(`${indent}  Parameters: (${r.signature.params})`);
        if (r.signature.returnType) console.log(`${indent}  Returns: ${r.signature.returnType}`);
      }

      if (r.complexity) {
        const cx = r.complexity;
        const miPart = cx.maintainabilityIndex ? ` MI=${cx.maintainabilityIndex}` : '';
        console.log(
          `${indent}  Complexity: cognitive=${cx.cognitive} cyclomatic=${cx.cyclomatic} nesting=${cx.maxNesting}${miPart}`,
        );
      }

      if (r.callees.length > 0) {
        console.log(`\n${indent}  Calls (${r.callees.length}):`);
        for (const c of r.callees) {
          console.log(`${indent}    ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
        }
      }

      if (r.callers.length > 0) {
        console.log(`\n${indent}  Called by (${r.callers.length}):`);
        for (const c of r.callers) {
          console.log(`${indent}    ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
        }
      }

      if (r.relatedTests.length > 0) {
        const label = r.relatedTests.length === 1 ? 'file' : 'files';
        console.log(`\n${indent}  Tests (${r.relatedTests.length} ${label}):`);
        for (const t of r.relatedTests) {
          console.log(`${indent}    ${t.file}`);
        }
      }

      if (r.callees.length === 0 && r.callers.length === 0) {
        console.log(
          `${indent}  (no call edges found -- may be invoked dynamically or via re-exports)`,
        );
      }

      // Render recursive dependency details
      if (r.depDetails && r.depDetails.length > 0) {
        console.log(`\n${indent}  --- Dependencies (depth ${depthLevel + 1}) ---`);
        for (const dep of r.depDetails) {
          printFunctionExplain(dep, `${indent}  `);
        }
      }
      console.log();
    }

    for (const r of data.results) {
      printFunctionExplain(r);
    }
  }
}

// ─── whereData ──────────────────────────────────────────────────────────

function getFileHash(db, file) {
  const row = db.prepare('SELECT hash FROM file_hashes WHERE file = ?').get(file);
  return row ? row.hash : null;
}

/**
 * Normalize a raw DB/query row into the stable 7-field symbol shape.
 * @param {object} row    - Raw row (from SELECT * or explicit columns)
 * @param {object} [db]   - Open DB handle; when null, fileHash will be null
 * @param {Map}    [hashCache] - Optional per-file cache to avoid repeated getFileHash calls
 * @returns {{ name: string, kind: string, file: string, line: number, endLine: number|null, role: string|null, fileHash: string|null }}
 */
export function normalizeSymbol(row, db, hashCache) {
  let fileHash = null;
  if (db) {
    if (hashCache) {
      if (!hashCache.has(row.file)) {
        hashCache.set(row.file, getFileHash(db, row.file));
      }
      fileHash = hashCache.get(row.file);
    } else {
      fileHash = getFileHash(db, row.file);
    }
  }
  return {
    name: row.name,
    kind: row.kind,
    file: row.file,
    line: row.line,
    endLine: row.end_line ?? row.endLine ?? null,
    role: row.role ?? null,
    fileHash,
  };
}

function whereSymbolImpl(db, target, noTests) {
  const placeholders = ALL_SYMBOL_KINDS.map(() => '?').join(', ');
  let nodes = db
    .prepare(
      `SELECT * FROM nodes WHERE name LIKE ? AND kind IN (${placeholders}) ORDER BY file, line`,
    )
    .all(`%${target}%`, ...ALL_SYMBOL_KINDS);
  if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));

  const hc = new Map();
  return nodes.map((node) => {
    const crossFileCallers = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM edges e JOIN nodes n ON e.source_id = n.id
         WHERE e.target_id = ? AND e.kind = 'calls' AND n.file != ?`,
      )
      .get(node.id, node.file);
    const exported = crossFileCallers.cnt > 0;

    let uses = db
      .prepare(
        `SELECT n.name, n.file, n.line FROM edges e JOIN nodes n ON e.source_id = n.id
         WHERE e.target_id = ? AND e.kind = 'calls'`,
      )
      .all(node.id);
    if (noTests) uses = uses.filter((u) => !isTestFile(u.file));

    return {
      ...normalizeSymbol(node, db, hc),
      exported,
      uses: uses.map((u) => ({ name: u.name, file: u.file, line: u.line })),
    };
  });
}

function whereFileImpl(db, target) {
  const fileNodes = db
    .prepare(`SELECT * FROM nodes WHERE file LIKE ? AND kind = 'file'`)
    .all(`%${target}%`);
  if (fileNodes.length === 0) return [];

  return fileNodes.map((fn) => {
    const symbols = db
      .prepare(`SELECT * FROM nodes WHERE file = ? AND kind != 'file' ORDER BY line`)
      .all(fn.file);

    const imports = db
      .prepare(
        `SELECT n.file FROM edges e JOIN nodes n ON e.target_id = n.id
         WHERE e.source_id = ? AND e.kind IN ('imports', 'imports-type')`,
      )
      .all(fn.id)
      .map((r) => r.file);

    const importedBy = db
      .prepare(
        `SELECT n.file FROM edges e JOIN nodes n ON e.source_id = n.id
         WHERE e.target_id = ? AND e.kind IN ('imports', 'imports-type')`,
      )
      .all(fn.id)
      .map((r) => r.file);

    const exportedIds = new Set(
      db
        .prepare(
          `SELECT DISTINCT e.target_id FROM edges e
           JOIN nodes caller ON e.source_id = caller.id
           JOIN nodes target ON e.target_id = target.id
           WHERE target.file = ? AND caller.file != ? AND e.kind = 'calls'`,
        )
        .all(fn.file, fn.file)
        .map((r) => r.target_id),
    );

    const exported = symbols.filter((s) => exportedIds.has(s.id)).map((s) => s.name);

    return {
      file: fn.file,
      fileHash: getFileHash(db, fn.file),
      symbols: symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.line })),
      imports,
      importedBy,
      exported,
    };
  });
}

export function whereData(target, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;
  const fileMode = opts.file || false;

  const results = fileMode ? whereFileImpl(db, target) : whereSymbolImpl(db, target, noTests);

  db.close();
  const base = { target, mode: fileMode ? 'file' : 'symbol', results };
  return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
}

export function where(target, customDbPath, opts = {}) {
  const data = whereData(target, customDbPath, opts);
  if (opts.ndjson) {
    printNdjson(data, 'results');
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.results.length === 0) {
    console.log(
      data.mode === 'file'
        ? `No file matching "${target}" in graph`
        : `No symbol matching "${target}" in graph`,
    );
    return;
  }

  if (data.mode === 'symbol') {
    for (const r of data.results) {
      const roleTag = r.role ? ` [${r.role}]` : '';
      const tag = r.exported ? '  (exported)' : '';
      console.log(`\n${kindIcon(r.kind)} ${r.name}${roleTag}  ${r.file}:${r.line}${tag}`);
      if (r.uses.length > 0) {
        const useStrs = r.uses.map((u) => `${u.file}:${u.line}`);
        console.log(`  Used in: ${useStrs.join(', ')}`);
      } else {
        console.log('  No uses found');
      }
    }
  } else {
    for (const r of data.results) {
      console.log(`\n# ${r.file}`);
      if (r.symbols.length > 0) {
        const symStrs = r.symbols.map((s) => `${s.name}:${s.line}`);
        console.log(`  Symbols: ${symStrs.join(', ')}`);
      }
      if (r.imports.length > 0) {
        console.log(`  Imports: ${r.imports.join(', ')}`);
      }
      if (r.importedBy.length > 0) {
        console.log(`  Imported by: ${r.importedBy.join(', ')}`);
      }
      if (r.exported.length > 0) {
        console.log(`  Exported: ${r.exported.join(', ')}`);
      }
    }
  }
  console.log();
}

// ─── rolesData ──────────────────────────────────────────────────────────

export function rolesData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;
  const filterRole = opts.role || null;
  const filterFile = opts.file || null;

  const conditions = ['role IS NOT NULL'];
  const params = [];

  if (filterRole) {
    conditions.push('role = ?');
    params.push(filterRole);
  }
  if (filterFile) {
    conditions.push('file LIKE ?');
    params.push(`%${filterFile}%`);
  }

  let rows = db
    .prepare(
      `SELECT name, kind, file, line, end_line, role FROM nodes WHERE ${conditions.join(' AND ')} ORDER BY role, file, line`,
    )
    .all(...params);

  if (noTests) rows = rows.filter((r) => !isTestFile(r.file));

  const summary = {};
  for (const r of rows) {
    summary[r.role] = (summary[r.role] || 0) + 1;
  }

  const hc = new Map();
  const symbols = rows.map((r) => normalizeSymbol(r, db, hc));
  db.close();
  const base = { count: symbols.length, summary, symbols };
  return paginateResult(base, 'symbols', { limit: opts.limit, offset: opts.offset });
}

export function roles(customDbPath, opts = {}) {
  const data = rolesData(customDbPath, opts);
  if (opts.ndjson) {
    printNdjson(data, 'symbols');
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.count === 0) {
    console.log('No classified symbols found. Run "codegraph build" first.');
    return;
  }

  const total = data.count;
  console.log(`\nNode roles (${total} symbols):\n`);

  const summaryParts = Object.entries(data.summary)
    .sort((a, b) => b[1] - a[1])
    .map(([role, count]) => `${role}: ${count}`);
  console.log(`  ${summaryParts.join('  ')}\n`);

  const byRole = {};
  for (const s of data.symbols) {
    if (!byRole[s.role]) byRole[s.role] = [];
    byRole[s.role].push(s);
  }

  for (const [role, symbols] of Object.entries(byRole)) {
    console.log(`## ${role} (${symbols.length})`);
    for (const s of symbols.slice(0, 30)) {
      console.log(`  ${kindIcon(s.kind)} ${s.name}  ${s.file}:${s.line}`);
    }
    if (symbols.length > 30) {
      console.log(`  ... and ${symbols.length - 30} more`);
    }
    console.log();
  }
}

export function fnImpact(name, customDbPath, opts = {}) {
  const data = fnImpactData(name, customDbPath, opts);
  if (opts.ndjson) {
    printNdjson(data, 'results');
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.results.length === 0) {
    console.log(`No function/method/class matching "${name}"`);
    return;
  }

  for (const r of data.results) {
    console.log(`\nFunction impact: ${kindIcon(r.kind)} ${r.name} -- ${r.file}:${r.line}\n`);
    if (Object.keys(r.levels).length === 0) {
      console.log(`  No callers found.`);
    } else {
      for (const [level, fns] of Object.entries(r.levels).sort((a, b) => a[0] - b[0])) {
        const l = parseInt(level, 10);
        console.log(`  ${'--'.repeat(l)} Level ${level} (${fns.length} functions):`);
        for (const f of fns.slice(0, 20))
          console.log(`    ${'  '.repeat(l)}^ ${kindIcon(f.kind)} ${f.name}  ${f.file}:${f.line}`);
        if (fns.length > 20) console.log(`    ... and ${fns.length - 20} more`);
      }
    }
    console.log(`\n  Total: ${r.totalDependents} functions transitively depend on ${r.name}\n`);
  }
}

export function diffImpact(customDbPath, opts = {}) {
  if (opts.format === 'mermaid') {
    console.log(diffImpactMermaid(customDbPath, opts));
    return;
  }
  const data = diffImpactData(customDbPath, opts);
  if (opts.ndjson) {
    printNdjson(data, 'affectedFunctions');
    return;
  }
  if (opts.json || opts.format === 'json') {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.error) {
    console.log(data.error);
    return;
  }
  if (data.changedFiles === 0) {
    console.log('No changes detected.');
    return;
  }
  if (data.affectedFunctions.length === 0) {
    console.log(
      '  No function-level changes detected (changes may be in imports, types, or config).',
    );
    return;
  }

  console.log(`\ndiff-impact: ${data.changedFiles} files changed\n`);
  console.log(`  ${data.affectedFunctions.length} functions changed:\n`);
  for (const fn of data.affectedFunctions) {
    console.log(`  ${kindIcon(fn.kind)} ${fn.name} -- ${fn.file}:${fn.line}`);
    if (fn.transitiveCallers > 0) console.log(`    ^ ${fn.transitiveCallers} transitive callers`);
  }
  if (data.historicallyCoupled && data.historicallyCoupled.length > 0) {
    console.log('\n  Historically coupled (not in static graph):\n');
    for (const c of data.historicallyCoupled) {
      const pct = `${(c.jaccard * 100).toFixed(0)}%`;
      console.log(
        `    ${c.file}  <- coupled with ${c.coupledWith} (${pct}, ${c.commitCount} commits)`,
      );
    }
  }
  if (data.ownership) {
    console.log(`\n  Affected owners: ${data.ownership.affectedOwners.join(', ')}`);
    console.log(`  Suggested reviewers: ${data.ownership.suggestedReviewers.join(', ')}`);
  }
  if (data.boundaryViolations && data.boundaryViolations.length > 0) {
    console.log(`\n  Boundary violations (${data.boundaryViolationCount}):\n`);
    for (const v of data.boundaryViolations) {
      console.log(`    [${v.name}] ${v.file} -> ${v.targetFile}`);
      if (v.message) console.log(`      ${v.message}`);
    }
  }
  if (data.summary) {
    let summaryLine = `\n  Summary: ${data.summary.functionsChanged} functions changed -> ${data.summary.callersAffected} callers affected across ${data.summary.filesAffected} files`;
    if (data.summary.historicallyCoupledCount > 0) {
      summaryLine += `, ${data.summary.historicallyCoupledCount} historically coupled`;
    }
    if (data.summary.ownersAffected > 0) {
      summaryLine += `, ${data.summary.ownersAffected} owners affected`;
    }
    if (data.summary.boundaryViolationCount > 0) {
      summaryLine += `, ${data.summary.boundaryViolationCount} boundary violations`;
    }
    console.log(`${summaryLine}\n`);
  }
}

// ─── File Exports ───────────────────────────────────────────────────────

function exportsFileImpl(db, file, noTests, getFileLines) {
  const fileNodes = db
    .prepare(`SELECT * FROM nodes WHERE file LIKE ? AND kind = 'file'`)
    .all(`%${file}%`);
  if (fileNodes.length === 0) return [];

  return fileNodes.map((fn) => {
    const symbols = db
      .prepare(`SELECT * FROM nodes WHERE file = ? AND kind != 'file' ORDER BY line`)
      .all(fn.file);

    // IDs of symbols that have incoming calls from other files (exported)
    const exportedIds = new Set(
      db
        .prepare(
          `SELECT DISTINCT e.target_id FROM edges e
           JOIN nodes caller ON e.source_id = caller.id
           JOIN nodes target ON e.target_id = target.id
           WHERE target.file = ? AND caller.file != ? AND e.kind = 'calls'`,
        )
        .all(fn.file, fn.file)
        .map((r) => r.target_id),
    );

    const fileLines = getFileLines(fn.file);

    const exported = symbols.filter((s) => exportedIds.has(s.id));
    const internal = symbols.filter((s) => !exportedIds.has(s.id));

    const results = exported.map((s) => {
      let consumers = db
        .prepare(
          `SELECT n.name, n.kind, n.file, n.line FROM edges e
           JOIN nodes n ON e.source_id = n.id
           WHERE e.target_id = ? AND e.kind = 'calls' AND n.file != ?`,
        )
        .all(s.id, fn.file);
      if (noTests) consumers = consumers.filter((c) => !isTestFile(c.file));

      return {
        name: s.name,
        kind: s.kind,
        line: s.line,
        endLine: s.end_line || null,
        role: s.role || null,
        signature: fileLines ? extractSignature(fileLines, s.line) : null,
        summary: fileLines ? extractSummary(fileLines, s.line) : null,
        consumers: consumers.map((c) => ({
          name: c.name,
          kind: c.kind,
          file: c.file,
          line: c.line,
        })),
        consumerCount: consumers.length,
      };
    });

    // Re-exports: files that re-export this file
    const reexports = db
      .prepare(
        `SELECT DISTINCT n.file FROM edges e
         JOIN nodes n ON e.source_id = n.id
         WHERE e.target_id = ? AND e.kind = 'reexports'`,
      )
      .all(fn.id)
      .map((r) => ({ file: r.file }));

    return {
      file: fn.file,
      results,
      reexports,
      totalExported: exported.length,
      totalInternal: internal.length,
    };
  });
}

export function exportsData(file, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;

  const dbPath = findDbPath(customDbPath);
  const repoRoot = path.resolve(path.dirname(dbPath), '..');

  const fileCache = new Map();
  function getFileLines(f) {
    if (fileCache.has(f)) return fileCache.get(f);
    try {
      const absPath = safePath(repoRoot, f);
      if (!absPath) {
        fileCache.set(f, null);
        return null;
      }
      const lines = fs.readFileSync(absPath, 'utf-8').split('\n');
      fileCache.set(f, lines);
      return lines;
    } catch (e) {
      debug(`getFileLines failed for ${f}: ${e.message}`);
      fileCache.set(f, null);
      return null;
    }
  }

  const all = exportsFileImpl(db, file, noTests, getFileLines);
  db.close();

  // Single-file command: take first match
  const match =
    all.length > 0
      ? all[0]
      : { file, results: [], reexports: [], totalExported: 0, totalInternal: 0 };
  return paginateResult(match, 'results', { limit: opts.limit, offset: opts.offset });
}

export function fileExports(file, customDbPath, opts = {}) {
  const data = exportsData(file, customDbPath, opts);
  if (opts.ndjson) {
    printNdjson(data, 'results');
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.results.length === 0 && data.totalExported === 0 && data.totalInternal === 0) {
    console.log(`No file matching "${file}" in graph`);
    return;
  }

  console.log(
    `\n# ${data.file} — ${data.totalExported} exported, ${data.totalInternal} internal\n`,
  );

  for (const s of data.results) {
    const sig = s.signature?.params != null ? `(${s.signature.params})` : '';
    const roleTag = s.role ? ` [${s.role}]` : '';
    console.log(`  ${kindIcon(s.kind)} ${s.name}${sig}${roleTag} :${s.line}`);
    if (s.consumers.length > 0) {
      for (const c of s.consumers) {
        console.log(`    <- ${c.name}  ${c.file}:${c.line}`);
      }
    } else {
      console.log('    (no consumers)');
    }
  }

  if (data.reexports.length > 0) {
    console.log(`\n  Re-exports: ${data.reexports.map((r) => r.file).join(', ')}`);
  }
  console.log();
}
