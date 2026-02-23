import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findCycles } from './cycles.js';
import { findDbPath, openReadonlyOrFail } from './db.js';
import { LANGUAGE_REGISTRY } from './parser.js';

const TEST_PATTERN = /\.(test|spec)\.|__test__|__tests__|\.stories\./;
function isTestFile(filePath) {
  return TEST_PATTERN.test(filePath);
}

const FUNCTION_KINDS = ['function', 'method', 'class'];
export const ALL_SYMBOL_KINDS = [
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

function kindIcon(kind) {
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
    default:
      return '-';
  }
}

// ─── Data-returning functions ───────────────────────────────────────────

export function queryNameData(name, customDbPath) {
  const db = openReadonlyOrFail(customDbPath);
  const nodes = db.prepare(`SELECT * FROM nodes WHERE name LIKE ?`).all(`%${name}%`);
  if (nodes.length === 0) {
    db.close();
    return { query: name, results: [] };
  }

  const results = nodes.map((node) => {
    const callees = db
      .prepare(`
      SELECT n.name, n.kind, n.file, n.line, e.kind as edge_kind
      FROM edges e JOIN nodes n ON e.target_id = n.id
      WHERE e.source_id = ?
    `)
      .all(node.id);

    const callers = db
      .prepare(`
      SELECT n.name, n.kind, n.file, n.line, e.kind as edge_kind
      FROM edges e JOIN nodes n ON e.source_id = n.id
      WHERE e.target_id = ?
    `)
      .all(node.id);

    return {
      name: node.name,
      kind: node.kind,
      file: node.file,
      line: node.line,
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
  return { query: name, results };
}

export function impactAnalysisData(file, customDbPath) {
  const db = openReadonlyOrFail(customDbPath);
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
      if (!visited.has(dep.id)) {
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

export function moduleMapData(customDbPath, limit = 20) {
  const db = openReadonlyOrFail(customDbPath);

  const nodes = db
    .prepare(`
    SELECT n.*,
      (SELECT COUNT(*) FROM edges WHERE source_id = n.id AND kind != 'contains') as out_edges,
      (SELECT COUNT(*) FROM edges WHERE target_id = n.id AND kind != 'contains') as in_edges
    FROM nodes n
    WHERE n.kind = 'file'
      AND n.file NOT LIKE '%.test.%'
      AND n.file NOT LIKE '%.spec.%'
      AND n.file NOT LIKE '%__test__%'
    ORDER BY (SELECT COUNT(*) FROM edges WHERE target_id = n.id AND kind != 'contains') DESC
    LIMIT ?
  `)
    .all(limit);

  const topNodes = nodes.map((n) => ({
    file: n.file,
    dir: path.dirname(n.file) || '.',
    inEdges: n.in_edges,
    outEdges: n.out_edges,
  }));

  const totalNodes = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
  const totalEdges = db.prepare('SELECT COUNT(*) as c FROM edges').get().c;
  const totalFiles = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'file'").get().c;

  db.close();
  return { limit, topNodes, stats: { totalFiles, totalNodes, totalEdges } };
}

export function fileDepsData(file, customDbPath) {
  const db = openReadonlyOrFail(customDbPath);
  const fileNodes = db
    .prepare(`SELECT * FROM nodes WHERE file LIKE ? AND kind = 'file'`)
    .all(`%${file}%`);
  if (fileNodes.length === 0) {
    db.close();
    return { file, results: [] };
  }

  const results = fileNodes.map((fn) => {
    const importsTo = db
      .prepare(`
      SELECT n.file, e.kind as edge_kind FROM edges e JOIN nodes n ON e.target_id = n.id
      WHERE e.source_id = ? AND e.kind IN ('imports', 'imports-type')
    `)
      .all(fn.id);

    const importedBy = db
      .prepare(`
      SELECT n.file, e.kind as edge_kind FROM edges e JOIN nodes n ON e.source_id = n.id
      WHERE e.target_id = ? AND e.kind IN ('imports', 'imports-type')
    `)
      .all(fn.id);

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
  return { file, results };
}

export function fnDepsData(name, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const depth = opts.depth || 3;
  const noTests = opts.noTests || false;

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
      name: node.name,
      kind: node.kind,
      file: node.file,
      line: node.line,
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
  return { name, results };
}

export function fnImpactData(name, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const maxDepth = opts.depth || 5;
  const noTests = opts.noTests || false;

  const nodes = findMatchingNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
  if (nodes.length === 0) {
    db.close();
    return { name, results: [] };
  }

  const results = nodes.slice(0, 3).map((node) => {
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
      name: node.name,
      kind: node.kind,
      file: node.file,
      line: node.line,
      levels,
      totalDependents: visited.size - 1,
    };
  });

  db.close();
  return { name, results };
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
    return { changedFiles: 0, affectedFunctions: [], affectedFiles: [], summary: null };
  }

  const changedRanges = new Map();
  let currentFile = null;
  for (const line of diffOutput.split('\n')) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!changedRanges.has(currentFile)) changedRanges.set(currentFile, []);
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
    return { changedFiles: 0, affectedFunctions: [], affectedFiles: [], summary: null };
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
    };
  });

  const affectedFiles = new Set();
  for (const key of allAffected) affectedFiles.add(key.split(':')[0]);

  db.close();
  return {
    changedFiles: changedRanges.size,
    affectedFunctions: functionResults,
    affectedFiles: [...affectedFiles],
    summary: {
      functionsChanged: affectedFunctions.length,
      callersAffected: allAffected.size,
      filesAffected: affectedFiles.size,
    },
  };
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
      `SELECT name, kind, file, line FROM nodes WHERE ${conditions.join(' AND ')} ORDER BY file, line`,
    )
    .all(...params);

  if (noTests) rows = rows.filter((r) => !isTestFile(r.file));

  db.close();
  return { count: rows.length, functions: rows };
}

export function statsData(customDbPath) {
  const db = openReadonlyOrFail(customDbPath);

  // Node breakdown by kind
  const nodeRows = db.prepare('SELECT kind, COUNT(*) as c FROM nodes GROUP BY kind').all();
  const nodesByKind = {};
  let totalNodes = 0;
  for (const r of nodeRows) {
    nodesByKind[r.kind] = r.c;
    totalNodes += r.c;
  }

  // Edge breakdown by kind
  const edgeRows = db.prepare('SELECT kind, COUNT(*) as c FROM edges GROUP BY kind').all();
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
  const fileNodes = db.prepare("SELECT file FROM nodes WHERE kind = 'file'").all();
  const byLanguage = {};
  for (const row of fileNodes) {
    const ext = path.extname(row.file).toLowerCase();
    const lang = extToLang.get(ext) || 'other';
    byLanguage[lang] = (byLanguage[lang] || 0) + 1;
  }
  const langCount = Object.keys(byLanguage).length;

  // Cycles
  const fileCycles = findCycles(db, { fileLevel: true });
  const fnCycles = findCycles(db, { fileLevel: false });

  // Top 5 coupling hotspots (fan-in + fan-out, file nodes)
  const hotspotRows = db
    .prepare(`
    SELECT n.file,
      (SELECT COUNT(*) FROM edges WHERE target_id = n.id) as fan_in,
      (SELECT COUNT(*) FROM edges WHERE source_id = n.id) as fan_out
    FROM nodes n
    WHERE n.kind = 'file'
    ORDER BY (SELECT COUNT(*) FROM edges WHERE target_id = n.id)
           + (SELECT COUNT(*) FROM edges WHERE source_id = n.id) DESC
    LIMIT 5
  `)
    .all();
  const hotspots = hotspotRows.map((r) => ({
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

  db.close();
  return {
    nodes: { total: totalNodes, byKind: nodesByKind },
    edges: { total: totalEdges, byKind: edgesByKind },
    files: { total: fileNodes.length, languages: langCount, byLanguage },
    cycles: { fileLevel: fileCycles.length, functionLevel: fnCycles.length },
    hotspots,
    embeddings,
  };
}

export function stats(customDbPath, opts = {}) {
  const data = statsData(customDbPath);
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

  console.log();
}

// ─── Human-readable output (original formatting) ───────────────────────

export function queryName(name, customDbPath, opts = {}) {
  const data = queryNameData(name, customDbPath);
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
  const data = impactAnalysisData(file, customDbPath);
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
  const data = moduleMapData(customDbPath, limit);
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
      const total = f.inEdges + f.outEdges;
      const bar = '#'.repeat(Math.min(total, 40));
      console.log(
        `    ${path.basename(f.file).padEnd(35)} <-${String(f.inEdges).padStart(3)} ->${String(f.outEdges).padStart(3)}  ${bar}`,
      );
    }
  }
  console.log(
    `\n  Total: ${data.stats.totalFiles} files, ${data.stats.totalNodes} symbols, ${data.stats.totalEdges} edges\n`,
  );
}

export function fileDeps(file, customDbPath, opts = {}) {
  const data = fileDepsData(file, customDbPath);
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
    const absPath = path.resolve(repoRoot, file);
    const content = fs.readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, (startLine || 1) - 1);
    const end = Math.min(lines.length, endLine || startLine + 50);
    return lines.slice(start, end).join('\n');
  } catch {
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

  let nodes = findMatchingNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
  if (nodes.length === 0) {
    db.close();
    return { name, results: [] };
  }

  // Limit to first 5 results
  nodes = nodes.slice(0, 5);

  // File-lines cache to avoid re-reading the same file
  const fileCache = new Map();
  function getFileLines(file) {
    if (fileCache.has(file)) return fileCache.get(file);
    try {
      const absPath = path.resolve(repoRoot, file);
      const lines = fs.readFileSync(absPath, 'utf-8').split('\n');
      fileCache.set(file, lines);
      return lines;
    } catch {
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

    return {
      name: node.name,
      kind: node.kind,
      file: node.file,
      line: node.line,
      endLine: node.end_line || null,
      source,
      signature,
      callees,
      callers,
      relatedTests,
    };
  });

  db.close();
  return { name, results };
}

export function context(name, customDbPath, opts = {}) {
  const data = contextData(name, customDbPath, opts);
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
    console.log(`\n# ${r.name} (${r.kind}) — ${r.file}:${lineRange}\n`);

    // Signature
    if (r.signature) {
      console.log('## Type/Shape Info');
      if (r.signature.params != null) console.log(`  Parameters: (${r.signature.params})`);
      if (r.signature.returnType) console.log(`  Returns: ${r.signature.returnType}`);
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

    return {
      name: node.name,
      kind: node.kind,
      file: node.file,
      line: node.line,
      endLine: node.end_line || null,
      lineCount,
      summary,
      signature,
      callees,
      callers,
      relatedTests,
    };
  });
}

export function explainData(target, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;
  const kind = isFileLikeTarget(target) ? 'file' : 'function';

  const dbPath = findDbPath(customDbPath);
  const repoRoot = path.resolve(path.dirname(dbPath), '..');

  const fileCache = new Map();
  function getFileLines(file) {
    if (fileCache.has(file)) return fileCache.get(file);
    try {
      const absPath = path.resolve(repoRoot, file);
      const lines = fs.readFileSync(absPath, 'utf-8').split('\n');
      fileCache.set(file, lines);
      return lines;
    } catch {
      fileCache.set(file, null);
      return null;
    }
  }

  const results =
    kind === 'file'
      ? explainFileImpl(db, target, getFileLines)
      : explainFunctionImpl(db, target, noTests, getFileLines);

  db.close();
  return { target, kind, results };
}

export function explain(target, customDbPath, opts = {}) {
  const data = explainData(target, customDbPath, opts);
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
          const summary = s.summary ? `  -- ${s.summary}` : '';
          console.log(`  ${kindIcon(s.kind)} ${s.name}${sig} :${s.line}${summary}`);
        }
      }

      if (r.internal.length > 0) {
        console.log(`\n## Internal`);
        for (const s of r.internal) {
          const sig = s.signature?.params != null ? `(${s.signature.params})` : '';
          const summary = s.summary ? `  -- ${s.summary}` : '';
          console.log(`  ${kindIcon(s.kind)} ${s.name}${sig} :${s.line}${summary}`);
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
    for (const r of data.results) {
      const lineRange = r.endLine ? `${r.line}-${r.endLine}` : `${r.line}`;
      const lineInfo = r.lineCount ? `${r.lineCount} lines` : '';
      const summaryPart = r.summary ? ` | ${r.summary}` : '';
      console.log(`\n# ${r.name} (${r.kind})  ${r.file}:${lineRange}`);
      if (lineInfo || r.summary) {
        console.log(`  ${lineInfo}${summaryPart}`);
      }
      if (r.signature) {
        if (r.signature.params != null) console.log(`  Parameters: (${r.signature.params})`);
        if (r.signature.returnType) console.log(`  Returns: ${r.signature.returnType}`);
      }

      if (r.callees.length > 0) {
        console.log(`\n## Calls (${r.callees.length})`);
        for (const c of r.callees) {
          console.log(`  ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
        }
      }

      if (r.callers.length > 0) {
        console.log(`\n## Called by (${r.callers.length})`);
        for (const c of r.callers) {
          console.log(`  ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
        }
      }

      if (r.relatedTests.length > 0) {
        const label = r.relatedTests.length === 1 ? 'file' : 'files';
        console.log(`\n## Tests (${r.relatedTests.length} ${label})`);
        for (const t of r.relatedTests) {
          console.log(`  ${t.file}`);
        }
      }

      if (r.callees.length === 0 && r.callers.length === 0) {
        console.log(`  (no call edges found -- may be invoked dynamically or via re-exports)`);
      }
      console.log();
    }
  }
}

export function fnImpact(name, customDbPath, opts = {}) {
  const data = fnImpactData(name, customDbPath, opts);
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
  const data = diffImpactData(customDbPath, opts);
  if (opts.json) {
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
  if (data.summary) {
    console.log(
      `\n  Summary: ${data.summary.functionsChanged} functions changed -> ${data.summary.callersAffected} callers affected across ${data.summary.filesAffected} files\n`,
    );
  }
}
