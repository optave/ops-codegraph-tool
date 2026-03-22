import path from 'node:path';
import { openReadonlyOrFail, testFilterSQL } from '../../db/index.js';
import { loadConfig } from '../../infrastructure/config.js';
import { debug } from '../../infrastructure/logger.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import { DEAD_ROLE_PREFIX } from '../../shared/kinds.js';
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

// biome-ignore lint/suspicious/noExplicitAny: db handle from better-sqlite3
function buildTestFileIds(db: any): Set<number> {
  // biome-ignore lint/suspicious/noExplicitAny: untyped SQLite row
  const allFileNodes = db.prepare("SELECT id, file FROM nodes WHERE kind = 'file'").all() as any[];
  const testFileIds = new Set<number>();
  const testFiles = new Set<string>();
  for (const n of allFileNodes) {
    if (isTestFile(n.file)) {
      testFileIds.add(n.id);
      testFiles.add(n.file);
    }
  }
  // biome-ignore lint/suspicious/noExplicitAny: untyped SQLite row
  const allNodes = db.prepare('SELECT id, file FROM nodes').all() as any[];
  for (const n of allNodes) {
    if (testFiles.has(n.file)) testFileIds.add(n.id);
  }
  return testFileIds;
}

function countNodesByKind(
  // biome-ignore lint/suspicious/noExplicitAny: db handle from better-sqlite3
  db: any,
  testFileIds: Set<number> | null,
): { total: number; byKind: Record<string, number> } {
  // biome-ignore lint/suspicious/noExplicitAny: untyped SQLite row
  let nodeRows: any[];
  if (testFileIds) {
    // biome-ignore lint/suspicious/noExplicitAny: untyped SQLite row
    const allNodes = db.prepare('SELECT id, kind, file FROM nodes').all() as any[];
    const filtered = allNodes.filter((n) => !testFileIds.has(n.id));
    const counts: Record<string, number> = {};
    for (const n of filtered) counts[n.kind] = (counts[n.kind] || 0) + 1;
    nodeRows = Object.entries(counts).map(([kind, c]) => ({ kind, c }));
  } else {
    nodeRows = db.prepare('SELECT kind, COUNT(*) as c FROM nodes GROUP BY kind').all();
  }
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const r of nodeRows) {
    byKind[r.kind] = r.c;
    total += r.c;
  }
  return { total, byKind };
}

function countEdgesByKind(
  // biome-ignore lint/suspicious/noExplicitAny: db handle from better-sqlite3
  db: any,
  testFileIds: Set<number> | null,
): { total: number; byKind: Record<string, number> } {
  // biome-ignore lint/suspicious/noExplicitAny: untyped SQLite row
  let edgeRows: any[];
  if (testFileIds) {
    // biome-ignore lint/suspicious/noExplicitAny: untyped SQLite row
    const allEdges = db.prepare('SELECT source_id, target_id, kind FROM edges').all() as any[];
    const filtered = allEdges.filter(
      (e) => !testFileIds.has(e.source_id) && !testFileIds.has(e.target_id),
    );
    const counts: Record<string, number> = {};
    for (const e of filtered) counts[e.kind] = (counts[e.kind] || 0) + 1;
    edgeRows = Object.entries(counts).map(([kind, c]) => ({ kind, c }));
  } else {
    edgeRows = db.prepare('SELECT kind, COUNT(*) as c FROM edges GROUP BY kind').all();
  }
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const r of edgeRows) {
    byKind[r.kind] = r.c;
    total += r.c;
  }
  return { total, byKind };
}

function countFilesByLanguage(
  // biome-ignore lint/suspicious/noExplicitAny: db handle from better-sqlite3
  db: any,
  noTests: boolean,
): { total: number; languages: number; byLanguage: Record<string, number> } {
  const extToLang = new Map<string, string>();
  for (const entry of LANGUAGE_REGISTRY) {
    for (const ext of entry.extensions) {
      extToLang.set(ext, entry.id);
    }
  }
  // biome-ignore lint/suspicious/noExplicitAny: untyped SQLite row
  let fileNodes = db.prepare("SELECT file FROM nodes WHERE kind = 'file'").all() as any[];
  if (noTests) fileNodes = fileNodes.filter((n) => !isTestFile(n.file));
  const byLanguage: Record<string, number> = {};
  for (const row of fileNodes) {
    const ext = path.extname(row.file).toLowerCase();
    const lang = extToLang.get(ext) || 'other';
    byLanguage[lang] = (byLanguage[lang] || 0) + 1;
  }
  return { total: fileNodes.length, languages: Object.keys(byLanguage).length, byLanguage };
}

// biome-ignore lint/suspicious/noExplicitAny: db handle from better-sqlite3
function findHotspots(
  db: any,
  noTests: boolean,
  limit: number,
): { file: string; fanIn: number; fanOut: number }[] {
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
    // biome-ignore lint/suspicious/noExplicitAny: untyped SQLite row
    .all() as any[];
  const filtered = noTests ? hotspotRows.filter((r) => !isTestFile(r.file)) : hotspotRows;
  return filtered.slice(0, limit).map((r) => ({
    file: r.file,
    fanIn: r.fan_in,
    fanOut: r.fan_out,
  }));
}

// biome-ignore lint/suspicious/noExplicitAny: db handle from better-sqlite3
function getEmbeddingsInfo(db: any): object | null {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: untyped SQLite row
    const count = db.prepare('SELECT COUNT(*) as c FROM embeddings').get() as any;
    if (count && count.c > 0) {
      const meta: Record<string, string> = {};
      // biome-ignore lint/suspicious/noExplicitAny: untyped SQLite row
      const metaRows = db.prepare('SELECT key, value FROM embedding_meta').all() as any[];
      for (const r of metaRows) meta[r.key] = r.value;
      return {
        count: count.c,
        model: meta['model'] || null,
        dim: meta['dim'] ? parseInt(meta['dim'], 10) : null,
        builtAt: meta['built_at'] || null,
      };
    }
  } catch (e) {
    debug(`embeddings lookup skipped: ${(e as Error).message}`);
  }
  return null;
}

function computeQualityMetrics(
  // biome-ignore lint/suspicious/noExplicitAny: db handle from better-sqlite3
  db: any,
  testFilter: string,
  fpThreshold = FALSE_POSITIVE_CALLER_THRESHOLD,
): object {
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
    // biome-ignore lint/suspicious/noExplicitAny: untyped SQLite row
    .all(fpThreshold) as any[];
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

// biome-ignore lint/suspicious/noExplicitAny: db handle from better-sqlite3
function countRoles(db: any, noTests: boolean): Record<string, number> {
  // biome-ignore lint/suspicious/noExplicitAny: untyped SQLite row
  let roleRows: any[];
  if (noTests) {
    const allRoleNodes = db
      .prepare('SELECT role, file FROM nodes WHERE role IS NOT NULL')
      // biome-ignore lint/suspicious/noExplicitAny: untyped SQLite row
      .all() as any[];
    const filtered = allRoleNodes.filter((n) => !isTestFile(n.file));
    const counts: Record<string, number> = {};
    for (const n of filtered) counts[n.role] = (counts[n.role] || 0) + 1;
    roleRows = Object.entries(counts).map(([role, c]) => ({ role, c }));
  } else {
    roleRows = db
      .prepare('SELECT role, COUNT(*) as c FROM nodes WHERE role IS NOT NULL GROUP BY role')
      .all();
  }
  const roles: Record<string, number> = {};
  let deadTotal = 0;
  for (const r of roleRows) {
    roles[r.role] = r.c;
    if (r.role.startsWith(DEAD_ROLE_PREFIX)) deadTotal += r.c;
  }
  if (deadTotal > 0) roles['dead'] = deadTotal;
  return roles;
}

// biome-ignore lint/suspicious/noExplicitAny: db handle from better-sqlite3
function getComplexitySummary(db: any, testFilter: string): object | null {
  try {
    const cRows = db
      .prepare(
        `SELECT fc.cognitive, fc.cyclomatic, fc.max_nesting, fc.maintainability_index
         FROM function_complexity fc JOIN nodes n ON fc.node_id = n.id
         WHERE n.kind IN ('function','method') ${testFilter}`,
      )
      // biome-ignore lint/suspicious/noExplicitAny: untyped SQLite row
      .all() as any[];
    if (cRows.length > 0) {
      const miValues = cRows.map((r) => r.maintainability_index || 0);
      return {
        analyzed: cRows.length,
        avgCognitive: +(cRows.reduce((s: number, r) => s + r.cognitive, 0) / cRows.length).toFixed(
          1,
        ),
        avgCyclomatic: +(
          cRows.reduce((s: number, r) => s + r.cyclomatic, 0) / cRows.length
        ).toFixed(1),
        maxCognitive: Math.max(...cRows.map((r) => r.cognitive)),
        maxCyclomatic: Math.max(...cRows.map((r) => r.cyclomatic)),
        avgMI: +(miValues.reduce((s: number, v: number) => s + v, 0) / miValues.length).toFixed(1),
        minMI: +Math.min(...miValues).toFixed(1),
      };
    }
  } catch (e) {
    debug(`complexity summary skipped: ${(e as Error).message}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function moduleMapData(
  customDbPath: string | undefined,
  limit = 20,
  opts: { noTests?: boolean } = {},
): object {
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
      // biome-ignore lint/suspicious/noExplicitAny: untyped SQLite row
      .all(limit) as any[];

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

export function statsData(
  customDbPath: string | undefined,
  // biome-ignore lint/suspicious/noExplicitAny: config shape varies by caller
  opts: { noTests?: boolean; config?: any } = {},
): object {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const config = opts.config || loadConfig();
    const testFilter = testFilterSQL('n.file', noTests);

    const testFileIds = noTests ? buildTestFileIds(db) : null;

    const { total: totalNodes, byKind: nodesByKind } = countNodesByKind(db, testFileIds);
    const { total: totalEdges, byKind: edgesByKind } = countEdgesByKind(db, testFileIds);
    const files = countFilesByLanguage(db, noTests);

    const fileCycles = findCycles(db, { fileLevel: true, noTests });
    const fnCycles = findCycles(db, { fileLevel: false, noTests });

    const hotspots = findHotspots(db, noTests, 5);
    const embeddings = getEmbeddingsInfo(db);
    const fpThreshold = config.analysis?.falsePositiveCallers ?? FALSE_POSITIVE_CALLER_THRESHOLD;
    const quality = computeQualityMetrics(db, testFilter, fpThreshold);
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
