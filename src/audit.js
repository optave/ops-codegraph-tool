/**
 * audit.js — Composite report: explain + impact + health metrics per function.
 *
 * Combines explainData (structure, callers, callees, basic complexity),
 * full function_complexity health metrics, BFS impact analysis, and
 * manifesto threshold breach detection into a single call.
 */

import path from 'node:path';
import { loadConfig } from './config.js';
import { openReadonlyOrFail } from './db.js';
import { RULE_DEFS } from './manifesto.js';
import { explainData, kindIcon } from './queries.js';
import { outputResult } from './result-formatter.js';
import { isTestFile } from './test-filter.js';

// ─── Threshold resolution ───────────────────────────────────────────

const FUNCTION_RULES = RULE_DEFS.filter((d) => d.level === 'function');

function resolveThresholds(customDbPath) {
  try {
    const dbDir = path.dirname(customDbPath);
    const repoRoot = path.resolve(dbDir, '..');
    const cfg = loadConfig(repoRoot);
    const userRules = cfg.manifesto || {};
    const resolved = {};
    for (const def of FUNCTION_RULES) {
      const user = userRules[def.name];
      resolved[def.name] = {
        metric: def.metric,
        warn: user?.warn !== undefined ? user.warn : def.defaults.warn,
        fail: def.reportOnly ? null : user?.fail !== undefined ? user.fail : def.defaults.fail,
      };
    }
    return resolved;
  } catch {
    // Fall back to defaults if config loading fails
    const resolved = {};
    for (const def of FUNCTION_RULES) {
      resolved[def.name] = {
        metric: def.metric,
        warn: def.defaults.warn,
        fail: def.reportOnly ? null : def.defaults.fail,
      };
    }
    return resolved;
  }
}

// Column name in DB → threshold rule name mapping
const METRIC_TO_RULE = {
  cognitive: 'cognitive',
  cyclomatic: 'cyclomatic',
  max_nesting: 'maxNesting',
};

function checkBreaches(row, thresholds) {
  const breaches = [];
  for (const [col, ruleName] of Object.entries(METRIC_TO_RULE)) {
    const t = thresholds[ruleName];
    if (!t) continue;
    const value = row[col];
    if (value == null) continue;
    if (t.fail != null && value >= t.fail) {
      breaches.push({ metric: ruleName, value, threshold: t.fail, level: 'fail' });
    } else if (t.warn != null && value >= t.warn) {
      breaches.push({ metric: ruleName, value, threshold: t.warn, level: 'warn' });
    }
  }
  return breaches;
}

// ─── BFS impact (inline, same algorithm as fnImpactData) ────────────

function computeImpact(db, nodeId, noTests, maxDepth) {
  const visited = new Set([nodeId]);
  const levels = {};
  let frontier = [nodeId];

  for (let d = 1; d <= maxDepth; d++) {
    const nextFrontier = [];
    for (const fid of frontier) {
      const callers = db
        .prepare(
          `SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line
           FROM edges e JOIN nodes n ON e.source_id = n.id
           WHERE e.target_id = ? AND e.kind = 'calls'`,
        )
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

  return { totalDependents: visited.size - 1, levels };
}

// ─── Phase 4.4 fields (graceful null fallback) ─────────────────────

function readPhase44(db, nodeId) {
  try {
    const row = db
      .prepare('SELECT risk_score, complexity_notes, side_effects FROM nodes WHERE id = ?')
      .get(nodeId);
    if (row) {
      return {
        riskScore: row.risk_score ?? null,
        complexityNotes: row.complexity_notes ?? null,
        sideEffects: row.side_effects ?? null,
      };
    }
  } catch {
    /* columns don't exist yet */
  }
  return { riskScore: null, complexityNotes: null, sideEffects: null };
}

// ─── auditData ──────────────────────────────────────────────────────

export function auditData(target, customDbPath, opts = {}) {
  const noTests = opts.noTests || false;
  const maxDepth = opts.depth || 3;
  const file = opts.file;
  const kind = opts.kind;

  // 1. Get structure via explainData
  const explained = explainData(target, customDbPath, { noTests, depth: 0 });

  // Apply --file and --kind filters for function targets
  let results = explained.results;
  if (explained.kind === 'function') {
    if (file) results = results.filter((r) => r.file.includes(file));
    if (kind) results = results.filter((r) => r.kind === kind);
  }

  if (results.length === 0) {
    return { target, kind: explained.kind, functions: [] };
  }

  // 2. Open DB for enrichment
  const db = openReadonlyOrFail(customDbPath);
  const thresholds = resolveThresholds(customDbPath);

  let functions;
  try {
    if (explained.kind === 'file') {
      // File target: explainData returns file-level info with publicApi + internal
      // We need to enrich each symbol
      functions = [];
      for (const fileResult of results) {
        const allSymbols = [...(fileResult.publicApi || []), ...(fileResult.internal || [])];
        if (kind) {
          const filtered = allSymbols.filter((s) => s.kind === kind);
          for (const sym of filtered) {
            functions.push(enrichSymbol(db, sym, fileResult.file, noTests, maxDepth, thresholds));
          }
        } else {
          for (const sym of allSymbols) {
            functions.push(enrichSymbol(db, sym, fileResult.file, noTests, maxDepth, thresholds));
          }
        }
      }
    } else {
      // Function target: explainData returns per-function results
      functions = results.map((r) => enrichFunction(db, r, noTests, maxDepth, thresholds));
    }
  } finally {
    db.close();
  }

  return { target, kind: explained.kind, functions };
}

// ─── Enrich a function result from explainData ──────────────────────

function enrichFunction(db, r, noTests, maxDepth, thresholds) {
  const nodeRow = db
    .prepare('SELECT id FROM nodes WHERE name = ? AND file = ? AND line = ?')
    .get(r.name, r.file, r.line);

  const nodeId = nodeRow?.id;
  const health = nodeId ? buildHealth(db, nodeId, thresholds) : defaultHealth();
  const impact = nodeId
    ? computeImpact(db, nodeId, noTests, maxDepth)
    : { totalDependents: 0, levels: {} };
  const phase44 = nodeId
    ? readPhase44(db, nodeId)
    : { riskScore: null, complexityNotes: null, sideEffects: null };

  return {
    name: r.name,
    kind: r.kind,
    file: r.file,
    line: r.line,
    endLine: r.endLine,
    role: r.role,
    lineCount: r.lineCount,
    summary: r.summary,
    signature: r.signature,
    callees: r.callees,
    callers: r.callers,
    relatedTests: r.relatedTests,
    impact,
    health,
    ...phase44,
  };
}

// ─── Enrich a symbol from file-level explainData ────────────────────

function enrichSymbol(db, sym, file, noTests, maxDepth, thresholds) {
  const nodeRow = db
    .prepare('SELECT id, end_line FROM nodes WHERE name = ? AND file = ? AND line = ?')
    .get(sym.name, file, sym.line);

  const nodeId = nodeRow?.id;
  const endLine = nodeRow?.end_line || null;
  const lineCount = endLine ? endLine - sym.line + 1 : null;

  // Get callers/callees for this symbol
  let callees = [];
  let callers = [];
  let relatedTests = [];
  if (nodeId) {
    callees = db
      .prepare(
        `SELECT n.name, n.kind, n.file, n.line
         FROM edges e JOIN nodes n ON e.target_id = n.id
         WHERE e.source_id = ? AND e.kind = 'calls'`,
      )
      .all(nodeId)
      .map((c) => ({ name: c.name, kind: c.kind, file: c.file, line: c.line }));

    callers = db
      .prepare(
        `SELECT n.name, n.kind, n.file, n.line
         FROM edges e JOIN nodes n ON e.source_id = n.id
         WHERE e.target_id = ? AND e.kind = 'calls'`,
      )
      .all(nodeId)
      .map((c) => ({ name: c.name, kind: c.kind, file: c.file, line: c.line }));
    if (noTests) callers = callers.filter((c) => !isTestFile(c.file));

    const testCallerRows = db
      .prepare(
        `SELECT DISTINCT n.file FROM edges e JOIN nodes n ON e.source_id = n.id
         WHERE e.target_id = ? AND e.kind = 'calls'`,
      )
      .all(nodeId);
    relatedTests = testCallerRows.filter((r) => isTestFile(r.file)).map((r) => ({ file: r.file }));
  }

  const health = nodeId ? buildHealth(db, nodeId, thresholds) : defaultHealth();
  const impact = nodeId
    ? computeImpact(db, nodeId, noTests, maxDepth)
    : { totalDependents: 0, levels: {} };
  const phase44 = nodeId
    ? readPhase44(db, nodeId)
    : { riskScore: null, complexityNotes: null, sideEffects: null };

  return {
    name: sym.name,
    kind: sym.kind,
    file,
    line: sym.line,
    endLine,
    role: sym.role || null,
    lineCount,
    summary: sym.summary || null,
    signature: sym.signature || null,
    callees,
    callers,
    relatedTests,
    impact,
    health,
    ...phase44,
  };
}

// ─── Build health metrics from function_complexity ──────────────────

function buildHealth(db, nodeId, thresholds) {
  try {
    const row = db
      .prepare(
        `SELECT cognitive, cyclomatic, max_nesting, maintainability_index,
                halstead_volume, halstead_difficulty, halstead_effort, halstead_bugs,
                loc, sloc, comment_lines
         FROM function_complexity WHERE node_id = ?`,
      )
      .get(nodeId);

    if (!row) return defaultHealth();

    return {
      cognitive: row.cognitive,
      cyclomatic: row.cyclomatic,
      maxNesting: row.max_nesting,
      maintainabilityIndex: row.maintainability_index || 0,
      halstead: {
        volume: row.halstead_volume || 0,
        difficulty: row.halstead_difficulty || 0,
        effort: row.halstead_effort || 0,
        bugs: row.halstead_bugs || 0,
      },
      loc: row.loc || 0,
      sloc: row.sloc || 0,
      commentLines: row.comment_lines || 0,
      thresholdBreaches: checkBreaches(row, thresholds),
    };
  } catch {
    /* table may not exist */
    return defaultHealth();
  }
}

function defaultHealth() {
  return {
    cognitive: null,
    cyclomatic: null,
    maxNesting: null,
    maintainabilityIndex: null,
    halstead: { volume: 0, difficulty: 0, effort: 0, bugs: 0 },
    loc: 0,
    sloc: 0,
    commentLines: 0,
    thresholdBreaches: [],
  };
}

// ─── CLI formatter ──────────────────────────────────────────────────

export function audit(target, customDbPath, opts = {}) {
  const data = auditData(target, customDbPath, opts);

  if (outputResult(data, null, opts)) return;

  if (data.functions.length === 0) {
    console.log(`No ${data.kind === 'file' ? 'file' : 'function/symbol'} matching "${target}"`);
    return;
  }

  console.log(`\n# Audit: ${target} (${data.kind})`);
  console.log(`  ${data.functions.length} function(s) analyzed\n`);

  for (const fn of data.functions) {
    const lineRange = fn.endLine ? `${fn.line}-${fn.endLine}` : `${fn.line}`;
    const roleTag = fn.role ? ` [${fn.role}]` : '';
    console.log(`## ${kindIcon(fn.kind)} ${fn.name} (${fn.kind})${roleTag}`);
    console.log(`  ${fn.file}:${lineRange}${fn.lineCount ? ` (${fn.lineCount} lines)` : ''}`);
    if (fn.summary) console.log(`  ${fn.summary}`);
    if (fn.signature) {
      if (fn.signature.params != null) console.log(`  Parameters: (${fn.signature.params})`);
      if (fn.signature.returnType) console.log(`  Returns: ${fn.signature.returnType}`);
    }

    // Health metrics
    if (fn.health.cognitive != null) {
      console.log(`\n  Health:`);
      console.log(
        `    Cognitive: ${fn.health.cognitive}  Cyclomatic: ${fn.health.cyclomatic}  Nesting: ${fn.health.maxNesting}`,
      );
      console.log(`    MI: ${fn.health.maintainabilityIndex}`);
      if (fn.health.halstead.volume) {
        console.log(
          `    Halstead: vol=${fn.health.halstead.volume} diff=${fn.health.halstead.difficulty} effort=${fn.health.halstead.effort} bugs=${fn.health.halstead.bugs}`,
        );
      }
      if (fn.health.loc) {
        console.log(
          `    LOC: ${fn.health.loc}  SLOC: ${fn.health.sloc}  Comments: ${fn.health.commentLines}`,
        );
      }
    }

    // Threshold breaches
    if (fn.health.thresholdBreaches.length > 0) {
      console.log(`\n  Threshold Breaches:`);
      for (const b of fn.health.thresholdBreaches) {
        const icon = b.level === 'fail' ? 'FAIL' : 'WARN';
        console.log(`    [${icon}] ${b.metric}: ${b.value} >= ${b.threshold}`);
      }
    }

    // Impact
    console.log(`\n  Impact: ${fn.impact.totalDependents} transitive dependent(s)`);
    for (const [level, nodes] of Object.entries(fn.impact.levels)) {
      console.log(`    Level ${level}: ${nodes.map((n) => n.name).join(', ')}`);
    }

    // Call edges
    if (fn.callees.length > 0) {
      console.log(`\n  Calls (${fn.callees.length}):`);
      for (const c of fn.callees) {
        console.log(`    ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
      }
    }
    if (fn.callers.length > 0) {
      console.log(`\n  Called by (${fn.callers.length}):`);
      for (const c of fn.callers) {
        console.log(`    ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
      }
    }
    if (fn.relatedTests.length > 0) {
      console.log(`\n  Tests (${fn.relatedTests.length}):`);
      for (const t of fn.relatedTests) {
        console.log(`    ${t.file}`);
      }
    }

    console.log();
  }
}
