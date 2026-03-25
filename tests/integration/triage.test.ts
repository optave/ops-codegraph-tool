/**
 * Integration tests for triage — composite risk audit queue.
 *
 * Uses InMemoryRepository via createTestRepo() for fast, SQLite-free testing.
 */

import { beforeAll, describe, expect, test } from 'vitest';
import { triageData } from '../../src/features/triage.js';
import { createTestRepo } from '../helpers/fixtures.js';

// ─── Fixture ──────────────────────────────────────────────────────────

let repo: any;

beforeAll(() => {
  const builder = createTestRepo()
    // High-risk: core role, high fan-in, high complexity
    .fn('processRequest', 'src/handler.js', 10, { role: 'core' })
    // Medium-risk: utility role, moderate signals
    .fn('formatOutput', 'src/formatter.js', 1, { role: 'utility' })
    // Low-risk: leaf role, minimal signals
    .fn('add', 'src/math.js', 1, { role: 'leaf' })
    // Test file: should be excluded with noTests
    .fn('testHelper', 'tests/helper.test.js', 1, { role: 'utility' })
    // Class node
    .cls('Router', 'src/router.js', 1, { role: 'entry' })
    // Callers for fan-in
    .fn('caller1', 'src/a.js', 1)
    .fn('caller2', 'src/b.js', 1)
    .fn('caller3', 'src/c.js', 1)
    // Edges: processRequest has fan_in=3, formatOutput=1, add=0
    .calls('caller1', 'processRequest')
    .calls('caller2', 'processRequest')
    .calls('caller3', 'processRequest')
    .calls('caller1', 'formatOutput')
    // Complexity
    .complexity('processRequest', {
      cognitive: 30,
      cyclomatic: 15,
      max_nesting: 5,
      maintainability_index: 20,
    })
    .complexity('formatOutput', {
      cognitive: 10,
      cyclomatic: 5,
      max_nesting: 2,
      maintainability_index: 60,
    })
    .complexity('add', { cognitive: 1, cyclomatic: 1, max_nesting: 0, maintainability_index: 90 })
    .complexity('testHelper', {
      cognitive: 5,
      cyclomatic: 3,
      max_nesting: 1,
      maintainability_index: 70,
    })
    .complexity('Router', {
      cognitive: 15,
      cyclomatic: 8,
      max_nesting: 3,
      maintainability_index: 40,
    });

  ({ repo } = builder.build());
});

// ─── Tests ─────────────────────────────────────────────────────────────

describe('triage', () => {
  test('ranks symbols by composite risk score (default sort)', () => {
    const result = triageData(null, { repo, limit: 100 });
    expect(result.items.length).toBeGreaterThanOrEqual(3);

    // processRequest should be highest risk
    expect(result.items[0].name).toBe('processRequest');
    // All scores within [0, 1]
    for (const item of result.items) {
      expect(item.riskScore).toBeGreaterThanOrEqual(0);
      expect(item.riskScore).toBeLessThanOrEqual(1);
    }
  });

  test('scores are in descending order by default', () => {
    const result = triageData(null, { repo, limit: 100 });
    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].riskScore).toBeGreaterThanOrEqual(result.items[i].riskScore);
    }
  });

  test('normalization: max fan_in → normFanIn=1.0', () => {
    const result = triageData(null, { repo, limit: 100 });
    const high = result.items.find((it) => it.name === 'processRequest');
    expect(high.normFanIn).toBe(1);
  });

  test('normalization: min cognitive → normComplexity=0.0', () => {
    // callers have cognitive=0 (no complexity row), so add (cognitive=1) is not the min.
    // Filter to only nodes with complexity data to test properly.
    const result = triageData(null, { repo, file: 'src/math', limit: 100 });
    const low = result.items.find((it) => it.name === 'add');
    // Single item → all norms are 0
    expect(low.normComplexity).toBe(0);
  });

  test('custom weights override ranking', () => {
    // Pure fan-in ranking: only fan_in matters
    const result = triageData(null, {
      repo,
      limit: 100,
      weights: { fanIn: 1, complexity: 0, churn: 0, role: 0, mi: 0 },
    });
    // processRequest has fan_in=3 (highest)
    expect(result.items[0].name).toBe('processRequest');
    // formatOutput has fan_in=1
    expect(result.items[1].name).toBe('formatOutput');
  });

  test('filters by file', () => {
    const result = triageData(null, { repo, file: 'handler', limit: 100 });
    expect(result.items.length).toBe(1);
    expect(result.items[0].name).toBe('processRequest');
  });

  test('filters by kind', () => {
    const result = triageData(null, { repo, kind: 'class', limit: 100 });
    expect(result.items.length).toBe(1);
    expect(result.items[0].name).toBe('Router');
  });

  test('filters by role', () => {
    const result = triageData(null, { repo, role: 'core', limit: 100 });
    expect(result.items.length).toBe(1);
    expect(result.items[0].name).toBe('processRequest');
  });

  test('filters by minScore', () => {
    const all = triageData(null, { repo, limit: 100 });
    const maxScore = all.items[0].riskScore;
    const result = triageData(null, { repo, minScore: maxScore, limit: 100 });
    // Only the highest-scoring item(s) should pass
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    for (const item of result.items) {
      expect(item.riskScore).toBeGreaterThanOrEqual(maxScore);
    }
  });

  test('noTests excludes test files', () => {
    const withTests = triageData(null, { repo, limit: 100 });
    const withoutTests = triageData(null, { repo, noTests: true, limit: 100 });
    const testItem = withTests.items.find((it) => it.file.includes('.test.'));
    const testItemFiltered = withoutTests.items.find((it) => it.file.includes('.test.'));
    expect(testItem).toBeDefined();
    expect(testItemFiltered).toBeUndefined();
  });

  test('sort by complexity', () => {
    const result = triageData(null, { repo, sort: 'complexity', limit: 100 });
    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].cognitive).toBeGreaterThanOrEqual(result.items[i].cognitive);
    }
  });

  test('sort by churn', () => {
    const result = triageData(null, { repo, sort: 'churn', limit: 100 });
    // InMemoryRepository returns churn=0 for all — verify no errors
    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].churn).toBeGreaterThanOrEqual(result.items[i].churn);
    }
  });

  test('sort by fan-in', () => {
    const result = triageData(null, { repo, sort: 'fan-in', limit: 100 });
    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].fanIn).toBeGreaterThanOrEqual(result.items[i].fanIn);
    }
  });

  test('sort by mi (ascending — lower MI = riskier)', () => {
    const result = triageData(null, { repo, sort: 'mi', limit: 100 });
    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].maintainabilityIndex).toBeLessThanOrEqual(
        result.items[i].maintainabilityIndex,
      );
    }
  });

  test('pagination with _pagination metadata', () => {
    const result = triageData(null, { repo, limit: 2, offset: 0 });
    expect(result.items.length).toBeLessThanOrEqual(2);
    expect(result._pagination).toBeDefined();
    expect(result._pagination.limit).toBe(2);
    expect(result._pagination.offset).toBe(0);
    expect(result._pagination.total).toBeGreaterThan(2);
    expect(result._pagination.hasMore).toBe(true);
  });

  test('pagination offset skips items', () => {
    const page1 = triageData(null, { repo, limit: 2, offset: 0 });
    const page2 = triageData(null, { repo, limit: 2, offset: 2 });
    expect(page1.items[0].name).not.toBe(page2.items[0].name);
  });

  test('summary contains expected fields', () => {
    const result = triageData(null, { repo, limit: 100 });
    const s = result.summary;
    expect(s.total).toBeGreaterThan(0);
    expect(s.analyzed).toBeGreaterThan(0);
    expect(s.avgScore).toBeGreaterThan(0);
    expect(s.maxScore).toBeGreaterThan(0);
    expect(s.weights).toEqual({
      fanIn: 0.25,
      complexity: 0.3,
      churn: 0.2,
      role: 0.15,
      mi: 0.1,
    });
    expect(s.signalCoverage).toBeDefined();
    expect(s.signalCoverage.complexity).toBeGreaterThan(0);
  });

  test('items include all expected fields', () => {
    const result = triageData(null, { repo, limit: 1 });
    const item = result.items[0];
    expect(item).toHaveProperty('name');
    expect(item).toHaveProperty('kind');
    expect(item).toHaveProperty('file');
    expect(item).toHaveProperty('line');
    expect(item).toHaveProperty('role');
    expect(item).toHaveProperty('fanIn');
    expect(item).toHaveProperty('cognitive');
    expect(item).toHaveProperty('churn');
    expect(item).toHaveProperty('maintainabilityIndex');
    expect(item).toHaveProperty('normFanIn');
    expect(item).toHaveProperty('normComplexity');
    expect(item).toHaveProperty('normChurn');
    expect(item).toHaveProperty('normMI');
    expect(item).toHaveProperty('roleWeight');
    expect(item).toHaveProperty('riskScore');
  });

  test('graceful with missing complexity/churn data', () => {
    // Create a repo with a node but no complexity
    const { repo: sparseRepo } = createTestRepo()
      .fn('lonely', 'src/lonely.js', 1, { role: 'leaf' })
      .build();

    const result = triageData(null, { repo: sparseRepo, limit: 100 });
    expect(result.items.length).toBe(1);
    expect(result.items[0].cognitive).toBe(0);
    expect(result.items[0].churn).toBe(0);
    expect(result.items[0].fanIn).toBe(0);
  });

  test('role weights applied correctly', () => {
    const result = triageData(null, {
      repo,
      limit: 100,
      // Only role matters
      weights: { fanIn: 0, complexity: 0, churn: 0, role: 1, mi: 0 },
    });
    const core = result.items.find((it) => it.role === 'core');
    const leaf = result.items.find((it) => it.role === 'leaf');
    expect(core.riskScore).toBeGreaterThan(leaf.riskScore);
    expect(core.roleWeight).toBe(1.0);
    expect(leaf.roleWeight).toBe(0.2);
  });
});
