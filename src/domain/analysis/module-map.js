import path from 'node:path';
import { openReadonlyOrFail, testFilterSQL } from '../../db/index.js';
import { debug } from '../../infrastructure/logger.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import { findCycles } from '../graph/cycles.js';
import { LANGUAGE_REGISTRY } from '../parser.js';

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

// ---------------------------------------------------------------------------
// Section helpers
// ---------------------------------------------------------------------------

function buildTestFileIds(db) {
  const allFileNodes = db.prepare("SELECT id, file FROM nodes WHERE kind = 'file'").all();
  const testFileIds = new Set();
  const testFiles = new Set();
  for (const n of allFileNodes) {
    if (isTestFile(n.file)) {
      testFileIds.add(n.id);
      testFiles.add(n.file);
    }
  }
  const allNodes = db.prepare('SELECT id, file FROM nodes').all();
  for (const n of allNodes) {
    if (testFiles.has(n.file)) testFileIds.add(n.id);
  }
  return testFileIds;
}

function countNodesByKind(db, testFileIds) {
  let nodeRows;
  if (testFileIds) {
    const allNodes = db.prepare('SELECT id, kind, file FROM nodes').all();
    const filtered = allNodes.filter((n) => !testFileIds.has(n.id));
    const counts = {};
    for (const n of filtered) counts[n.kind] = (counts[n.kind] || 0) + 1;
    nodeRows = Object.entries(counts).map(([kind, c]) => ({ kind, c }));
  } else {
    nodeRows = db.prepare('SELECT kind, COUNT(*) as c FROM nodes GROUP BY kind').all();
  }
  const byKind = {};
  let total = 0;
  for (const r of nodeRows) {
    byKind[r.kind] = r.c;
    total += r.c;
  }
  return { total, byKind };
}

function countEdgesByKind(db, testFileIds) {
  let edgeRows;
  if (testFileIds) {
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
  const byKind = {};
  let total = 0;
  for (const r of edgeRows) {
    byKind[r.kind] = r.c;
    total += r.c;
  }
  return { total, byKind };
}

function countFilesByLanguage(db, noTests) {
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
  return { total: fileNodes.length, languages: Object.keys(byLanguage).length, byLanguage };
}

function findHotspots(db, noTests, limit) {
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
  const filtered = noTests ? hotspotRows.filter((r) => !isTestFile(r.file)) : hotspotRows;
  return filtered.slice(0, limit).map((r) => ({
    file: r.file,
    fanIn: r.fan_in,
    fanOut: r.fan_out,
  }));
}

function getEmbeddingsInfo(db) {
  try {
    const count = db.prepare('SELECT COUNT(*) as c FROM embeddings').get();
    if (count && count.c > 0) {
      const meta = {};
      const metaRows = db.prepare('SELECT key, value FROM embedding_meta').all();
      for (const r of metaRows) meta[r.key] = r.value;
      return {
        count: count.c,
        model: meta.model || null,
        dim: meta.dim ? parseInt(meta.dim, 10) : null,
        builtAt: meta.built_at || null,
      };
    }
  } catch (e) {
    debug(`embeddings lookup skipped: ${e.message}`);
  }
  return null;
}

function computeQualityMetrics(db, testFilter) {
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

  let fpEdgeCount = 0;
  for (const fp of falsePositiveWarnings) fpEdgeCount += fp.callerCount;
  const falsePositiveRatio = totalCallEdges > 0 ? fpEdgeCount / totalCallEdges : 0;

  const score = Math.round(
    callerCoverage * 40 + callConfidence * 40 + (1 - falsePositiveRatio) * 20,
  );

  return {
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
}

function countRoles(db, noTests) {
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
  let deadTotal = 0;
  for (const r of roleRows) {
    roles[r.role] = r.c;
    if (r.role.startsWith('dead')) deadTotal += r.c;
  }
  if (deadTotal > 0) roles.dead = deadTotal;
  return roles;
}

function getComplexitySummary(db, testFilter) {
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
      return {
        analyzed: cRows.length,
        avgCognitive: +(cRows.reduce((s, r) => s + r.cognitive, 0) / cRows.length).toFixed(1),
        avgCyclomatic: +(cRows.reduce((s, r) => s + r.cyclomatic, 0) / cRows.length).toFixed(1),
        maxCognitive: Math.max(...cRows.map((r) => r.cognitive)),
        maxCyclomatic: Math.max(...cRows.map((r) => r.cyclomatic)),
        avgMI: +(miValues.reduce((s, v) => s + v, 0) / miValues.length).toFixed(1),
        minMI: +Math.min(...miValues).toFixed(1),
      };
    }
  } catch (e) {
    debug(`complexity summary skipped: ${e.message}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function moduleMapData(customDbPath, limit = 20, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
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

    return { limit, topNodes, stats: { totalFiles, totalNodes, totalEdges } };
  } finally {
    db.close();
  }
}

export function statsData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const testFilter = testFilterSQL('n.file', noTests);

    const testFileIds = noTests ? buildTestFileIds(db) : null;

    const { total: totalNodes, byKind: nodesByKind } = countNodesByKind(db, testFileIds);
    const { total: totalEdges, byKind: edgesByKind } = countEdgesByKind(db, testFileIds);
    const files = countFilesByLanguage(db, noTests);

    const fileCycles = findCycles(db, { fileLevel: true, noTests });
    const fnCycles = findCycles(db, { fileLevel: false, noTests });

    const hotspots = findHotspots(db, noTests, 5);
    const embeddings = getEmbeddingsInfo(db);
    const quality = computeQualityMetrics(db, testFilter);
    const roles = countRoles(db, noTests);
    const complexity = getComplexitySummary(db, testFilter);

    return {
      nodes: { total: totalNodes, byKind: nodesByKind },
      edges: { total: totalEdges, byKind: edgesByKind },
      files,
      cycles: { fileLevel: fileCycles.length, functionLevel: fnCycles.length },
      hotspots,
      embeddings,
      quality,
      roles,
      complexity,
    };
  } finally {
    db.close();
  }
}
