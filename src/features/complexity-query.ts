/**
 * Complexity query functions — read-only DB queries for complexity metrics.
 *
 * Split from complexity.ts to separate query-time concerns (DB reads, filtering,
 * pagination) from compute-time concerns (AST traversal, metric algorithms).
 */

import { openReadonlyOrFail, resolveDbConfig } from '../db/index.js';
import { buildFileConditionSQL } from '../db/query-builder.js';
import { DEFAULTS } from '../infrastructure/config.js';
import { debug } from '../infrastructure/logger.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import { paginateResult } from '../shared/paginate.js';
import type { CodegraphConfig } from '../types.js';

// ─── Query-Time Functions ─────────────────────────────────────────────────

interface ComplexityRow {
  name: string;
  kind: string;
  file: string;
  line: number;
  end_line: number | null;
  cognitive: number;
  cyclomatic: number;
  max_nesting: number;
  loc: number;
  sloc: number;
  maintainability_index: number;
  halstead_volume: number;
  halstead_difficulty: number;
  halstead_effort: number;
  halstead_bugs: number;
}

const isValidThreshold = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Column-sort expressions for `codegraph complexity --sort <key>`. */
const ORDER_BY_MAP: Record<string, string> = {
  cognitive: 'fc.cognitive DESC',
  cyclomatic: 'fc.cyclomatic DESC',
  nesting: 'fc.max_nesting DESC',
  mi: 'fc.maintainability_index ASC',
  volume: 'fc.halstead_volume DESC',
  effort: 'fc.halstead_effort DESC',
  bugs: 'fc.halstead_bugs DESC',
  loc: 'fc.loc DESC',
};

interface ThresholdMetrics {
  cognitive: number;
  cyclomatic: number;
  max_nesting: number;
  maintainability_index: number;
}

/** Single source of truth for which metric names exceed which thresholds. */
const METRIC_THRESHOLD_CHECKS: Array<{
  name: string;
  exceeds: (r: ThresholdMetrics, thresholds: any) => boolean;
}> = [
  {
    name: 'cognitive',
    exceeds: (r, t) =>
      isValidThreshold(t.cognitive?.warn) && r.cognitive >= (t.cognitive?.warn ?? 0),
  },
  {
    name: 'cyclomatic',
    exceeds: (r, t) =>
      isValidThreshold(t.cyclomatic?.warn) && r.cyclomatic >= (t.cyclomatic?.warn ?? 0),
  },
  {
    name: 'maxNesting',
    exceeds: (r, t) =>
      isValidThreshold(t.maxNesting?.warn) && r.max_nesting >= (t.maxNesting?.warn ?? 0),
  },
  {
    name: 'maintainabilityIndex',
    exceeds: (r, t) =>
      isValidThreshold(t.maintainabilityIndex?.warn) &&
      r.maintainability_index > 0 &&
      r.maintainability_index <= (t.maintainabilityIndex?.warn ?? 0),
  },
];

/** List of metric names a row exceeds (empty if none). */
function getExceededMetrics(r: ThresholdMetrics, thresholds: any): string[] {
  return METRIC_THRESHOLD_CHECKS.filter((check) => check.exceeds(r, thresholds)).map(
    (check) => check.name,
  );
}

/** Build WHERE clause and params for complexity query filtering. */
function buildComplexityWhere(opts: {
  noTests: boolean;
  target: string | null;
  fileFilter: string | null;
  kindFilter: string | null;
}): { where: string; params: unknown[] } {
  let where = "WHERE n.kind IN ('function','method')";
  const params: unknown[] = [];

  if (opts.noTests) {
    where += ` AND n.file NOT LIKE '%.test.%'
       AND n.file NOT LIKE '%.spec.%'
       AND n.file NOT LIKE '%__test__%'
       AND n.file NOT LIKE '%__tests__%'
       AND n.file NOT LIKE '%.stories.%'`;
  }
  if (opts.target) {
    where += ' AND n.name LIKE ?';
    params.push(`%${opts.target}%`);
  }
  {
    const fc = buildFileConditionSQL(opts.fileFilter as string, 'n.file');
    where += fc.sql;
    params.push(...fc.params);
  }
  if (opts.kindFilter) {
    where += ' AND n.kind = ?';
    params.push(opts.kindFilter);
  }
  return { where, params };
}

/** Build HAVING clause for above-threshold filtering. */
function buildThresholdHaving(thresholds: any): string {
  const conditions: string[] = [];
  if (isValidThreshold(thresholds.cognitive?.warn)) {
    conditions.push(`fc.cognitive >= ${thresholds.cognitive.warn}`);
  }
  if (isValidThreshold(thresholds.cyclomatic?.warn)) {
    conditions.push(`fc.cyclomatic >= ${thresholds.cyclomatic.warn}`);
  }
  if (isValidThreshold(thresholds.maxNesting?.warn)) {
    conditions.push(`fc.max_nesting >= ${thresholds.maxNesting.warn}`);
  }
  if (isValidThreshold(thresholds.maintainabilityIndex?.warn)) {
    conditions.push(
      `fc.maintainability_index > 0 AND fc.maintainability_index <= ${thresholds.maintainabilityIndex.warn}`,
    );
  }
  return conditions.length > 0 ? `AND (${conditions.join(' OR ')})` : '';
}

/** Map a raw DB row to the public complexity result shape. */
function mapComplexityRow(r: ComplexityRow, thresholds: any): Record<string, unknown> {
  const exceeds = getExceededMetrics(r, thresholds);

  return {
    name: r.name,
    kind: r.kind,
    file: r.file,
    line: r.line,
    endLine: r.end_line || null,
    cognitive: r.cognitive,
    cyclomatic: r.cyclomatic,
    maxNesting: r.max_nesting,
    loc: r.loc || 0,
    sloc: r.sloc || 0,
    maintainabilityIndex: r.maintainability_index || 0,
    halstead: {
      volume: r.halstead_volume || 0,
      difficulty: r.halstead_difficulty || 0,
      effort: r.halstead_effort || 0,
      bugs: r.halstead_bugs || 0,
    },
    exceeds: exceeds.length > 0 ? exceeds : undefined,
  };
}

/** Check whether a row exceeds any threshold (for summary counting). */
function exceedsAnyThreshold(r: ThresholdMetrics, thresholds: any): boolean {
  return getExceededMetrics(r, thresholds).length > 0;
}

/** Fetch the bare metric columns for rows matching `where`/`params`, used to compute summary statistics. */
function fetchAllComplexityMetrics(
  db: ReturnType<typeof openReadonlyOrFail>,
  where: string,
  params: unknown[],
): ThresholdMetrics[] {
  return db
    .prepare<ThresholdMetrics>(
      `SELECT fc.cognitive, fc.cyclomatic, fc.max_nesting, fc.maintainability_index
       FROM function_complexity fc JOIN nodes n ON fc.node_id = n.id
       ${where}`,
    )
    .all(...params);
}

/** Arithmetic mean, rounded to 1 decimal (matches the summary's existing precision). */
function average(values: number[]): number {
  return +(values.reduce((s, v) => s + v, 0) / values.length).toFixed(1);
}

/** Reduce a set of complexity rows down to the public summary-statistics shape. */
function summarizeComplexityMetrics(
  allRows: ThresholdMetrics[],
  thresholds: any,
): Record<string, unknown> {
  const cognitiveValues = allRows.map((r) => r.cognitive);
  const cyclomaticValues = allRows.map((r) => r.cyclomatic);
  const miValues = allRows.map((r) => r.maintainability_index || 0);
  return {
    analyzed: allRows.length,
    avgCognitive: average(cognitiveValues),
    avgCyclomatic: average(cyclomaticValues),
    maxCognitive: Math.max(...cognitiveValues),
    maxCyclomatic: Math.max(...cyclomaticValues),
    avgMI: average(miValues),
    minMI: +Math.min(...miValues).toFixed(1),
    aboveWarn: allRows.filter((r) => exceedsAnyThreshold(r, thresholds)).length,
  };
}

/** Compute summary statistics across the complexity rows matching `where`/`params`. */
function computeComplexitySummary(
  db: ReturnType<typeof openReadonlyOrFail>,
  where: string,
  params: unknown[],
  thresholds: any,
): Record<string, unknown> | null {
  try {
    const allRows = fetchAllComplexityMetrics(db, where, params);
    if (allRows.length === 0) return null;
    return summarizeComplexityMetrics(allRows, thresholds);
  } catch (e: unknown) {
    debug(`complexity summary query failed: ${(e as Error).message}`);
    return null;
  }
}

/** Check if graph has nodes (used when complexity table is missing). */
function checkHasGraph(db: ReturnType<typeof openReadonlyOrFail>): boolean {
  try {
    return (db.prepare<{ c: number }>('SELECT COUNT(*) as c FROM nodes').get()?.c ?? 0) > 0;
  } catch (e: unknown) {
    debug(`nodes table check failed: ${(e as Error).message}`);
    return false;
  }
}

/** Run the main complexity rows query; returns null if the table doesn't exist yet. */
function queryComplexityRows(
  db: ReturnType<typeof openReadonlyOrFail>,
  where: string,
  having: string,
  orderBy: string,
  params: unknown[],
): ComplexityRow[] | null {
  try {
    return db
      .prepare<ComplexityRow>(
        `SELECT n.name, n.kind, n.file, n.line, n.end_line,
              fc.cognitive, fc.cyclomatic, fc.max_nesting,
              fc.loc, fc.sloc, fc.maintainability_index,
              fc.halstead_volume, fc.halstead_difficulty, fc.halstead_effort, fc.halstead_bugs
       FROM function_complexity fc
       JOIN nodes n ON fc.node_id = n.id
       ${where} ${having}
       ORDER BY ${orderBy}`,
      )
      .all(...params);
  } catch (e: unknown) {
    debug(`complexity query failed (table may not exist): ${(e as Error).message}`);
    return null;
  }
}

interface ComplexityQueryOpts {
  target?: string;
  limit?: number;
  sort?: string;
  aboveThreshold?: boolean;
  file?: string;
  kind?: string;
  noTests?: boolean;
  config?: CodegraphConfig;
  offset?: number;
}

/** Resolve query flags + effective manifesto thresholds from opts/config/DEFAULTS. */
function resolveComplexityQueryOptions(
  customDbPath: string | undefined,
  opts: ComplexityQueryOpts,
): {
  sort: string;
  noTests: boolean;
  aboveThreshold: boolean;
  thresholds: any;
  busyTimeoutMs: number;
} {
  // Derive rootDir from customDbPath (not process.cwd()) so `--db /other/repo/...`
  // reads that repo's .codegraphrc.json (issue #1881).
  const config = opts.config || resolveDbConfig(customDbPath);
  return {
    sort: opts.sort || 'cognitive',
    noTests: opts.noTests || false,
    aboveThreshold: opts.aboveThreshold || false,
    thresholds: config.manifesto?.rules || DEFAULTS.manifesto.rules,
    busyTimeoutMs: config.db?.busyTimeoutMs ?? DEFAULTS.db.busyTimeoutMs,
  };
}

/** Run the query + summary and shape the pre-pagination result object. */
function buildComplexityResult(
  db: ReturnType<typeof openReadonlyOrFail>,
  sql: { where: string; having: string; orderBy: string; params: unknown[] },
  noTests: boolean,
  thresholds: any,
): Record<string, unknown> {
  const rows = queryComplexityRows(db, sql.where, sql.having, sql.orderBy, sql.params);
  if (rows === null) {
    return { functions: [], summary: null, thresholds, hasGraph: checkHasGraph(db) };
  }

  const filtered = noTests ? rows.filter((r) => !isTestFile(r.file)) : rows;
  const functions = filtered.map((r) => mapComplexityRow(r, thresholds));

  // Summary is scoped by the same file/target/kind/noTests `where` as `functions`,
  // but deliberately excludes the above-threshold `having` clause so stats like
  // `aboveWarn` remain meaningful against the full in-scope population.
  const summary = computeComplexitySummary(db, sql.where, sql.params, thresholds);
  const hasGraph = summary === null ? checkHasGraph(db) : false;

  return { functions, summary, thresholds, hasGraph };
}

export function complexityData(
  customDbPath?: string,
  opts: ComplexityQueryOpts = {},
): Record<string, unknown> {
  // Resolve config (and thus busyTimeoutMs) before opening the DB — mirrors
  // resolveDbSettings()'s ordering in db/connection.ts, since loadConfig can
  // throw and an already-open handle at that point would never be closed.
  const { sort, noTests, aboveThreshold, thresholds, busyTimeoutMs } =
    resolveComplexityQueryOptions(customDbPath, opts);
  const db = openReadonlyOrFail(customDbPath, busyTimeoutMs);
  try {
    const { where, params } = buildComplexityWhere({
      noTests,
      target: opts.target || null,
      fileFilter: opts.file || null,
      kindFilter: opts.kind || null,
    });

    const having = aboveThreshold ? buildThresholdHaving(thresholds) : '';
    const orderBy = ORDER_BY_MAP[sort] || 'fc.cognitive DESC';

    const base = buildComplexityResult(db, { where, having, orderBy, params }, noTests, thresholds);
    return paginateResult(base, 'functions', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}
