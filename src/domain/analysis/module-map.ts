import path from 'node:path';
import { openReadonlyOrFail, openReadonlyWithNative, testFilterSQL } from '../../db/index.js';
import { loadConfig } from '../../infrastructure/config.js';
import { debug } from '../../infrastructure/logger.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import { DEAD_ROLE_PREFIX } from '../../shared/kinds.js';
import type { BetterSqlite3Database } from '../../types.js';
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
        SELECT target_id, COUNT(*) AS cnt FROM edges GROUP BY target_id
      ) fi ON fi.target_id = n.id
      LEFT JOIN (
        SELECT source_id, COUNT(*) AS cnt FROM edges GROUP BY source_id
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
  const highConfCallEdges = (
    db
      .prepare("SELECT COUNT(*) as c FROM edges WHERE kind = 'calls' AND confidence >= 0.7")
      .get() as { c: number }
  ).c;
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
    .all(fpThreshold) as Array<{ name: string; file: string; line: number; caller_count: number }>;
  const falsePositiveWarnings = fpRows
    .filter((r) =>
      FALSE_POSITIVE_NAMES.has(r.name.includes('.') ? r.name.split('.').pop()! : r.name),
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

export function statsData(customDbPath: string, opts: { noTests?: boolean; config?: any } = {}) {
  const { db, nativeDb, close } = openReadonlyWithNative(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const config = opts.config || loadConfig();

    // These always need JS (non-SQL logic)
    const files = countFilesByLanguage(db, noTests);
    const fileCycles = findCycles(db, { fileLevel: true, noTests });
    const fnCycles = findCycles(db, { fileLevel: false, noTests });

    // ── Native fast path: batch all SQL aggregations in one napi call ──
    if (nativeDb?.getGraphStats) {
      const s = nativeDb.getGraphStats(noTests);
      const nodesByKind: Record<string, number> = {};
      for (const k of s.nodesByKind) nodesByKind[k.kind] = k.count;
      const edgesByKind: Record<string, number> = {};
      for (const k of s.edgesByKind) edgesByKind[k.kind] = k.count;
      const roles: Record<string, number> & { dead?: number } = {};
      let deadTotal = 0;
      for (const r of s.roleCounts) {
        roles[r.role] = r.count;
        if (r.role.startsWith(DEAD_ROLE_PREFIX)) deadTotal += r.count;
      }
      if (deadTotal > 0) roles.dead = deadTotal;

      const callerCoverage =
        s.quality.callableTotal > 0 ? s.quality.callableWithCallers / s.quality.callableTotal : 0;
      const callConfidence =
        s.quality.callEdges > 0 ? s.quality.highConfCallEdges / s.quality.callEdges : 0;

      // False-positive analysis still uses JS (needs FALSE_POSITIVE_NAMES set)
      const fpThreshold = config.analysis?.falsePositiveCallers ?? FALSE_POSITIVE_CALLER_THRESHOLD;
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
        .all(fpThreshold) as Array<{
        name: string;
        file: string;
        line: number;
        caller_count: number;
      }>;
      const falsePositiveWarnings = fpRows
        .filter((r) =>
          FALSE_POSITIVE_NAMES.has(r.name.includes('.') ? r.name.split('.').pop()! : r.name),
        )
        .map((r) => ({ name: r.name, file: r.file, line: r.line, callerCount: r.caller_count }));
      let fpEdgeCount = 0;
      for (const fp of falsePositiveWarnings) fpEdgeCount += fp.callerCount;
      const falsePositiveRatio = s.quality.callEdges > 0 ? fpEdgeCount / s.quality.callEdges : 0;
      const score = Math.round(
        callerCoverage * 40 + callConfidence * 40 + (1 - falsePositiveRatio) * 20,
      );

      return {
        nodes: { total: s.totalNodes, byKind: nodesByKind },
        edges: { total: s.totalEdges, byKind: edgesByKind },
        files,
        cycles: { fileLevel: fileCycles.length, functionLevel: fnCycles.length },
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
            covered: s.quality.callableWithCallers,
            total: s.quality.callableTotal,
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

    // ── JS fallback ───────────────────────────────────────────────────
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
      files,
      cycles: { fileLevel: fileCycles.length, functionLevel: fnCycles.length },
      hotspots,
      embeddings,
      quality,
      roles,
      complexity,
    };
  } finally {
    close();
  }
}
