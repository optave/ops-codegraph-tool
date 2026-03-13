/**
 * Risk scoring — pure logic, no DB.
 */

// Weights sum to 1.0. Complexity gets the highest weight because cognitive load
// is the strongest predictor of defect density. Fan-in and churn are next as
// they reflect coupling and volatility. Role adds architectural context, and MI
// (maintainability index) is a weaker composite signal, so it gets the least.
export const DEFAULT_WEIGHTS = {
  fanIn: 0.25,
  complexity: 0.3,
  churn: 0.2,
  role: 0.15,
  mi: 0.1,
};

export const ROLE_WEIGHTS = {
  core: 1.0,
  utility: 0.9,
  entry: 0.8,
  adapter: 0.5,
  leaf: 0.2,
  dead: 0.1,
};

const DEFAULT_ROLE_WEIGHT = 0.5;

/** Min-max normalize an array of numbers. All-equal → all zeros. */
export function minMaxNormalize(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0);
  const range = max - min;
  return values.map((v) => (v - min) / range);
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * Score risk for a list of items.
 *
 * @param {{ fan_in: number, cognitive: number, churn: number, mi: number, role: string|null }[]} items
 * @param {object} [weights] - Override DEFAULT_WEIGHTS
 * @returns {{ normFanIn: number, normComplexity: number, normChurn: number, normMI: number, roleWeight: number, riskScore: number }[]}
 *   Parallel array with risk metrics for each input item.
 */
export function scoreRisk(items, weights = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };

  const fanIns = items.map((r) => r.fan_in);
  const cognitives = items.map((r) => r.cognitive);
  const churns = items.map((r) => r.churn);
  const mis = items.map((r) => r.mi);

  const normFanIns = minMaxNormalize(fanIns);
  const normCognitives = minMaxNormalize(cognitives);
  const normChurns = minMaxNormalize(churns);
  const normMIsRaw = minMaxNormalize(mis);
  const normMIs = normMIsRaw.map((v) => round4(1 - v));

  return items.map((r, i) => {
    const roleWeight = ROLE_WEIGHTS[r.role] ?? DEFAULT_ROLE_WEIGHT;
    const riskScore =
      w.fanIn * normFanIns[i] +
      w.complexity * normCognitives[i] +
      w.churn * normChurns[i] +
      w.role * roleWeight +
      w.mi * normMIs[i];

    return {
      normFanIn: round4(normFanIns[i]),
      normComplexity: round4(normCognitives[i]),
      normChurn: round4(normChurns[i]),
      normMI: round4(normMIs[i]),
      roleWeight,
      riskScore: round4(riskScore),
    };
  });
}
