import path from 'node:path';
import { openReadonlyOrFail, openReadonlyWithNative, testFilterSQL } from '../../db/index.js';
import { loadConfig } from '../../infrastructure/config.js';
import { debug } from '../../infrastructure/logger.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import { DEAD_ROLE_PREFIX } from '../../shared/kinds.js';
import type { BetterSqlite3Database, NativeDatabase } from '../../types.js';
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

function countNodesByKind(db: BetterSqlite3Database, noTests: boolean) {
  const testFilter = testFilterSQL('file', noTests);
  const nodeRows = db
    .prepare(`SELECT kind, COUNT(*) as c FROM nodes WHERE 1=1 ${testFilter} GROUP BY kind`)
    .all() as Array<{ kind: string; c: number }>;
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const r of nodeRows) {
    byKind[r.kind] = r.c;
    total += r.c;
  }
  return { total, byKind };
}

function countEdgesByKind(db: BetterSqlite3Database, noTests: boolean) {
  let edgeRows: Array<{ kind: string; c: number }>;
  if (noTests) {
    // Join edges with source node to filter out test files in SQL
    const srcFilter = testFilterSQL('ns.file', true);
    const tgtFilter = testFilterSQL('nt.file', true);
    edgeRows = db
      .prepare(`
        SELECT e.kind, COUNT(*) as c FROM edges e
        JOIN nodes ns ON e.source_id = ns.id
        JOIN nodes nt ON e.target_id = nt.id
        WHERE 1=1 ${srcFilter} ${tgtFilter}
        GROUP BY e.kind
      `)
      .all() as Array<{ kind: string; c: number }>;
  } else {
    edgeRows = db.prepare('SELECT kind, COUNT(*) as c FROM edges GROUP BY kind').all() as Array<{
      kind: string;
      c: number;
    }>;
  }
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const r of edgeRows) {
    byKind[r.kind] = r.c;
    total += r.c;
  }
  return { total, byKind };
}

function countFilesByLanguage(db: BetterSqlite3Database, noTests: boolean) {
  const extToLang = new Map<string, string>();
  for (const entry of LANGUAGE_REGISTRY) {
    for (const ext of entry.extensions) {
      extToLang.set(ext, entry.id);
    }
  }
  let fileNodes = db.prepare("SELECT file FROM nodes WHERE kind = 'file'").all() as Array<{
    file: string;
  }>;
  if (noTests) fileNodes = fileNodes.filter((n) => !isTestFile(n.file));
  const byLanguage: Record<string, number> = {};
  for (const row of fileNodes) {
    const ext = path.extname(row.file).toLowerCase();
    const lang = extToLang.get(ext) || 'other';
    byLanguage[lang] = (byLanguage[lang] || 0) + 1;
  }
  return { total: fileNodes.length, languages: Object.keys(byLanguage).length, byLanguage };
}

function findHotspots(db: BetterSqlite3Database, noTests: boolean, limit: number) {
  const testFilter = testFilterSQL('n.file', noTests);
  const hotspotRows = db
    .prepare(`
      SELECT n.file,
        COALESCE(fi.cnt, 0) as fan_in,
        COALESCE(fo.cnt, 0) as fan_out
      FROM nodes n
      LEFT JOIN (
        SELECT target_id, COUNT(*) AS cnt FROM edges
        WHERE kind NOT IN ('contains', 'parameter_of', 'receiver')
        GROUP BY target_id
      ) fi ON fi.target_id = n.id
      LEFT JOIN (
        SELECT source_id, COUNT(*) AS cnt FROM edges
        WHERE kind NOT IN ('contains', 'parameter_of', 'receiver')
        GROUP BY source_id
      ) fo ON fo.source_id = n.id
      WHERE n.kind = 'file' ${testFilter}
      ORDER BY COALESCE(fi.cnt, 0) + COALESCE(fo.cnt, 0) DESC
      LIMIT ?
    `)
    .all(limit) as Array<{ file: string; fan_in: number; fan_out: number }>;
  return hotspotRows.map((r) => ({
    file: r.file,
    fanIn: r.fan_in,
    fanOut: r.fan_out,
  }));
}

function getEmbeddingsInfo(db: BetterSqlite3Database) {
  try {
    const count = db.prepare('SELECT COUNT(*) as c FROM embeddings').get() as
      | { c: number }
      | undefined;
    if (count && count.c > 0) {
      const meta: { model?: string; dim?: string; built_at?: string } = {};
      const metaRows = db.prepare('SELECT key, value FROM embedding_meta').all() as Array<{
        key: string;
        value: string;
      }>;
      for (const r of metaRows) (meta as Record<string, string>)[r.key] = r.value;
      return {
        count: count.c,
        model: meta.model || null,
        dim: meta.dim ? parseInt(meta.dim, 10) : null,
        builtAt: meta.built_at || null,
      };
    }
  } catch (e: unknown) {
    debug(`embeddings lookup skipped: ${(e as Error).message}`);
  }
  return null;
}

function countCallEdgesByTechnique(
  db: BetterSqlite3Database,
  testFilter: string,
): Record<string, number> {
  // testFilter uses n.file — join source node to apply the same file-scope as
  // the rest of computeQualityMetrics so --no-tests is consistent.
  const rows = db
    .prepare(
      `SELECT e.technique, COUNT(*) as c
       FROM edges e
       JOIN nodes n ON e.source_id = n.id
       WHERE e.kind = 'calls' AND e.technique IS NOT NULL ${testFilter}
       GROUP BY e.technique`,
    )
    .all() as Array<{ technique: string; c: number }>;
  const byTechnique: Record<string, number> = {};
  for (const r of rows) byTechnique[r.technique] = r.c;
  return byTechnique;
}

function computeQualityMetrics(
  db: BetterSqlite3Database,
  testFilter: string,
  fpThreshold = FALSE_POSITIVE_CALLER_THRESHOLD,
) {
  const qualityTestFilter = testFilter.replace(/n\.file/g, 'file');

  const totalCallable = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM nodes WHERE kind IN ('function', 'method') ${qualityTestFilter}`,
      )
      .get() as { c: number }
  ).c;
  const callableWithCallers = (
    db
      .prepare(`
      SELECT COUNT(DISTINCT e.target_id) as c FROM edges e
      JOIN nodes n ON e.target_id = n.id
      WHERE e.kind = 'calls' AND n.kind IN ('function', 'method') ${testFilter}
    `)
      .get() as { c: number }
  ).c;
  const callerCoverage = totalCallable > 0 ? callableWithCallers / totalCallable : 0;

  const totalCallEdges = (
    db.prepare("SELECT COUNT(*) as c FROM edges WHERE kind = 'calls'").get() as { c: number }
  ).c;
  // Exclude sink edges (confidence=0.0) from the confidence ratio: they flag
  // unresolvable dynamic calls (eval/computed-key) and are not resolution
  // attempts — including them in the denominator unfairly penalises the metric.
  const resolvedCallEdges = (
    db.prepare("SELECT COUNT(*) as c FROM edges WHERE kind = 'calls' AND confidence > 0").get() as {
      c: number;
    }
  ).c;
  const highConfCallEdges = (
    db
      .prepare("SELECT COUNT(*) as c FROM edges WHERE kind = 'calls' AND confidence >= 0.7")
      .get() as { c: number }
  ).c;
  const callConfidence = resolvedCallEdges > 0 ? highConfCallEdges / resolvedCallEdges : 0;

  const falsePositiveWarnings = buildFalsePositiveWarnings(queryFalsePositiveRows(db, fpThreshold));

  let fpEdgeCount = 0;
  for (const fp of falsePositiveWarnings) fpEdgeCount += fp.callerCount;
  const falsePositiveRatio = totalCallEdges > 0 ? fpEdgeCount / totalCallEdges : 0;

  const score = computeQualityScore(callerCoverage, callConfidence, falsePositiveRatio);
  const byTechnique = countCallEdgesByTechnique(db, testFilter);

  return {
    score,
    callerCoverage: {
      ratio: callerCoverage,
      percentage: Math.round(callerCoverage * 100),
      covered: callableWithCallers,
      total: totalCallable,
      byTechnique: Object.keys(byTechnique).length > 0 ? byTechnique : undefined,
    },
    callConfidence: {
      ratio: callConfidence,
      highConf: highConfCallEdges,
      total: resolvedCallEdges,
    },
    falsePositiveWarnings,
  };
}

function countRoles(db: BetterSqlite3Database, noTests: boolean) {
  const testFilter = testFilterSQL('file', noTests);
  const roleRows = db
    .prepare(
      `SELECT role, COUNT(*) as c FROM nodes WHERE role IS NOT NULL ${testFilter} GROUP BY role`,
    )
    .all() as Array<{ role: string; c: number }>;
  const roles: Record<string, number> & { dead?: number } = {};
  let deadTotal = 0;
  for (const r of roleRows) {
    roles[r.role] = r.c;
    if (r.role.startsWith(DEAD_ROLE_PREFIX)) deadTotal += r.c;
  }
  if (deadTotal > 0) roles.dead = deadTotal;
  return roles;
}

function getComplexitySummary(db: BetterSqlite3Database, testFilter: string) {
  try {
    const cRows = db
      .prepare(
        `SELECT fc.cognitive, fc.cyclomatic, fc.max_nesting, fc.maintainability_index
         FROM function_complexity fc JOIN nodes n ON fc.node_id = n.id
         WHERE n.kind IN ('function','method') ${testFilter}`,
      )
      .all() as Array<{
      cognitive: number;
      cyclomatic: number;
      max_nesting: number;
      maintainability_index: number;
    }>;
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
  } catch (e: unknown) {
    debug(`complexity summary skipped: ${(e as Error).message}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function moduleMapData(customDbPath: string, limit = 20, opts: { noTests?: boolean } = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;

    const testFilter = testFilterSQL('n.file', noTests);

    const nodes = db
      .prepare(`
      SELECT n.file,
        COALESCE(fo.cnt, 0) as out_edges,
        COALESCE(fi.cnt, 0) as in_edges
      FROM nodes n
      LEFT JOIN (
        SELECT source_id, COUNT(*) AS cnt FROM edges
        WHERE kind NOT IN ('contains', 'parameter_of', 'receiver')
        GROUP BY source_id
      ) fo ON fo.source_id = n.id
      LEFT JOIN (
        SELECT target_id, COUNT(*) AS cnt FROM edges
        WHERE kind NOT IN ('contains', 'parameter_of', 'receiver')
        GROUP BY target_id
      ) fi ON fi.target_id = n.id
      WHERE n.kind = 'file'
        ${testFilter}
      ORDER BY COALESCE(fi.cnt, 0) DESC
      LIMIT ?
    `)
      .all(limit) as Array<{ file: string; in_edges: number; out_edges: number }>;

    const topNodes = nodes.map((n) => ({
      file: n.file,
      dir: path.dirname(n.file) || '.',
      inEdges: n.in_edges,
      outEdges: n.out_edges,
      coupling: n.in_edges + n.out_edges,
    }));

    const totalNodes =
      (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number } | undefined)?.c ?? 0;
    const totalEdges =
      (db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number } | undefined)?.c ?? 0;
    const totalFiles =
      (
        db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'file'").get() as
          | { c: number }
          | undefined
      )?.c ?? 0;

    return { limit, topNodes, stats: { totalFiles, totalNodes, totalEdges } };
  } finally {
    db.close();
  }
}

type FalsePositiveRow = { name: string; file: string; line: number; caller_count: number };

/** SQL query for false-positive caller counts above a threshold (shared by native and JS paths). */
function queryFalsePositiveRows(
  db: BetterSqlite3Database,
  fpThreshold: number,
): FalsePositiveRow[] {
  return db
    .prepare(`
      SELECT n.name, n.file, n.line, COUNT(e.source_id) as caller_count
      FROM nodes n
      LEFT JOIN edges e ON n.id = e.target_id AND e.kind = 'calls'
      WHERE n.kind IN ('function', 'method')
      GROUP BY n.id
      HAVING caller_count > ?
      ORDER BY caller_count DESC
    `)
    .all(fpThreshold) as FalsePositiveRow[];
}

/** Filter false-positive rows by the configured name set and shape them for the report. */
function buildFalsePositiveWarnings(rows: FalsePositiveRow[]) {
  return rows
    .filter((r) =>
      FALSE_POSITIVE_NAMES.has(r.name.includes('.') ? r.name.split('.').pop()! : r.name),
    )
    .map((r) => ({ name: r.name, file: r.file, line: r.line, callerCount: r.caller_count }));
}

/** Compute the composite quality score (0-100) from coverage, confidence, and FP ratio. */
function computeQualityScore(
  callerCoverage: number,
  callConfidence: number,
  falsePositiveRatio: number,
): number {
  return Math.round(callerCoverage * 40 + callConfidence * 40 + (1 - falsePositiveRatio) * 20);
}

/** Aggregate role counts and derive the `dead` total. */
function aggregateRolesFromNative(roleCounts: Array<{ role: string; count: number }>) {
  const roles: Record<string, number> & { dead?: number } = {};
  let deadTotal = 0;
  for (const r of roleCounts) {
    roles[r.role] = r.count;
    if (r.role.startsWith(DEAD_ROLE_PREFIX)) deadTotal += r.count;
  }
  if (deadTotal > 0) roles.dead = deadTotal;
  return roles;
}

type NativeGraphStatsFn = NonNullable<NativeDatabase['getGraphStats']>;
type NativeGraphStats = ReturnType<NativeGraphStatsFn>;

/** Build the native fast-path stats result by combining native aggregations with JS-only sections. */
function buildStatsFromNative(
  db: BetterSqlite3Database,
  nativeStats: NativeGraphStats,
  config: any,
  noTests: boolean,
  jsSections: {
    files: ReturnType<typeof countFilesByLanguage>;
    fileCycles: unknown[];
    fnCycles: unknown[];
  },
) {
  const s = nativeStats;
  const nodesByKind: Record<string, number> = {};
  for (const k of s.nodesByKind) nodesByKind[k.kind] = k.count;
  const edgesByKind: Record<string, number> = {};
  for (const k of s.edgesByKind) edgesByKind[k.kind] = k.count;
  const roles = aggregateRolesFromNative(s.roleCounts);

  const callerCoverage =
    s.quality.callableTotal > 0 ? s.quality.callableWithCallers / s.quality.callableTotal : 0;
  // s.quality.callEdges is now the resolved (confidence>0) edge count — sink
  // edges (confidence=0.0) are excluded so they don't dilute the ratio.
  const callConfidence =
    s.quality.callEdges > 0 ? s.quality.highConfCallEdges / s.quality.callEdges : 0;

  // False-positive analysis still uses JS (needs FALSE_POSITIVE_NAMES set).
  // FP ratio uses the *total* calls count (including sinks) as denominator so
  // it reflects the full edge set rather than just the resolved subset.
  const totalCallEdgesForFp = edgesByKind.calls ?? s.quality.callEdges;
  const fpThreshold = config.analysis?.falsePositiveCallers ?? FALSE_POSITIVE_CALLER_THRESHOLD;
  const falsePositiveWarnings = buildFalsePositiveWarnings(queryFalsePositiveRows(db, fpThreshold));
  let fpEdgeCount = 0;
  for (const fp of falsePositiveWarnings) fpEdgeCount += fp.callerCount;
  const falsePositiveRatio = totalCallEdgesForFp > 0 ? fpEdgeCount / totalCallEdgesForFp : 0;
  const score = computeQualityScore(callerCoverage, callConfidence, falsePositiveRatio);
  const testFilter = testFilterSQL('n.file', noTests);
  const byTechnique = countCallEdgesByTechnique(db, testFilter);

  return {
    nodes: { total: s.totalNodes, byKind: nodesByKind },
    edges: { total: s.totalEdges, byKind: edgesByKind },
    files: jsSections.files,
    cycles: { fileLevel: jsSections.fileCycles.length, functionLevel: jsSections.fnCycles.length },
    hotspots: s.hotspots.map((h) => ({ file: h.file, fanIn: h.fanIn, fanOut: h.fanOut })),
    embeddings: s.embeddings
      ? {
          count: s.embeddings.count,
          model: s.embeddings.model,
          dim: s.embeddings.dim,
          builtAt: s.embeddings.builtAt,
        }
      : null,
    quality: {
      score,
      callerCoverage: {
        ratio: callerCoverage,
        percentage: Math.round(callerCoverage * 100),
        covered: s.quality.callableWithCallers,
        total: s.quality.callableTotal,
        byTechnique: Object.keys(byTechnique).length > 0 ? byTechnique : undefined,
      },
      callConfidence: {
        ratio: callConfidence,
        highConf: s.quality.highConfCallEdges,
        total: s.quality.callEdges,
      },
      falsePositiveWarnings,
    },
    roles,
    complexity: s.complexity
      ? {
          analyzed: s.complexity.analyzed,
          avgCognitive: s.complexity.avgCognitive,
          avgCyclomatic: s.complexity.avgCyclomatic,
          maxCognitive: s.complexity.maxCognitive,
          maxCyclomatic: s.complexity.maxCyclomatic,
          avgMI: s.complexity.avgMi,
          minMI: s.complexity.minMi,
        }
      : null,
  };
}

/** Build the JS-fallback stats result using SQL aggregations from the helpers above. */
function buildStatsFromJs(
  db: BetterSqlite3Database,
  noTests: boolean,
  config: any,
  jsSections: {
    files: ReturnType<typeof countFilesByLanguage>;
    fileCycles: unknown[];
    fnCycles: unknown[];
  },
) {
  const testFilter = testFilterSQL('n.file', noTests);

  const { total: totalNodes, byKind: nodesByKind } = countNodesByKind(db, noTests);
  const { total: totalEdges, byKind: edgesByKind } = countEdgesByKind(db, noTests);

  const hotspots = findHotspots(db, noTests, 5);
  const embeddings = getEmbeddingsInfo(db);
  const fpThreshold = config.analysis?.falsePositiveCallers ?? FALSE_POSITIVE_CALLER_THRESHOLD;
  const quality = computeQualityMetrics(db, testFilter, fpThreshold);
  const roles = countRoles(db, noTests);
  const complexity = getComplexitySummary(db, testFilter);

  return {
    nodes: { total: totalNodes, byKind: nodesByKind },
    edges: { total: totalEdges, byKind: edgesByKind },
    files: jsSections.files,
    cycles: { fileLevel: jsSections.fileCycles.length, functionLevel: jsSections.fnCycles.length },
    hotspots,
    embeddings,
    quality,
    roles,
    complexity,
  };
}

export function statsData(customDbPath: string, opts: { noTests?: boolean; config?: any } = {}) {
  const { db, nativeDb, close } = openReadonlyWithNative(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const config = opts.config || loadConfig();

    // These always need JS (non-SQL logic)
    const jsSections = {
      files: countFilesByLanguage(db, noTests),
      fileCycles: findCycles(db, { fileLevel: true, noTests }),
      fnCycles: findCycles(db, { fileLevel: false, noTests }),
    };

    const nativeStats = nativeDb?.getGraphStats?.(noTests);
    return nativeStats
      ? buildStatsFromNative(db, nativeStats, config, noTests, jsSections)
      : buildStatsFromJs(db, noTests, config, jsSections);
  } finally {
    close();
  }
}
