/**
 * Integration tests for triage — composite risk audit queue.
 *
 * Uses a hand-crafted fixture DB with known nodes, edges,
 * function_complexity, and file_commit_counts rows.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { triageData } from '../../src/triage.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function insertNode(db, name, kind, file, line, { endLine = null, role = null } = {}) {
  const stmt = db.prepare(
    'INSERT INTO nodes (name, kind, file, line, end_line, role) VALUES (?, ?, ?, ?, ?, ?)',
  );
  return stmt.run(name, kind, file, line, endLine, role).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind = 'calls') {
  db.prepare('INSERT INTO edges (source_id, target_id, kind) VALUES (?, ?, ?)').run(
    sourceId,
    targetId,
    kind,
  );
}

function insertComplexity(db, nodeId, cognitive, cyclomatic, maxNesting, mi = 60) {
  db.prepare(
    `INSERT INTO function_complexity
     (node_id, cognitive, cyclomatic, max_nesting,
      loc, sloc, comment_lines,
      halstead_n1, halstead_n2, halstead_big_n1, halstead_big_n2,
      halstead_vocabulary, halstead_length, halstead_volume,
      halstead_difficulty, halstead_effort, halstead_bugs,
      maintainability_index)
     VALUES (?, ?, ?, ?, 10, 8, 1, 10, 15, 30, 40, 25, 70, 100, 5, 500, 0.03, ?)`,
  ).run(nodeId, cognitive, cyclomatic, maxNesting, mi);
}

function insertChurn(db, file, commitCount) {
  db.prepare('INSERT OR REPLACE INTO file_commit_counts (file, commit_count) VALUES (?, ?)').run(
    file,
    commitCount,
  );
}

// ─── Fixture DB ────────────────────────────────────────────────────────

let tmpDir, dbPath;

// Node IDs
let fnHigh, fnMed, fnLow, fnTest, fnClass;

beforeAll(async () => {
  const { initSchema } = await import('../../src/db.js');

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-triage-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // High-risk: core role, high fan-in, high complexity, high churn, low MI
  fnHigh = insertNode(db, 'processRequest', 'function', 'src/handler.js', 10, { role: 'core' });
  // Medium-risk: utility role, moderate signals
  fnMed = insertNode(db, 'formatOutput', 'function', 'src/formatter.js', 1, { role: 'utility' });
  // Low-risk: leaf role, minimal signals
  fnLow = insertNode(db, 'add', 'function', 'src/math.js', 1, { role: 'leaf' });
  // Test file: should be excluded with noTests
  fnTest = insertNode(db, 'testHelper', 'function', 'tests/helper.test.js', 1, { role: 'utility' });
  // Class node
  fnClass = insertNode(db, 'Router', 'class', 'src/router.js', 1, { role: 'entry' });

  // Edges: processRequest has fan_in=3, formatOutput=1, add=0
  const caller1 = insertNode(db, 'caller1', 'function', 'src/a.js', 1);
  const caller2 = insertNode(db, 'caller2', 'function', 'src/b.js', 1);
  const caller3 = insertNode(db, 'caller3', 'function', 'src/c.js', 1);
  insertEdge(db, caller1, fnHigh);
  insertEdge(db, caller2, fnHigh);
  insertEdge(db, caller3, fnHigh);
  insertEdge(db, caller1, fnMed);

  // Complexity
  insertComplexity(db, fnHigh, 30, 15, 5, 20); // high cognitive, low MI
  insertComplexity(db, fnMed, 10, 5, 2, 60);
  insertComplexity(db, fnLow, 1, 1, 0, 90); // simple, high MI
  insertComplexity(db, fnTest, 5, 3, 1, 70);
  insertComplexity(db, fnClass, 15, 8, 3, 40);

  // Churn (file-level)
  insertChurn(db, 'src/handler.js', 50);
  insertChurn(db, 'src/formatter.js', 20);
  insertChurn(db, 'src/math.js', 2);
  insertChurn(db, 'tests/helper.test.js', 10);
  insertChurn(db, 'src/router.js', 30);

  db.close();
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────────────────

describe('triage', () => {
  test('ranks symbols by composite risk score (default sort)', () => {
    const result = triageData(dbPath, { limit: 100 });
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
    const result = triageData(dbPath, { limit: 100 });
    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].riskScore).toBeGreaterThanOrEqual(result.items[i].riskScore);
    }
  });

  test('normalization: max fan_in → normFanIn=1.0', () => {
    const result = triageData(dbPath, { limit: 100 });
    const high = result.items.find((it) => it.name === 'processRequest');
    expect(high.normFanIn).toBe(1);
  });

  test('normalization: min cognitive → normComplexity=0.0', () => {
    // callers have cognitive=0 (no complexity row), so add (cognitive=1) is not the min.
    // Filter to only nodes with complexity data to test properly.
    const result = triageData(dbPath, { file: 'src/math', limit: 100 });
    const low = result.items.find((it) => it.name === 'add');
    // Single item → all norms are 0
    expect(low.normComplexity).toBe(0);
  });

  test('custom weights override ranking', () => {
    // Pure fan-in ranking: only fan_in matters
    const result = triageData(dbPath, {
      limit: 100,
      weights: { fanIn: 1, complexity: 0, churn: 0, role: 0, mi: 0 },
    });
    // processRequest has fan_in=3 (highest)
    expect(result.items[0].name).toBe('processRequest');
    // formatOutput has fan_in=1
    expect(result.items[1].name).toBe('formatOutput');
  });

  test('filters by file', () => {
    const result = triageData(dbPath, { file: 'handler', limit: 100 });
    expect(result.items.length).toBe(1);
    expect(result.items[0].name).toBe('processRequest');
  });

  test('filters by kind', () => {
    const result = triageData(dbPath, { kind: 'class', limit: 100 });
    expect(result.items.length).toBe(1);
    expect(result.items[0].name).toBe('Router');
  });

  test('filters by role', () => {
    const result = triageData(dbPath, { role: 'core', limit: 100 });
    expect(result.items.length).toBe(1);
    expect(result.items[0].name).toBe('processRequest');
  });

  test('filters by minScore', () => {
    const all = triageData(dbPath, { limit: 100 });
    const maxScore = all.items[0].riskScore;
    const result = triageData(dbPath, { minScore: maxScore, limit: 100 });
    // Only the highest-scoring item(s) should pass
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    for (const item of result.items) {
      expect(item.riskScore).toBeGreaterThanOrEqual(maxScore);
    }
  });

  test('noTests excludes test files', () => {
    const withTests = triageData(dbPath, { limit: 100 });
    const withoutTests = triageData(dbPath, { noTests: true, limit: 100 });
    const testItem = withTests.items.find((it) => it.file.includes('.test.'));
    const testItemFiltered = withoutTests.items.find((it) => it.file.includes('.test.'));
    expect(testItem).toBeDefined();
    expect(testItemFiltered).toBeUndefined();
  });

  test('sort by complexity', () => {
    const result = triageData(dbPath, { sort: 'complexity', limit: 100 });
    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].cognitive).toBeGreaterThanOrEqual(result.items[i].cognitive);
    }
  });

  test('sort by churn', () => {
    const result = triageData(dbPath, { sort: 'churn', limit: 100 });
    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].churn).toBeGreaterThanOrEqual(result.items[i].churn);
    }
  });

  test('sort by fan-in', () => {
    const result = triageData(dbPath, { sort: 'fan-in', limit: 100 });
    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].fanIn).toBeGreaterThanOrEqual(result.items[i].fanIn);
    }
  });

  test('sort by mi (ascending — lower MI = riskier)', () => {
    const result = triageData(dbPath, { sort: 'mi', limit: 100 });
    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].maintainabilityIndex).toBeLessThanOrEqual(
        result.items[i].maintainabilityIndex,
      );
    }
  });

  test('pagination with _pagination metadata', () => {
    const result = triageData(dbPath, { limit: 2, offset: 0 });
    expect(result.items.length).toBeLessThanOrEqual(2);
    expect(result._pagination).toBeDefined();
    expect(result._pagination.limit).toBe(2);
    expect(result._pagination.offset).toBe(0);
    expect(result._pagination.total).toBeGreaterThan(2);
    expect(result._pagination.hasMore).toBe(true);
  });

  test('pagination offset skips items', () => {
    const page1 = triageData(dbPath, { limit: 2, offset: 0 });
    const page2 = triageData(dbPath, { limit: 2, offset: 2 });
    expect(page1.items[0].name).not.toBe(page2.items[0].name);
  });

  test('summary contains expected fields', () => {
    const result = triageData(dbPath, { limit: 100 });
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
    const result = triageData(dbPath, { limit: 1 });
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

  test('graceful with missing complexity/churn data', async () => {
    // Create a DB with a node but no complexity or churn rows
    const sparseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-triage-sparse-'));
    fs.mkdirSync(path.join(sparseDir, '.codegraph'));
    const sparseDbPath = path.join(sparseDir, '.codegraph', 'graph.db');

    const { initSchema } = await import('../../src/db.js');
    const db = new Database(sparseDbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    insertNode(db, 'lonely', 'function', 'src/lonely.js', 1, { role: 'leaf' });
    db.close();

    // Should not throw
    const result = triageData(sparseDbPath, { limit: 100 });
    expect(result.items.length).toBe(1);
    expect(result.items[0].cognitive).toBe(0);
    expect(result.items[0].churn).toBe(0);
    expect(result.items[0].fanIn).toBe(0);

    fs.rmSync(sparseDir, { recursive: true, force: true });
  });

  test('role weights applied correctly', () => {
    const result = triageData(dbPath, {
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
