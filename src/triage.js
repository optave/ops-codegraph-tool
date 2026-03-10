import { findNodesForTriage, openReadonlyOrFail } from './db.js';
import { isTestFile } from './infrastructure/test-filter.js';
import { warn } from './logger.js';
import { paginateResult } from './paginate.js';

// ─── Constants ────────────────────────────────────────────────────────

const DEFAULT_WEIGHTS = {
  fanIn: 0.25,
  complexity: 0.3,
  churn: 0.2,
  role: 0.15,
  mi: 0.1,
};

const ROLE_WEIGHTS = {
  core: 1.0,
  utility: 0.9,
  entry: 0.8,
  adapter: 0.5,
  leaf: 0.2,
  dead: 0.1,
};

const DEFAULT_ROLE_WEIGHT = 0.5;

// ─── Helpers ──────────────────────────────────────────────────────────

/** Min-max normalize an array of numbers. All-equal → all zeros. */
function minMaxNormalize(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0);
  const range = max - min;
  return values.map((v) => (v - min) / range);
}

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

    // Extract raw signal arrays
    const fanIns = filtered.map((r) => r.fan_in);
    const cognitives = filtered.map((r) => r.cognitive);
    const churns = filtered.map((r) => r.churn);
    const mis = filtered.map((r) => r.mi);

    // Min-max normalize
    const normFanIns = minMaxNormalize(fanIns);
    const normCognitives = minMaxNormalize(cognitives);
    const normChurns = minMaxNormalize(churns);
    // MI: higher is better, so invert: 1 - norm(mi)
    const normMIsRaw = minMaxNormalize(mis);
    const normMIs = normMIsRaw.map((v) => round4(1 - v));

    // Compute risk scores
    const items = filtered.map((r, i) => {
      const roleWeight = ROLE_WEIGHTS[r.role] ?? DEFAULT_ROLE_WEIGHT;
      const riskScore =
        weights.fanIn * normFanIns[i] +
        weights.complexity * normCognitives[i] +
        weights.churn * normChurns[i] +
        weights.role * roleWeight +
        weights.mi * normMIs[i];

      return {
        name: r.name,
        kind: r.kind,
        file: r.file,
        line: r.line,
        role: r.role || null,
        fanIn: r.fan_in,
        cognitive: r.cognitive,
        churn: r.churn,
        maintainabilityIndex: r.mi,
        normFanIn: round4(normFanIns[i]),
        normComplexity: round4(normCognitives[i]),
        normChurn: round4(normChurns[i]),
        normMI: round4(normMIs[i]),
        roleWeight,
        riskScore: round4(riskScore),
      };
    });

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
