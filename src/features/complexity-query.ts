/**
 * Complexity query functions — read-only DB queries for complexity metrics.
 *
 * Split from complexity.ts to separate query-time concerns (DB reads, filtering,
 * pagination) from compute-time concerns (AST traversal, metric algorithms).
 */

import { openReadonlyOrFail } from '../db/index.js';
import { buildFileConditionSQL } from '../db/query-builder.js';
import { loadConfig } from '../infrastructure/config.js';
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

export function complexityData(
  customDbPath?: string,
  opts: {
    target?: string;
    limit?: number;
    sort?: string;
    aboveThreshold?: boolean;
    file?: string;
    kind?: string;
    noTests?: boolean;
    config?: CodegraphConfig;
    offset?: number;
  } = {},
): Record<string, unknown> {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const sort = opts.sort || 'cognitive';
    const noTests = opts.noTests || false;
    const aboveThreshold = opts.aboveThreshold || false;
    const target = opts.target || null;
    const fileFilter = opts.file || null;
    const kindFilter = opts.kind || null;

    // Load thresholds from config
    const config = opts.config || loadConfig(process.cwd());
    // biome-ignore lint/suspicious/noExplicitAny: thresholds come from config with dynamic keys
    const thresholds: any = config.manifesto?.rules || {
      cognitive: { warn: 15, fail: null },
      cyclomatic: { warn: 10, fail: null },
      maxNesting: { warn: 4, fail: null },
      maintainabilityIndex: { warn: 20, fail: null },
    };

    // Build query
    let where = "WHERE n.kind IN ('function','method')";
    const params: unknown[] = [];

    if (noTests) {
      where += ` AND n.file NOT LIKE '%.test.%'
       AND n.file NOT LIKE '%.spec.%'
       AND n.file NOT LIKE '%__test__%'
       AND n.file NOT LIKE '%__tests__%'
       AND n.file NOT LIKE '%.stories.%'`;
    }
    if (target) {
      where += ' AND n.name LIKE ?';
      params.push(`%${target}%`);
    }
    {
      const fc = buildFileConditionSQL(fileFilter as string, 'n.file');
      where += fc.sql;
      params.push(...fc.params);
    }
    if (kindFilter) {
      where += ' AND n.kind = ?';
      params.push(kindFilter);
    }

    const isValidThreshold = (v: unknown): v is number =>
      typeof v === 'number' && Number.isFinite(v);

    let having = '';
    if (aboveThreshold) {
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
      if (conditions.length > 0) {
        having = `AND (${conditions.join(' OR ')})`;
      }
    }

    const orderMap: Record<string, string> = {
      cognitive: 'fc.cognitive DESC',
      cyclomatic: 'fc.cyclomatic DESC',
      nesting: 'fc.max_nesting DESC',
      mi: 'fc.maintainability_index ASC',
      volume: 'fc.halstead_volume DESC',
      effort: 'fc.halstead_effort DESC',
      bugs: 'fc.halstead_bugs DESC',
      loc: 'fc.loc DESC',
    };
    const orderBy = orderMap[sort] || 'fc.cognitive DESC';

    let rows: ComplexityRow[];
    try {
      rows = db
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
      // Check if graph has nodes even though complexity table is missing/empty
      let hasGraph = false;
      try {
        hasGraph = (db.prepare<{ c: number }>('SELECT COUNT(*) as c FROM nodes').get()?.c ?? 0) > 0;
      } catch (e2: unknown) {
        debug(`nodes table check failed: ${(e2 as Error).message}`);
      }
      return { functions: [], summary: null, thresholds, hasGraph };
    }

    // Post-filter test files if needed (belt-and-suspenders for isTestFile)
    const filtered = noTests ? rows.filter((r) => !isTestFile(r.file)) : rows;

    const functions = filtered.map((r) => {
      const exceeds: string[] = [];
      if (
        isValidThreshold(thresholds.cognitive?.warn) &&
        r.cognitive >= (thresholds.cognitive?.warn ?? 0)
      )
        exceeds.push('cognitive');
      if (
        isValidThreshold(thresholds.cyclomatic?.warn) &&
        r.cyclomatic >= (thresholds.cyclomatic?.warn ?? 0)
      )
        exceeds.push('cyclomatic');
      if (
        isValidThreshold(thresholds.maxNesting?.warn) &&
        r.max_nesting >= (thresholds.maxNesting?.warn ?? 0)
      )
        exceeds.push('maxNesting');
      if (
        isValidThreshold(thresholds.maintainabilityIndex?.warn) &&
        r.maintainability_index > 0 &&
        r.maintainability_index <= (thresholds.maintainabilityIndex?.warn ?? 0)
      )
        exceeds.push('maintainabilityIndex');

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
    });

    // Summary stats
    let summary: Record<string, unknown> | null = null;
    try {
      const allRows = db
        .prepare<{
          cognitive: number;
          cyclomatic: number;
          max_nesting: number;
          maintainability_index: number;
        }>(
          `SELECT fc.cognitive, fc.cyclomatic, fc.max_nesting, fc.maintainability_index
         FROM function_complexity fc JOIN nodes n ON fc.node_id = n.id
         WHERE n.kind IN ('function','method')
         ${noTests ? `AND n.file NOT LIKE '%.test.%' AND n.file NOT LIKE '%.spec.%' AND n.file NOT LIKE '%__test__%' AND n.file NOT LIKE '%__tests__%' AND n.file NOT LIKE '%.stories.%'` : ''}`,
        )
        .all();

      if (allRows.length > 0) {
        const miValues = allRows.map((r) => r.maintainability_index || 0);
        summary = {
          analyzed: allRows.length,
          avgCognitive: +(allRows.reduce((s, r) => s + r.cognitive, 0) / allRows.length).toFixed(1),
          avgCyclomatic: +(allRows.reduce((s, r) => s + r.cyclomatic, 0) / allRows.length).toFixed(
            1,
          ),
          maxCognitive: Math.max(...allRows.map((r) => r.cognitive)),
          maxCyclomatic: Math.max(...allRows.map((r) => r.cyclomatic)),
          avgMI: +(miValues.reduce((s, v) => s + v, 0) / miValues.length).toFixed(1),
          minMI: +Math.min(...miValues).toFixed(1),
          aboveWarn: allRows.filter(
            (r) =>
              (isValidThreshold(thresholds.cognitive?.warn) &&
                r.cognitive >= (thresholds.cognitive?.warn ?? 0)) ||
              (isValidThreshold(thresholds.cyclomatic?.warn) &&
                r.cyclomatic >= (thresholds.cyclomatic?.warn ?? 0)) ||
              (isValidThreshold(thresholds.maxNesting?.warn) &&
                r.max_nesting >= (thresholds.maxNesting?.warn ?? 0)) ||
              (isValidThreshold(thresholds.maintainabilityIndex?.warn) &&
                r.maintainability_index > 0 &&
                r.maintainability_index <= (thresholds.maintainabilityIndex?.warn ?? 0)),
          ).length,
        };
      }
    } catch (e: unknown) {
      debug(`complexity summary query failed: ${(e as Error).message}`);
    }

    // When summary is null (no complexity rows), check if graph has nodes
    let hasGraph = false;
    if (summary === null) {
      try {
        hasGraph = (db.prepare<{ c: number }>('SELECT COUNT(*) as c FROM nodes').get()?.c ?? 0) > 0;
      } catch (e: unknown) {
        debug(`nodes table check failed: ${(e as Error).message}`);
      }
    }

    const base = { functions, summary, thresholds, hasGraph };
    return paginateResult(base, 'functions', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

interface IterComplexityRow {
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
}

export function* iterComplexity(
  customDbPath?: string,
  opts: {
    noTests?: boolean;
    file?: string;
    target?: string;
    kind?: string;
    sort?: string;
  } = {},
): Generator<{
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine: number | null;
  cognitive: number;
  cyclomatic: number;
  maxNesting: number;
  loc: number;
  sloc: number;
}> {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const sort = opts.sort || 'cognitive';

    let where = "WHERE n.kind IN ('function','method')";
    const params: unknown[] = [];

    if (noTests) {
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
      const fc = buildFileConditionSQL(opts.file as string, 'n.file');
      where += fc.sql;
      params.push(...fc.params);
    }
    if (opts.kind) {
      where += ' AND n.kind = ?';
      params.push(opts.kind);
    }

    const orderMap: Record<string, string> = {
      cognitive: 'fc.cognitive DESC',
      cyclomatic: 'fc.cyclomatic DESC',
      nesting: 'fc.max_nesting DESC',
      mi: 'fc.maintainability_index ASC',
      volume: 'fc.halstead_volume DESC',
      effort: 'fc.halstead_effort DESC',
      bugs: 'fc.halstead_bugs DESC',
      loc: 'fc.loc DESC',
    };
    const orderBy = orderMap[sort] || 'fc.cognitive DESC';

    const stmt = db.prepare<IterComplexityRow>(
      `SELECT n.name, n.kind, n.file, n.line, n.end_line,
              fc.cognitive, fc.cyclomatic, fc.max_nesting, fc.loc, fc.sloc
       FROM function_complexity fc
       JOIN nodes n ON fc.node_id = n.id
       ${where}
       ORDER BY ${orderBy}`,
    );
    for (const r of stmt.iterate(...params)) {
      if (noTests && isTestFile(r.file)) continue;
      yield {
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
      };
    }
  } finally {
    db.close();
  }
}
