import { describe, expect, it } from 'vitest';
import { minMaxNormalize, ROLE_WEIGHTS, scoreRisk } from '../../../src/graph/classifiers/risk.js';

describe('minMaxNormalize', () => {
  it('normalizes to [0, 1] range', () => {
    expect(minMaxNormalize([0, 5, 10])).toEqual([0, 0.5, 1]);
  });

  it('returns all zeros for equal values', () => {
    expect(minMaxNormalize([3, 3, 3])).toEqual([0, 0, 0]);
  });

  it('handles single element', () => {
    expect(minMaxNormalize([42])).toEqual([0]);
  });
});

describe('scoreRisk', () => {
  it('scores items with all signals', () => {
    const items = [
      { fan_in: 10, cognitive: 20, churn: 5, mi: 80, role: 'core' },
      { fan_in: 1, cognitive: 2, churn: 0, mi: 100, role: 'leaf' },
    ];
    const scores = scoreRisk(items);
    expect(scores).toHaveLength(2);
    expect(scores[0].riskScore).toBeGreaterThan(scores[1].riskScore);
    expect(scores[0].roleWeight).toBe(ROLE_WEIGHTS.core);
    expect(scores[1].roleWeight).toBe(ROLE_WEIGHTS.leaf);
  });

  it('respects custom weights', () => {
    const items = [
      { fan_in: 10, cognitive: 0, churn: 0, mi: 100, role: 'core' },
      { fan_in: 0, cognitive: 10, churn: 0, mi: 100, role: 'core' },
    ];
    const fanWeighted = scoreRisk(items, { fanIn: 1, complexity: 0, churn: 0, role: 0, mi: 0 });
    expect(fanWeighted[0].riskScore).toBeGreaterThan(fanWeighted[1].riskScore);
  });

  it('returns all zeros when all signals are equal', () => {
    const items = [
      { fan_in: 5, cognitive: 5, churn: 5, mi: 50, role: 'leaf' },
      { fan_in: 5, cognitive: 5, churn: 5, mi: 50, role: 'leaf' },
    ];
    const scores = scoreRisk(items);
    // normFanIn, normComplexity, normChurn should be 0 (all equal)
    expect(scores[0].normFanIn).toBe(0);
    expect(scores[0].normComplexity).toBe(0);
    // But roleWeight and normMI contribute
    expect(scores[0].riskScore).toBeGreaterThan(0);
  });

  it('uses default role weight for unknown roles', () => {
    const items = [{ fan_in: 0, cognitive: 0, churn: 0, mi: 0, role: 'unknown' }];
    const scores = scoreRisk(items);
    expect(scores[0].roleWeight).toBe(0.5);
  });
});
