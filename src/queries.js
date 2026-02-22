import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findDbPath, openReadonlyOrFail } from './db.js';

const TEST_PATTERN = /\.(test|spec)\.|__test__|__tests__|\.stories\./;
function isTestFile(filePath) {
  return TEST_PATTERN.test(filePath);
}

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
      (SELECT COUNT(*) FROM edges WHERE source_id = n.id) as out_edges,
      (SELECT COUNT(*) FROM edges WHERE target_id = n.id) as in_edges
    FROM nodes n
    WHERE n.kind = 'file'
      AND n.file NOT LIKE '%.test.%'
      AND n.file NOT LIKE '%.spec.%'
      AND n.file NOT LIKE '%__test__%'
    ORDER BY (SELECT COUNT(*) FROM edges WHERE target_id = n.id) DESC
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

  let nodes = db
    .prepare(
      `SELECT * FROM nodes WHERE name LIKE ? AND kind IN ('function', 'method', 'class') ORDER BY file, line`,
    )
    .all(`%${name}%`);
  if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));
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

  let nodes = db
    .prepare(`SELECT * FROM nodes WHERE name LIKE ? AND kind IN ('function', 'method', 'class')`)
    .all(`%${name}%`);
  if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));
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
