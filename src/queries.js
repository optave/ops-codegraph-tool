import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateBoundaries } from './boundaries.js';
import { coChangeForFiles } from './cochange.js';
import { loadConfig } from './config.js';
import { findCycles } from './cycles.js';
import {
  findDbPath,
  findNodesWithFanIn,
  iterateFunctionNodes,
  listFunctionNodes,
  openReadonlyOrFail,
  testFilterSQL,
} from './db.js';
import { ALL_SYMBOL_KINDS } from './kinds.js';
import { debug } from './logger.js';
import { ownersForFiles } from './owners.js';
import { paginateResult } from './paginate.js';
import { LANGUAGE_REGISTRY } from './parser.js';
import { isTestFile } from './test-filter.js';

// Re-export from dedicated module for backward compat
export { isTestFile, TEST_PATTERN } from './test-filter.js';

/**
 * Resolve a file path relative to repoRoot, rejecting traversal outside the repo.
 * Returns null if the resolved path escapes repoRoot.
 */
function safePath(repoRoot, file) {
  const resolved = path.resolve(repoRoot, file);
  if (!resolved.startsWith(repoRoot + path.sep) && resolved !== repoRoot) return null;
  return resolved;
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

// Re-export kind/edge constants from kinds.js (canonical source)
export {
  ALL_SYMBOL_KINDS,
  CORE_EDGE_KINDS,
  CORE_SYMBOL_KINDS,
  EVERY_EDGE_KIND,
  EVERY_SYMBOL_KIND,
  EXTENDED_SYMBOL_KINDS,
  STRUCTURAL_EDGE_KINDS,
  VALID_ROLES,
} from './kinds.js';

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
export function findMatchingNodes(db, name, opts = {}) {
  const kinds = opts.kinds || (opts.kind ? [opts.kind] : FUNCTION_KINDS);

  const rows = findNodesWithFanIn(db, `%${name}%`, { kinds, file: opts.file });

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

  const testFilter = testFilterSQL('n.file', noTests);

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

  let rows = listFunctionNodes(db, { file: opts.file, pattern: opts.pattern });

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

    for (const row of iterateFunctionNodes(db, { file: opts.file, pattern: opts.pattern })) {
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
  const testFilter = testFilterSQL('n.file', noTests);
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

// ─── exportsData ─────────────────────────────────────────────────────

function exportsFileImpl(db, target, noTests, getFileLines, unused) {
  const fileNodes = db
    .prepare(`SELECT * FROM nodes WHERE file LIKE ? AND kind = 'file'`)
    .all(`%${target}%`);
  if (fileNodes.length === 0) return [];

  // Detect whether exported column exists
  let hasExportedCol = false;
  try {
    db.prepare('SELECT exported FROM nodes LIMIT 0').raw();
    hasExportedCol = true;
  } catch {
    /* old DB without exported column */
  }

  return fileNodes.map((fn) => {
    const symbols = db
      .prepare(`SELECT * FROM nodes WHERE file = ? AND kind != 'file' ORDER BY line`)
      .all(fn.file);

    let exported;
    if (hasExportedCol) {
      // Use the exported column populated during build
      exported = db
        .prepare(
          "SELECT * FROM nodes WHERE file = ? AND kind != 'file' AND exported = 1 ORDER BY line",
        )
        .all(fn.file);
    } else {
      // Fallback: symbols that have incoming calls from other files
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
      exported = symbols.filter((s) => exportedIds.has(s.id));
    }
    const internalCount = symbols.length - exported.length;

    const results = exported.map((s) => {
      const fileLines = getFileLines(fn.file);

      let consumers = db
        .prepare(
          `SELECT n.name, n.file, n.line FROM edges e JOIN nodes n ON e.source_id = n.id
           WHERE e.target_id = ? AND e.kind = 'calls'`,
        )
        .all(s.id);
      if (noTests) consumers = consumers.filter((c) => !isTestFile(c.file));

      return {
        name: s.name,
        kind: s.kind,
        line: s.line,
        endLine: s.end_line ?? null,
        role: s.role || null,
        signature: fileLines ? extractSignature(fileLines, s.line) : null,
        summary: fileLines ? extractSummary(fileLines, s.line) : null,
        consumers: consumers.map((c) => ({ name: c.name, file: c.file, line: c.line })),
        consumerCount: consumers.length,
      };
    });

    const totalUnused = results.filter((r) => r.consumerCount === 0).length;

    // Files that re-export this file (barrel → this file)
    const reexports = db
      .prepare(
        `SELECT DISTINCT n.file FROM edges e JOIN nodes n ON e.source_id = n.id
         WHERE e.target_id = ? AND e.kind = 'reexports'`,
      )
      .all(fn.id)
      .map((r) => ({ file: r.file }));

    let filteredResults = results;
    if (unused) {
      filteredResults = results.filter((r) => r.consumerCount === 0);
    }

    return {
      file: fn.file,
      results: filteredResults,
      reexports,
      totalExported: exported.length,
      totalInternal: internalCount,
      totalUnused,
    };
  });
}

export function exportsData(file, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;

  const dbFilePath = findDbPath(customDbPath);
  const repoRoot = path.resolve(path.dirname(dbFilePath), '..');

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
    } catch {
      fileCache.set(file, null);
      return null;
    }
  }

  const unused = opts.unused || false;
  const fileResults = exportsFileImpl(db, file, noTests, getFileLines, unused);
  db.close();

  if (fileResults.length === 0) {
    return paginateResult(
      { file, results: [], reexports: [], totalExported: 0, totalInternal: 0, totalUnused: 0 },
      'results',
      { limit: opts.limit, offset: opts.offset },
    );
  }

  // For single-file match return flat; for multi-match return first (like explainData)
  const first = fileResults[0];
  const base = {
    file: first.file,
    results: first.results,
    reexports: first.reexports,
    totalExported: first.totalExported,
    totalInternal: first.totalInternal,
    totalUnused: first.totalUnused,
  };
  return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
}
