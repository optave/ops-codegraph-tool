import { openReadonlyOrFail } from '../db/index.js';
import { buildFileConditionSQL } from '../db/query-builder.js';
import { findCycles } from '../domain/graph/cycles.js';
import { loadConfig } from '../infrastructure/config.js';
import { debug } from '../infrastructure/logger.js';
import { paginateResult } from '../shared/paginate.js';
import type { BetterSqlite3Database, CodegraphConfig, ThresholdRule } from '../types.js';
import { evaluateBoundaries } from './boundaries.js';

// ─── Rule Definitions ─────────────────────────────────────────────────

interface RuleDef {
  name: string;
  level: 'function' | 'file' | 'graph';
  metric: string;
  defaults: { warn: number | null; fail: number | null };
  reportOnly?: boolean;
}

export const RULE_DEFS: RuleDef[] = [
  {
    name: 'cognitive',
    level: 'function',
    metric: 'cognitive',
    defaults: { warn: 15, fail: null },
    reportOnly: true,
  },
  {
    name: 'cyclomatic',
    level: 'function',
    metric: 'cyclomatic',
    defaults: { warn: 10, fail: null },
    reportOnly: true,
  },
  {
    name: 'maxNesting',
    level: 'function',
    metric: 'max_nesting',
    defaults: { warn: 4, fail: null },
    reportOnly: true,
  },
  {
    name: 'importCount',
    level: 'file',
    metric: 'import_count',
    defaults: { warn: null, fail: null },
  },
  {
    name: 'exportCount',
    level: 'file',
    metric: 'export_count',
    defaults: { warn: null, fail: null },
  },
  {
    name: 'lineCount',
    level: 'file',
    metric: 'line_count',
    defaults: { warn: null, fail: null },
  },
  { name: 'fanIn', level: 'file', metric: 'fan_in', defaults: { warn: null, fail: null } },
  { name: 'fanOut', level: 'file', metric: 'fan_out', defaults: { warn: null, fail: null } },
  { name: 'noCycles', level: 'graph', metric: 'noCycles', defaults: { warn: null, fail: null } },
  {
    name: 'boundaries',
    level: 'graph',
    metric: 'boundaries',
    defaults: { warn: null, fail: null },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────

const NO_TEST_SQL = `
  AND n.file NOT LIKE '%.test.%'
  AND n.file NOT LIKE '%.spec.%'
  AND n.file NOT LIKE '%__test__%'
  AND n.file NOT LIKE '%__tests__%'
  AND n.file NOT LIKE '%.stories.%'`;

interface ResolvedRules {
  [name: string]: ThresholdRule;
}

function resolveRules(userRules?: Record<string, Partial<ThresholdRule>>): ResolvedRules {
  const resolved: ResolvedRules = {};
  for (const def of RULE_DEFS) {
    const user = userRules?.[def.name];
    resolved[def.name] = {
      warn: user?.warn !== undefined ? user.warn : def.defaults.warn,
      fail: def.reportOnly ? null : user?.fail !== undefined ? user.fail : def.defaults.fail,
    };
  }
  return resolved;
}

function isEnabled(thresholds: ThresholdRule): boolean {
  return thresholds.warn != null || thresholds.fail != null;
}

interface Violation {
  rule: string;
  level: string;
  value: number;
  threshold: number;
  name?: string;
  file?: string;
  line?: number | null;
}

function checkThreshold(
  rule: string,
  thresholds: ThresholdRule,
  value: number,
  meta: { name?: string; file?: string; line?: number | null },
  violations: Violation[],
): 'fail' | 'warn' | 'pass' {
  if (thresholds.fail != null && value >= thresholds.fail) {
    violations.push({
      rule,
      level: 'fail',
      value,
      threshold: thresholds.fail,
      ...meta,
    });
    return 'fail';
  }
  if (thresholds.warn != null && value >= thresholds.warn) {
    violations.push({
      rule,
      level: 'warn',
      value,
      threshold: thresholds.warn,
      ...meta,
    });
    return 'warn';
  }
  return 'pass';
}

// ─── Evaluators ───────────────────────────────────────────────────────

interface RuleResult {
  name: string;
  level: string;
  status: string;
  thresholds: ThresholdRule;
  violationCount: number;
}

interface ManifestoOpts {
  noTests?: boolean;
  file?: string;
  kind?: string;
  config?: CodegraphConfig;
  limit?: number;
  offset?: number;
}

function evaluateFunctionRules(
  db: BetterSqlite3Database,
  rules: ResolvedRules,
  opts: ManifestoOpts,
  violations: Violation[],
  ruleResults: RuleResult[],
): void {
  const functionDefs = RULE_DEFS.filter((d) => d.level === 'function');
  const activeDefs = functionDefs.filter((d) => isEnabled(rules[d.name]!));
  if (activeDefs.length === 0) {
    for (const def of functionDefs) {
      ruleResults.push({
        name: def.name,
        level: def.level,
        status: 'pass',
        thresholds: rules[def.name]!,
        violationCount: 0,
      });
    }
    return;
  }

  let where = "WHERE n.kind IN ('function','method')";
  const params: unknown[] = [];
  if (opts.noTests) where += NO_TEST_SQL;
  {
    const fc = buildFileConditionSQL(opts.file as string, 'n.file');
    where += fc.sql;
    params.push(...fc.params);
  }
  if (opts.kind) {
    where += ' AND n.kind = ?';
    params.push(opts.kind);
  }

  let rows: Array<Record<string, unknown>>;
  try {
    rows = db
      .prepare(
        `SELECT n.name, n.kind, n.file, n.line,
                fc.cognitive, fc.cyclomatic, fc.max_nesting
         FROM function_complexity fc
         JOIN nodes n ON fc.node_id = n.id
         ${where}`,
      )
      .all(...params) as Array<Record<string, unknown>>;
  } catch (err: unknown) {
    debug(`manifesto function query failed: ${(err as Error).message}`);
    rows = [];
  }

  // Track worst status per rule
  const worst: Record<string, string> = {};
  const counts: Record<string, number> = {};
  for (const def of functionDefs) {
    worst[def.name] = 'pass';
    counts[def.name] = 0;
  }

  for (const row of rows) {
    for (const def of activeDefs) {
      const value = row[def.metric] as number | null;
      if (value == null) continue;
      const meta = {
        name: row.name as string,
        file: row.file as string,
        line: row.line as number,
      };
      const status = checkThreshold(def.name, rules[def.name]!, value, meta, violations);
      if (status !== 'pass') {
        counts[def.name] = (counts[def.name] ?? 0) + 1;
        if (status === 'fail') worst[def.name] = 'fail';
        else if (worst[def.name] !== 'fail') worst[def.name] = 'warn';
      }
    }
  }

  for (const def of functionDefs) {
    ruleResults.push({
      name: def.name,
      level: def.level,
      status: worst[def.name]!,
      thresholds: rules[def.name]!,
      violationCount: counts[def.name] ?? 0,
    });
  }
}

function evaluateFileRules(
  db: BetterSqlite3Database,
  rules: ResolvedRules,
  opts: ManifestoOpts,
  violations: Violation[],
  ruleResults: RuleResult[],
): void {
  const fileDefs = RULE_DEFS.filter((d) => d.level === 'file');
  const activeDefs = fileDefs.filter((d) => isEnabled(rules[d.name]!));
  if (activeDefs.length === 0) {
    for (const def of fileDefs) {
      ruleResults.push({
        name: def.name,
        level: def.level,
        status: 'pass',
        thresholds: rules[def.name]!,
        violationCount: 0,
      });
    }
    return;
  }

  let where = "WHERE n.kind = 'file'";
  const params: unknown[] = [];
  if (opts.noTests) where += NO_TEST_SQL;
  {
    const fc = buildFileConditionSQL(opts.file as string, 'n.file');
    where += fc.sql;
    params.push(...fc.params);
  }

  let rows: Array<Record<string, unknown>>;
  try {
    rows = db
      .prepare(
        `SELECT n.name, n.file, n.line,
                nm.import_count, nm.export_count, nm.line_count,
                nm.fan_in, nm.fan_out
         FROM node_metrics nm
         JOIN nodes n ON nm.node_id = n.id
         ${where}`,
      )
      .all(...params) as Array<Record<string, unknown>>;
  } catch (err: unknown) {
    debug(`manifesto file query failed: ${(err as Error).message}`);
    rows = [];
  }

  const worst: Record<string, string> = {};
  const counts: Record<string, number> = {};
  for (const def of fileDefs) {
    worst[def.name] = 'pass';
    counts[def.name] = 0;
  }

  for (const row of rows) {
    for (const def of activeDefs) {
      const value = row[def.metric] as number | null;
      if (value == null) continue;
      const meta = {
        name: row.name as string,
        file: row.file as string,
        line: row.line as number,
      };
      const status = checkThreshold(def.name, rules[def.name]!, value, meta, violations);
      if (status !== 'pass') {
        counts[def.name] = (counts[def.name] ?? 0) + 1;
        if (status === 'fail') worst[def.name] = 'fail';
        else if (worst[def.name] !== 'fail') worst[def.name] = 'warn';
      }
    }
  }

  for (const def of fileDefs) {
    ruleResults.push({
      name: def.name,
      level: def.level,
      status: worst[def.name]!,
      thresholds: rules[def.name]!,
      violationCount: counts[def.name] ?? 0,
    });
  }
}

function evaluateGraphRules(
  db: BetterSqlite3Database,
  rules: ResolvedRules,
  opts: ManifestoOpts,
  violations: Violation[],
  ruleResults: RuleResult[],
): void {
  const thresholds = rules.noCycles!;
  if (!isEnabled(thresholds)) {
    ruleResults.push({
      name: 'noCycles',
      level: 'graph',
      status: 'pass',
      thresholds,
      violationCount: 0,
    });
    return;
  }

  const cycles = findCycles(db, { fileLevel: true, noTests: opts.noTests || false });
  const hasCycles = cycles.length > 0;

  if (!hasCycles) {
    ruleResults.push({
      name: 'noCycles',
      level: 'graph',
      status: 'pass',
      thresholds,
      violationCount: 0,
    });
    return;
  }

  // Determine level: fail takes precedence over warn
  const level = thresholds.fail != null ? 'fail' : 'warn';

  for (const cycle of cycles) {
    violations.push({
      rule: 'noCycles',
      level,
      name: `cycle(${cycle.length} files)`,
      file: cycle.join(' → '),
      line: null,
      value: cycle.length,
      threshold: 0,
    });
  }

  ruleResults.push({
    name: 'noCycles',
    level: 'graph',
    status: level,
    thresholds,
    violationCount: cycles.length,
  });
}

function evaluateBoundaryRules(
  db: BetterSqlite3Database,
  rules: ResolvedRules,
  config: CodegraphConfig,
  opts: ManifestoOpts,
  violations: Violation[],
  ruleResults: RuleResult[],
): void {
  const thresholds = rules.boundaries!;
  const boundaryConfig = config.manifesto?.boundaries;

  // Auto-enable at warn level when boundary config exists but threshold not set
  const effectiveThresholds: ThresholdRule = {
    warn: thresholds.warn ?? null,
    fail: thresholds.fail ?? null,
  };
  if (boundaryConfig && !isEnabled(thresholds)) {
    effectiveThresholds.warn = true as unknown as number;
  }

  if (!isEnabled(effectiveThresholds) || !boundaryConfig) {
    ruleResults.push({
      name: 'boundaries',
      level: 'graph',
      status: 'pass',
      thresholds: effectiveThresholds,
      violationCount: 0,
    });
    return;
  }

  const result = evaluateBoundaries(db, boundaryConfig, { noTests: opts.noTests || false });
  const hasBoundaryViolations = result.violationCount > 0;

  if (!hasBoundaryViolations) {
    ruleResults.push({
      name: 'boundaries',
      level: 'graph',
      status: 'pass',
      thresholds: effectiveThresholds,
      violationCount: 0,
    });
    return;
  }

  const level = effectiveThresholds.fail != null ? 'fail' : 'warn';

  for (const v of result.violations) {
    violations.push({
      ...v,
      level,
    });
  }

  ruleResults.push({
    name: 'boundaries',
    level: 'graph',
    status: level,
    thresholds: effectiveThresholds,
    violationCount: result.violationCount,
  });
}

// ─── Public API ───────────────────────────────────────────────────────

export function manifestoData(
  customDbPath?: string,
  opts: ManifestoOpts = {},
): Record<string, unknown> {
  const db = openReadonlyOrFail(customDbPath);

  try {
    const config = opts.config || loadConfig(process.cwd());
    const rules = resolveRules(
      config.manifesto?.rules as unknown as Record<string, Partial<ThresholdRule>>,
    );

    const violations: Violation[] = [];
    const ruleResults: RuleResult[] = [];

    evaluateFunctionRules(db, rules, opts, violations, ruleResults);
    evaluateFileRules(db, rules, opts, violations, ruleResults);
    evaluateGraphRules(db, rules, opts, violations, ruleResults);
    evaluateBoundaryRules(db, rules, config, opts, violations, ruleResults);

    const failViolations = violations.filter((v) => v.level === 'fail');

    const summary = {
      total: ruleResults.length,
      passed: ruleResults.filter((r) => r.status === 'pass').length,
      warned: ruleResults.filter((r) => r.status === 'warn').length,
      failed: ruleResults.filter((r) => r.status === 'fail').length,
      violationCount: violations.length,
    };

    const base = {
      rules: ruleResults,
      violations,
      summary,
      passed: failViolations.length === 0,
    };
    return paginateResult(base, 'violations', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}
