import { openRepo, type Repository } from '../db/index.js';
import type { RiskResult, RiskWeights } from '../graph/classifiers/risk.js';
import { DEFAULT_WEIGHTS, scoreRisk } from '../graph/classifiers/risk.js';
import { loadConfig } from '../infrastructure/config.js';
import { warn } from '../infrastructure/logger.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import { paginateResult } from '../shared/paginate.js';
import type { CodegraphConfig, Role, TriageNodeRow } from '../types.js';

// ─── Scoring ─────────────────────────────────────────────────────────

interface TriageItem {
  name: string;
  kind: string;
  file: string;
  line: number;
  role: string | null;
  fanIn: number;
  cognitive: number;
  churn: number;
  maintainabilityIndex: number;
  normFanIn: number;
  normComplexity: number;
  normChurn: number;
  normMI: number;
  roleWeight: number;
  riskScore: number;
}

const SORT_FNS: Record<string, (a: TriageItem, b: TriageItem) => number> = {
  risk: (a, b) => b.riskScore - a.riskScore,
  complexity: (a, b) => b.cognitive - a.cognitive,
  churn: (a, b) => b.churn - a.churn,
  'fan-in': (a, b) => b.fanIn - a.fanIn,
  mi: (a, b) => a.maintainabilityIndex - b.maintainabilityIndex,
};

function buildTriageItems(rows: TriageNodeRow[], riskMetrics: RiskResult[]): TriageItem[] {
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
    normFanIn: riskMetrics[i]!.normFanIn,
    normComplexity: riskMetrics[i]!.normComplexity,
    normChurn: riskMetrics[i]!.normChurn,
    normMI: riskMetrics[i]!.normMI,
    roleWeight: riskMetrics[i]!.roleWeight,
    riskScore: riskMetrics[i]!.riskScore,
  }));
}

interface TriageSummary {
  total: number;
  analyzed: number;
  avgScore: number;
  maxScore: number;
  weights: RiskWeights;
  signalCoverage: Record<string, number>;
}

function computeTriageSummary(
  filtered: TriageNodeRow[],
  scored: TriageItem[],
  weights: RiskWeights,
): TriageSummary {
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

const EMPTY_SUMMARY = (weights: RiskWeights): TriageSummary => ({
  total: 0,
  analyzed: 0,
  avgScore: 0,
  maxScore: 0,
  weights,
  signalCoverage: {},
});

interface TriageDataOpts {
  noTests?: boolean;
  minScore?: number | string | null;
  sort?: string;
  config?: CodegraphConfig;
  weights?: Partial<RiskWeights>;
  file?: string;
  kind?: string;
  role?: Role;
  limit?: number;
  offset?: number;
  repo?: Repository;
}

export function triageData(
  customDbPath?: string,
  opts: TriageDataOpts = {},
): { items: TriageItem[]; summary: TriageSummary } {
  const { repo, close } = openRepo(customDbPath, opts);
  try {
    const noTests = opts.noTests || false;
    const minScore = opts.minScore != null ? Number(opts.minScore) : null;
    const sort = opts.sort || 'risk';
    const config = opts.config || loadConfig();
    const riskConfig = ((config as unknown as Record<string, unknown>).risk || {}) as {
      weights?: Partial<RiskWeights>;
      roleWeights?: Record<string, number>;
      defaultRoleWeight?: number;
    };
    const weights: RiskWeights = {
      ...DEFAULT_WEIGHTS,
      ...(riskConfig.weights || {}),
      ...(opts.weights || {}),
    };
    const riskOpts = {
      roleWeights: riskConfig.roleWeights,
      defaultRoleWeight: riskConfig.defaultRoleWeight,
    };

    let rows: TriageNodeRow[];
    try {
      rows = repo.findNodesForTriage({
        noTests,
        file: opts.file || undefined,
        kind: opts.kind || undefined,
        role: opts.role || undefined,
      });
    } catch (err: unknown) {
      warn(`triage query failed: ${(err as Error).message}`);
      return { items: [], summary: EMPTY_SUMMARY(weights) };
    }

    const filtered = noTests ? rows.filter((r) => !isTestFile(r.file)) : rows;
    if (filtered.length === 0) {
      return { items: [], summary: EMPTY_SUMMARY(weights) };
    }

    const riskMetrics = scoreRisk(filtered, weights, riskOpts);
    const items = buildTriageItems(filtered, riskMetrics);

    const scored = minScore != null ? items.filter((it) => it.riskScore >= minScore) : items;
    scored.sort(SORT_FNS[sort] || SORT_FNS.risk!);

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

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
