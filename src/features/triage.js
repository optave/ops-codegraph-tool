import { findNodesForTriage, openReadonlyOrFail } from '../db/index.js';
import { DEFAULT_WEIGHTS, scoreRisk } from '../graph/classifiers/risk.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import { warn } from '../infrastructure/logger.js';
import { paginateResult } from '../shared/paginate.js';

// ─── Data Function ────────────────────────────────────────────────────

/**
 * Compute composite risk scores for all symbols.
 *
 * @param {string} [customDbPath] - Path to graph.db
 * @param {object} [opts]
 * @returns {{ items: object[], summary: object, _pagination?: object }}
 */
export function triageData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const fileFilter = opts.file || null;
    const kindFilter = opts.kind || null;
    const roleFilter = opts.role || null;
    const minScore = opts.minScore != null ? Number(opts.minScore) : null;
    const sort = opts.sort || 'risk';
    const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };

    let rows;
    try {
      rows = findNodesForTriage(db, {
        noTests,
        file: fileFilter,
        kind: kindFilter,
        role: roleFilter,
      });
    } catch (err) {
      warn(`triage query failed: ${err.message}`);
      return {
        items: [],
        summary: { total: 0, analyzed: 0, avgScore: 0, maxScore: 0, weights, signalCoverage: {} },
      };
    }

    // Post-filter test files (belt-and-suspenders)
    const filtered = noTests ? rows.filter((r) => !isTestFile(r.file)) : rows;

    if (filtered.length === 0) {
      return {
        items: [],
        summary: { total: 0, analyzed: 0, avgScore: 0, maxScore: 0, weights, signalCoverage: {} },
      };
    }

    // Delegate scoring to classifier
    const riskMetrics = scoreRisk(filtered, weights);

    // Compute risk scores
    const items = filtered.map((r, i) => ({
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

    // Apply minScore filter
    const scored = minScore != null ? items.filter((it) => it.riskScore >= minScore) : items;

    // Sort
    const sortFns = {
      risk: (a, b) => b.riskScore - a.riskScore,
      complexity: (a, b) => b.cognitive - a.cognitive,
      churn: (a, b) => b.churn - a.churn,
      'fan-in': (a, b) => b.fanIn - a.fanIn,
      mi: (a, b) => a.maintainabilityIndex - b.maintainabilityIndex,
    };
    scored.sort(sortFns[sort] || sortFns.risk);

    // Signal coverage: % of items with non-zero signal
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

    const result = {
      items: scored,
      summary: {
        total: filtered.length,
        analyzed: scored.length,
        avgScore,
        maxScore,
        weights,
        signalCoverage,
      },
    };

    return paginateResult(result, 'items', {
      limit: opts.limit,
      offset: opts.offset,
    });
  } finally {
    db.close();
  }
}

// ─── Utilities ────────────────────────────────────────────────────────

function round4(n) {
  return Math.round(n * 10000) / 10000;
}
