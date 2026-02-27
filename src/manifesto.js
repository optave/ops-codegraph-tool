import { loadConfig } from './config.js';
import { findCycles } from './cycles.js';
import { openReadonlyOrFail } from './db.js';
import { debug } from './logger.js';

// ─── Rule Definitions ─────────────────────────────────────────────────

/**
 * All supported manifesto rules.
 * level: 'function' | 'file' | 'graph'
 * metric: DB column or special key
 * defaults: { warn, fail } — null means disabled
 */
export const RULE_DEFS = [
  { name: 'cognitive', level: 'function', metric: 'cognitive', defaults: { warn: 15, fail: null }, reportOnly: true },
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
];

// ─── Helpers ──────────────────────────────────────────────────────────

const NO_TEST_SQL = `
  AND n.file NOT LIKE '%.test.%'
  AND n.file NOT LIKE '%.spec.%'
  AND n.file NOT LIKE '%__test__%'
  AND n.file NOT LIKE '%__tests__%'
  AND n.file NOT LIKE '%.stories.%'`;

/**
 * Deep-merge user config with RULE_DEFS defaults per rule.
 * mergeConfig in config.js is shallow for nested objects, so we do per-rule merging here.
 */
function resolveRules(userRules) {
  const resolved = {};
  for (const def of RULE_DEFS) {
    const user = userRules?.[def.name];
    resolved[def.name] = {
      warn: user?.warn !== undefined ? user.warn : def.defaults.warn,
      fail: def.reportOnly ? null : (user?.fail !== undefined ? user.fail : def.defaults.fail),
    };
  }
  return resolved;
}

/**
 * Check if a rule is enabled (has at least one non-null threshold).
 */
function isEnabled(thresholds) {
  return thresholds.warn != null || thresholds.fail != null;
}

/**
 * Check a numeric value against warn/fail thresholds, push violations.
 */
function checkThreshold(rule, thresholds, value, meta, violations) {
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

function evaluateFunctionRules(db, rules, opts, violations, ruleResults) {
  const functionDefs = RULE_DEFS.filter((d) => d.level === 'function');
  const activeDefs = functionDefs.filter((d) => isEnabled(rules[d.name]));
  if (activeDefs.length === 0) {
    for (const def of functionDefs) {
      ruleResults.push({
        name: def.name,
        level: def.level,
        status: 'pass',
        thresholds: rules[def.name],
        violationCount: 0,
      });
    }
    return;
  }

  let where = "WHERE n.kind IN ('function','method')";
  const params = [];
  if (opts.noTests) where += NO_TEST_SQL;
  if (opts.file) {
    where += ' AND n.file LIKE ?';
    params.push(`%${opts.file}%`);
  }
  if (opts.kind) {
    where += ' AND n.kind = ?';
    params.push(opts.kind);
  }

  let rows;
  try {
    rows = db
      .prepare(
        `SELECT n.name, n.kind, n.file, n.line,
                fc.cognitive, fc.cyclomatic, fc.max_nesting
         FROM function_complexity fc
         JOIN nodes n ON fc.node_id = n.id
         ${where}`,
      )
      .all(...params);
  } catch (err) {
    debug('manifesto function query failed: %s', err.message);
    rows = [];
  }

  // Track worst status per rule
  const worst = {};
  const counts = {};
  for (const def of functionDefs) {
    worst[def.name] = 'pass';
    counts[def.name] = 0;
  }

  for (const row of rows) {
    for (const def of activeDefs) {
      const value = row[def.metric];
      if (value == null) continue;
      const meta = { name: row.name, file: row.file, line: row.line };
      const status = checkThreshold(def.name, rules[def.name], value, meta, violations);
      if (status !== 'pass') {
        counts[def.name]++;
        if (status === 'fail') worst[def.name] = 'fail';
        else if (worst[def.name] !== 'fail') worst[def.name] = 'warn';
      }
    }
  }

  for (const def of functionDefs) {
    ruleResults.push({
      name: def.name,
      level: def.level,
      status: worst[def.name],
      thresholds: rules[def.name],
      violationCount: counts[def.name],
    });
  }
}

function evaluateFileRules(db, rules, opts, violations, ruleResults) {
  const fileDefs = RULE_DEFS.filter((d) => d.level === 'file');
  const activeDefs = fileDefs.filter((d) => isEnabled(rules[d.name]));
  if (activeDefs.length === 0) {
    for (const def of fileDefs) {
      ruleResults.push({
        name: def.name,
        level: def.level,
        status: 'pass',
        thresholds: rules[def.name],
        violationCount: 0,
      });
    }
    return;
  }

  let where = "WHERE n.kind = 'file'";
  const params = [];
  if (opts.noTests) where += NO_TEST_SQL;
  if (opts.file) {
    where += ' AND n.file LIKE ?';
    params.push(`%${opts.file}%`);
  }

  let rows;
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
      .all(...params);
  } catch (err) {
    debug('manifesto file query failed: %s', err.message);
    rows = [];
  }

  const worst = {};
  const counts = {};
  for (const def of fileDefs) {
    worst[def.name] = 'pass';
    counts[def.name] = 0;
  }

  for (const row of rows) {
    for (const def of activeDefs) {
      const value = row[def.metric];
      if (value == null) continue;
      const meta = { name: row.name, file: row.file, line: row.line };
      const status = checkThreshold(def.name, rules[def.name], value, meta, violations);
      if (status !== 'pass') {
        counts[def.name]++;
        if (status === 'fail') worst[def.name] = 'fail';
        else if (worst[def.name] !== 'fail') worst[def.name] = 'warn';
      }
    }
  }

  for (const def of fileDefs) {
    ruleResults.push({
      name: def.name,
      level: def.level,
      status: worst[def.name],
      thresholds: rules[def.name],
      violationCount: counts[def.name],
    });
  }
}

function evaluateGraphRules(db, rules, opts, violations, ruleResults) {
  const thresholds = rules.noCycles;
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

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Evaluate all manifesto rules and return structured results.
 *
 * @param {string} [customDbPath] - Path to graph.db
 * @param {object} [opts] - Options
 * @param {boolean} [opts.noTests] - Exclude test files
 * @param {string} [opts.file] - Filter by file (partial match)
 * @param {string} [opts.kind] - Filter by symbol kind
 * @returns {{ rules: object[], violations: object[], summary: object, passed: boolean }}
 */
export function manifestoData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);

  try {
    const config = loadConfig(process.cwd());
    const rules = resolveRules(config.manifesto?.rules);

    const violations = [];
    const ruleResults = [];

    evaluateFunctionRules(db, rules, opts, violations, ruleResults);
    evaluateFileRules(db, rules, opts, violations, ruleResults);
    evaluateGraphRules(db, rules, opts, violations, ruleResults);

    const failViolations = violations.filter((v) => v.level === 'fail');

    const summary = {
      total: ruleResults.length,
      passed: ruleResults.filter((r) => r.status === 'pass').length,
      warned: ruleResults.filter((r) => r.status === 'warn').length,
      failed: ruleResults.filter((r) => r.status === 'fail').length,
      violationCount: violations.length,
    };

    return {
      rules: ruleResults,
      violations,
      summary,
      passed: failViolations.length === 0,
    };
  } finally {
    db.close();
  }
}

/**
 * CLI formatter — prints manifesto results and exits with code 1 on failure.
 */
export function manifesto(customDbPath, opts = {}) {
  const data = manifestoData(customDbPath, opts);

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    if (!data.passed) process.exit(1);
    return;
  }

  console.log('\n# Manifesto Rules\n');

  // Rules table
  console.log(
    `  ${'Rule'.padEnd(20)} ${'Level'.padEnd(10)} ${'Status'.padEnd(8)} ${'Warn'.padStart(6)} ${'Fail'.padStart(6)} ${'Violations'.padStart(11)}`,
  );
  console.log(
    `  ${'─'.repeat(20)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(11)}`,
  );

  for (const rule of data.rules) {
    const warn = rule.thresholds.warn != null ? String(rule.thresholds.warn) : '—';
    const fail = rule.thresholds.fail != null ? String(rule.thresholds.fail) : '—';
    const statusIcon = rule.status === 'pass' ? 'pass' : rule.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(
      `  ${rule.name.padEnd(20)} ${rule.level.padEnd(10)} ${statusIcon.padEnd(8)} ${warn.padStart(6)} ${fail.padStart(6)} ${String(rule.violationCount).padStart(11)}`,
    );
  }

  // Summary
  const s = data.summary;
  console.log(
    `\n  ${s.total} rules | ${s.passed} passed | ${s.warned} warned | ${s.failed} failed | ${s.violationCount} violations`,
  );

  // Violations detail
  if (data.violations.length > 0) {
    const failViolations = data.violations.filter((v) => v.level === 'fail');
    const warnViolations = data.violations.filter((v) => v.level === 'warn');

    if (failViolations.length > 0) {
      console.log(`\n## Failures (${failViolations.length})\n`);
      for (const v of failViolations.slice(0, 20)) {
        const loc = v.line ? `${v.file}:${v.line}` : v.file;
        console.log(
          `  [FAIL] ${v.rule}: ${v.name} (${v.value}) at ${loc} — threshold ${v.threshold}`,
        );
      }
      if (failViolations.length > 20) {
        console.log(`  ... and ${failViolations.length - 20} more`);
      }
    }

    if (warnViolations.length > 0) {
      console.log(`\n## Warnings (${warnViolations.length})\n`);
      for (const v of warnViolations.slice(0, 20)) {
        const loc = v.line ? `${v.file}:${v.line}` : v.file;
        console.log(
          `  [WARN] ${v.rule}: ${v.name} (${v.value}) at ${loc} — threshold ${v.threshold}`,
        );
      }
      if (warnViolations.length > 20) {
        console.log(`  ... and ${warnViolations.length - 20} more`);
      }
    }
  }

  console.log();

  if (!data.passed) {
    process.exit(1);
  }
}
