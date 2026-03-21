/**
 * Risk scoring — pure logic, no DB.
 */

import type { Role } from '../../types.js';

export interface RiskWeights {
  fanIn: number;
  complexity: number;
  churn: number;
  role: number;
  mi: number;
}

// Weights sum to 1.0. Complexity gets the highest weight because cognitive load
// is the strongest predictor of defect density. Fan-in and churn are next as
// they reflect coupling and volatility. Role adds architectural context, and MI
// (maintainability index) is a weaker composite signal, so it gets the least.
export const DEFAULT_WEIGHTS: RiskWeights = {
  fanIn: 0.25,
  complexity: 0.3,
  churn: 0.2,
  role: 0.15,
  mi: 0.1,
};

// Role weights reflect structural importance: core modules are central to the
// dependency graph, utilities are widely imported, entry points are API
// surfaces. Adapters bridge subsystems but are replaceable. Leaves, dead
// code, and test-only symbols have minimal downstream impact.
export const ROLE_WEIGHTS: Record<string, number> = {
  core: 1.0,
  utility: 0.9,
  entry: 0.8,
  adapter: 0.5,
  leaf: 0.2,
  'test-only': 0.1,
  dead: 0.1,
  'dead-leaf': 0.0,
  'dead-entry': 0.3,
  'dead-ffi': 0.05,
  'dead-unresolved': 0.15,
};

const DEFAULT_ROLE_WEIGHT = 0.5;

/** Min-max normalize an array of numbers. All-equal → all zeros. */
export function minMaxNormalize(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0);
  const range = max - min;
  return values.map((v) => (v - min) / range);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export interface RiskItem {
  fan_in: number;
  cognitive: number;
  churn: number;
  mi: number;
  role: Role | string | null;
}

export interface RiskResult {
  normFanIn: number;
  normComplexity: number;
  normChurn: number;
  normMI: number;
  roleWeight: number;
  riskScore: number;
}

export interface ScoreRiskOpts {
  roleWeights?: Record<string, number>;
  defaultRoleWeight?: number;
}

/**
 * Score risk for a list of items.
 */
export function scoreRisk(
  items: RiskItem[],
  weights: Partial<RiskWeights> = {},
  opts: ScoreRiskOpts = {},
): RiskResult[] {
  const w: RiskWeights = { ...DEFAULT_WEIGHTS, ...weights };
  const rw = opts.roleWeights || ROLE_WEIGHTS;
  const drw = opts.defaultRoleWeight ?? DEFAULT_ROLE_WEIGHT;

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
    const roleWeight = (r.role != null ? rw[r.role] : undefined) ?? drw;
    const nfi = normFanIns[i] ?? 0;
    const nci = normCognitives[i] ?? 0;
    const nch = normChurns[i] ?? 0;
    const nmi = normMIs[i] ?? 0;
    const riskScore =
      w.fanIn * nfi + w.complexity * nci + w.churn * nch + w.role * roleWeight + w.mi * nmi;

    return {
      normFanIn: round4(nfi),
      normComplexity: round4(nci),
      normChurn: round4(nch),
      normMI: round4(nmi),
      roleWeight,
      riskScore: round4(riskScore),
    };
  });
}
