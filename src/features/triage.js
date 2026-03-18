import { openRepo } from '../db/index.js';
import { DEFAULT_WEIGHTS, scoreRisk } from '../graph/classifiers/risk.js';
import { loadConfig } from '../infrastructure/config.js';
import { warn } from '../infrastructure/logger.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import { paginateResult } from '../shared/paginate.js';

// ─── Scoring ─────────────────────────────────────────────────────────

const SORT_FNS = {
  risk: (a, b) => b.riskScore - a.riskScore,
  complexity: (a, b) => b.cognitive - a.cognitive,
  churn: (a, b) => b.churn - a.churn,
  'fan-in': (a, b) => b.fanIn - a.fanIn,
  mi: (a, b) => a.maintainabilityIndex - b.maintainabilityIndex,
};

/**
 * Build scored triage items from raw rows and risk metrics.
 * @param {object[]} rows - Raw DB rows
 * @param {object[]} riskMetrics - Per-row risk metric objects from scoreRisk
 * @returns {object[]}
 */
function buildTriageItems(rows, riskMetrics) {
  return rows.map((r, i) => ({
    name: r.name,
    kind: r.kind,
    file: r.file,
    line: r.line,
    role: r.role || null,
    fanIn: r.fan_in,
    cognitive: r.cognitive,
    churn: r.churn,
    maintainabilityIndex: r.mi,
    normFanIn: riskMetrics[i].normFanIn,
    normComplexity: riskMetrics[i].normComplexity,
    normChurn: riskMetrics[i].normChurn,
    normMI: riskMetrics[i].normMI,
    roleWeight: riskMetrics[i].roleWeight,
    riskScore: riskMetrics[i].riskScore,
  }));
}

/**
 * Compute signal coverage and summary statistics.
 * @param {object[]} filtered - All filtered rows
 * @param {object[]} scored - Scored and filtered items
 * @param {object} weights - Active weights
 * @returns {object}
 */
function computeTriageSummary(filtered, scored, weights) {
  const signalCoverage = {
    complexity: round4(filtered.filter((r) => r.cognitive > 0).length / filtered.length),
    churn: round4(filtered.filter((r) => r.churn > 0).length / filtered.length),
    fanIn: round4(filtered.filter((r) => r.fan_in > 0).length / filtered.length),
    mi: round4(filtered.filter((r) => r.mi > 0).length / filtered.length),
  };

  const scores = scored.map((it) => it.riskScore);
  const avgScore =
    scores.length > 0 ? round4(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const maxScore = scores.length > 0 ? round4(Math.max(...scores)) : 0;

  return {
    total: filtered.length,
    analyzed: scored.length,
    avgScore,
    maxScore,
    weights,
    signalCoverage,
  };
}

// ─── Data Function ────────────────────────────────────────────────────

const EMPTY_SUMMARY = (weights) => ({
  total: 0,
  analyzed: 0,
  avgScore: 0,
  maxScore: 0,
  weights,
  signalCoverage: {},
});

/**
 * Compute composite risk scores for all symbols.
 *
 * @param {string} [customDbPath] - Path to graph.db
 * @param {object} [opts]
 * @returns {{ items: object[], summary: object, _pagination?: object }}
 */
export function triageData(customDbPath, opts = {}) {
  const { repo, close } = openRepo(customDbPath, opts);
  try {
    const noTests = opts.noTests || false;
    const minScore = opts.minScore != null ? Number(opts.minScore) : null;
    const sort = opts.sort || 'risk';
    const config = opts.config || loadConfig();
    const riskConfig = config.risk || {};
    const weights = { ...DEFAULT_WEIGHTS, ...(riskConfig.weights || {}), ...(opts.weights || {}) };
    const riskOpts = {
      roleWeights: riskConfig.roleWeights,
      defaultRoleWeight: riskConfig.defaultRoleWeight,
    };

    let rows;
    try {
      rows = repo.findNodesForTriage({
        noTests,
        file: opts.file || null,
        kind: opts.kind || null,
        role: opts.role || null,
      });
    } catch (err) {
      warn(`triage query failed: ${err.message}`);
      return { items: [], summary: EMPTY_SUMMARY(weights) };
    }

    const filtered = noTests ? rows.filter((r) => !isTestFile(r.file)) : rows;
    if (filtered.length === 0) {
      return { items: [], summary: EMPTY_SUMMARY(weights) };
    }

    const riskMetrics = scoreRisk(filtered, weights, riskOpts);
    const items = buildTriageItems(filtered, riskMetrics);

    const scored = minScore != null ? items.filter((it) => it.riskScore >= minScore) : items;
    scored.sort(SORT_FNS[sort] || SORT_FNS.risk);

    const result = {
      items: scored,
      summary: computeTriageSummary(filtered, scored, weights),
    };

    return paginateResult(result, 'items', {
      limit: opts.limit,
      offset: opts.offset,
    });
  } finally {
    close();
  }
}

// ─── Utilities ────────────────────────────────────────────────────────

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
