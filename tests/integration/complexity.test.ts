/**
 * Integration tests for complexity metrics.
 *
 * End-to-end: build graph from fixture → verify complexity stored →
 * verify complexityData() returns correct results.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { complexityData } from '../../src/features/complexity.js';
import { loadConfig } from '../../src/infrastructure/config.js';

vi.mock('../../src/infrastructure/config.js', () => ({
  loadConfig: vi.fn(() => ({})),
}));

// ─── Helpers ───────────────────────────────────────────────────────────

function insertNode(db, name, kind, file, line, endLine = null) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)')
    .run(name, kind, file, line, endLine).lastInsertRowid;
}

function insertComplexity(
  db,
  nodeId,
  cognitive,
  cyclomatic,
  maxNesting,
  {
    loc = 10,
    sloc = 8,
    commentLines = 1,
    volume = 100,
    difficulty = 5,
    effort = 500,
    bugs = 0.03,
    mi = 60,
  } = {},
) {
  db.prepare(
    `INSERT INTO function_complexity
     (node_id, cognitive, cyclomatic, max_nesting,
      loc, sloc, comment_lines,
      halstead_n1, halstead_n2, halstead_big_n1, halstead_big_n2,
      halstead_vocabulary, halstead_length, halstead_volume,
      halstead_difficulty, halstead_effort, halstead_bugs,
      maintainability_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nodeId,
    cognitive,
    cyclomatic,
    maxNesting,
    loc,
    sloc,
    commentLines,
    10,
    15,
    30,
    40,
    25,
    70,
    volume,
    difficulty,
    effort,
    bugs,
    mi,
  );
}

// ─── Fixture DB ────────────────────────────────────────────────────────

let tmpDir: string, dbPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-complexity-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // Function nodes with varying complexity
  const fn1 = insertNode(db, 'simpleAdd', 'function', 'src/math.js', 1, 3);
  const fn2 = insertNode(db, 'processItems', 'function', 'src/processor.js', 5, 40);
  const fn3 = insertNode(db, 'validateInput', 'function', 'src/validator.js', 1, 20);
  const fn4 = insertNode(db, 'handleRequest', 'method', 'src/handler.js', 10, 50);
  const fn5 = insertNode(db, 'testHelper', 'function', 'tests/helper.test.js', 1, 10);

  // Insert complexity data with health metrics
  insertComplexity(db, fn1, 0, 1, 0, {
    loc: 3,
    sloc: 2,
    volume: 20,
    difficulty: 1,
    effort: 20,
    bugs: 0.007,
    mi: 90,
  });
  insertComplexity(db, fn2, 18, 8, 4, {
    loc: 35,
    sloc: 28,
    volume: 800,
    difficulty: 15,
    effort: 12000,
    bugs: 0.27,
    mi: 35,
  });
  insertComplexity(db, fn3, 12, 11, 3, {
    loc: 20,
    sloc: 16,
    volume: 500,
    difficulty: 10,
    effort: 5000,
    bugs: 0.17,
    mi: 45,
  });
  insertComplexity(db, fn4, 25, 15, 5, {
    loc: 40,
    sloc: 32,
    volume: 1500,
    difficulty: 25,
    effort: 37500,
    bugs: 0.5,
    mi: 15,
  });
  insertComplexity(db, fn5, 5, 3, 2, {
    loc: 10,
    sloc: 8,
    volume: 100,
    difficulty: 5,
    effort: 500,
    bugs: 0.03,
    mi: 65,
  });

  db.close();
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────────────────

describe('complexityData', () => {
  test('returns all functions sorted by cognitive (default)', () => {
    const data = complexityData(dbPath);
    expect(data.functions.length).toBeGreaterThanOrEqual(4);
    // Default sort: cognitive DESC
    expect(data.functions[0].name).toBe('handleRequest');
    expect(data.functions[0].cognitive).toBe(25);
    expect(data.functions[1].name).toBe('processItems');
  });

  test('returns summary stats', () => {
    const data = complexityData(dbPath);
    expect(data.summary).not.toBeNull();
    expect(data.summary.analyzed).toBeGreaterThanOrEqual(4);
    expect(data.summary.avgCognitive).toBeGreaterThan(0);
    expect(data.summary.maxCognitive).toBe(25);
  });

  test('returns thresholds from config', () => {
    const data = complexityData(dbPath);
    expect(data.thresholds).toBeDefined();
    expect(data.thresholds.cognitive).toBeDefined();
    expect(data.thresholds.cyclomatic).toBeDefined();
    expect(data.thresholds.maxNesting).toBeDefined();
  });

  test('filters by target name', () => {
    const data = complexityData(dbPath, { target: 'validate' });
    expect(data.functions.length).toBe(1);
    expect(data.functions[0].name).toBe('validateInput');
  });

  test('filters by file', () => {
    const data = complexityData(dbPath, { file: 'handler' });
    expect(data.functions.length).toBe(1);
    expect(data.functions[0].name).toBe('handleRequest');
  });

  test('filters by kind', () => {
    const data = complexityData(dbPath, { kind: 'method' });
    expect(data.functions.length).toBe(1);
    expect(data.functions[0].kind).toBe('method');
  });

  test('sort by cyclomatic', () => {
    const data = complexityData(dbPath, { sort: 'cyclomatic' });
    expect(data.functions[0].cyclomatic).toBeGreaterThanOrEqual(data.functions[1].cyclomatic);
  });

  test('sort by nesting', () => {
    const data = complexityData(dbPath, { sort: 'nesting' });
    expect(data.functions[0].maxNesting).toBeGreaterThanOrEqual(data.functions[1].maxNesting);
  });

  test('limit results', () => {
    const data = complexityData(dbPath, { limit: 2 });
    expect(data.functions.length).toBeLessThanOrEqual(2);
  });

  test('noTests excludes test files', () => {
    const data = complexityData(dbPath, { noTests: true });
    for (const fn of data.functions) {
      expect(fn.file).not.toMatch(/\.test\./);
    }
  });

  test('aboveThreshold only returns functions exceeding warn', () => {
    const data = complexityData(dbPath, { aboveThreshold: true });
    // simpleAdd (0,1,0) should be excluded
    const names = data.functions.map((f) => f.name);
    expect(names).not.toContain('simpleAdd');
    // handleRequest (25,15,5) should be included
    expect(names).toContain('handleRequest');
  });

  test('exceeds field marks threshold violations', () => {
    const data = complexityData(dbPath);
    const handler = data.functions.find((f) => f.name === 'handleRequest');
    expect(handler.exceeds).toBeDefined();
    expect(handler.exceeds).toContain('cognitive');
    expect(handler.exceeds).toContain('cyclomatic');
    expect(handler.exceeds).toContain('maxNesting');

    const simple = data.functions.find((f) => f.name === 'simpleAdd');
    expect(simple.exceeds).toBeUndefined();
  });

  test('empty result when no matches', () => {
    const data = complexityData(dbPath, { target: 'nonexistent_xyz' });
    expect(data.functions.length).toBe(0);
  });

  test('produces correct exceeds and aboveWarn with valid thresholds', () => {
    const data = complexityData(dbPath);
    expect(data.summary.aboveWarn).toBeGreaterThan(0);
    const handleReq = data.functions.find((f) => f.name === 'handleRequest');
    expect(handleReq.exceeds).toBeDefined();
    expect(handleReq.exceeds.length).toBeGreaterThan(0);
  });

  // ─── Halstead / MI Tests ─────────────────────────────────────────────

  test('functions include halstead and MI data', () => {
    const data = complexityData(dbPath);
    const fn = data.functions.find((f) => f.name === 'processItems');
    expect(fn.maintainabilityIndex).toBe(35);
    expect(fn.loc).toBe(35);
    expect(fn.sloc).toBe(28);
    expect(fn.halstead).toBeDefined();
    expect(fn.halstead.volume).toBe(800);
    expect(fn.halstead.difficulty).toBe(15);
    expect(fn.halstead.effort).toBe(12000);
    expect(fn.halstead.bugs).toBe(0.27);
  });

  test('sort by mi (ascending — worst first)', () => {
    const data = complexityData(dbPath, { sort: 'mi' });
    expect(data.functions.length).toBeGreaterThanOrEqual(2);
    // MI ascending: lowest MI first
    expect(data.functions[0].maintainabilityIndex).toBeLessThanOrEqual(
      data.functions[1].maintainabilityIndex,
    );
  });

  test('sort by volume (descending)', () => {
    const data = complexityData(dbPath, { sort: 'volume' });
    expect(data.functions[0].halstead.volume).toBeGreaterThanOrEqual(
      data.functions[1].halstead.volume,
    );
  });

  test('sort by effort (descending)', () => {
    const data = complexityData(dbPath, { sort: 'effort' });
    expect(data.functions[0].halstead.effort).toBeGreaterThanOrEqual(
      data.functions[1].halstead.effort,
    );
  });

  test('sort by bugs (descending)', () => {
    const data = complexityData(dbPath, { sort: 'bugs' });
    expect(data.functions[0].halstead.bugs).toBeGreaterThanOrEqual(data.functions[1].halstead.bugs);
  });

  test('sort by loc (descending)', () => {
    const data = complexityData(dbPath, { sort: 'loc' });
    expect(data.functions[0].loc).toBeGreaterThanOrEqual(data.functions[1].loc);
  });

  test('aboveThreshold considers MI threshold', () => {
    const data = complexityData(dbPath, { aboveThreshold: true });
    const names = data.functions.map((f) => f.name);
    // handleRequest has MI=15, below warn=20 → should be included
    expect(names).toContain('handleRequest');
  });

  test('exceeds includes maintainabilityIndex for low-MI functions', () => {
    const data = complexityData(dbPath);
    const handler = data.functions.find((f) => f.name === 'handleRequest');
    expect(handler.exceeds).toContain('maintainabilityIndex');

    const simple = data.functions.find((f) => f.name === 'simpleAdd');
    expect(simple.exceeds).toBeUndefined();
  });

  test('summary includes avgMI and minMI', () => {
    const data = complexityData(dbPath);
    expect(data.summary.avgMI).toBeDefined();
    expect(data.summary.minMI).toBeDefined();
    expect(data.summary.avgMI).toBeGreaterThan(0);
    expect(data.summary.minMI).toBeLessThanOrEqual(data.summary.avgMI);
  });

  test('JSON output contains halstead object', () => {
    const data = complexityData(dbPath);
    for (const fn of data.functions) {
      expect(fn.halstead).toBeDefined();
      expect(typeof fn.halstead.volume).toBe('number');
      expect(typeof fn.halstead.difficulty).toBe('number');
      expect(typeof fn.halstead.effort).toBe('number');
      expect(typeof fn.halstead.bugs).toBe('number');
      expect(typeof fn.maintainabilityIndex).toBe('number');
    }
  });

  // ─── Threshold sanitization (regression) ────────────────────────────

  test('non-numeric threshold values do not crash SQL query', () => {
    vi.mocked(loadConfig).mockReturnValueOnce({
      manifesto: {
        rules: {
          cognitive: { warn: 'abc' },
          cyclomatic: { warn: '123xyz' },
          maxNesting: { warn: undefined },
        },
      },
    });
    // Should not throw — invalid thresholds are silently skipped
    const data = complexityData(dbPath, { aboveThreshold: true });
    expect(data.functions).toBeDefined();
    expect(Array.isArray(data.functions)).toBe(true);
    // With all thresholds invalid, no filtering occurs — all functions returned
    expect(data.functions.length).toBeGreaterThanOrEqual(4);
    expect(data.summary.aboveWarn).toBe(0);
    // No function should have exceeds when all thresholds are invalid
    for (const fn of data.functions) {
      expect(fn.exceeds).toBeUndefined();
    }
  });

  test('string-numeric thresholds are rejected (strict type check)', () => {
    vi.mocked(loadConfig).mockReturnValueOnce({
      manifesto: {
        rules: {
          cognitive: { warn: '15' },
          cyclomatic: { warn: '10' },
          maxNesting: { warn: '4' },
        },
      },
    });
    const data = complexityData(dbPath, { aboveThreshold: true });
    // String thresholds fail typeof === 'number' — treated as no threshold
    // so all functions are returned (no HAVING filter applied)
    expect(data.functions.length).toBeGreaterThanOrEqual(4);
    expect(data.summary.aboveWarn).toBe(0);
    // No exceeds when thresholds are strings
    for (const fn of data.functions) {
      expect(fn.exceeds).toBeUndefined();
    }
  });
});
