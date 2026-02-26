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
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { complexityData } from '../../src/complexity.js';
import { initSchema } from '../../src/db.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function insertNode(db, name, kind, file, line, endLine = null) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)')
    .run(name, kind, file, line, endLine).lastInsertRowid;
}

function insertComplexity(db, nodeId, cognitive, cyclomatic, maxNesting) {
  db.prepare(
    'INSERT INTO function_complexity (node_id, cognitive, cyclomatic, max_nesting) VALUES (?, ?, ?, ?)',
  ).run(nodeId, cognitive, cyclomatic, maxNesting);
}

// ─── Fixture DB ────────────────────────────────────────────────────────

let tmpDir, dbPath;

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

  // Insert complexity data
  insertComplexity(db, fn1, 0, 1, 0); // trivial
  insertComplexity(db, fn2, 18, 8, 4); // above cognitive warn
  insertComplexity(db, fn3, 12, 11, 3); // above cyclomatic warn
  insertComplexity(db, fn4, 25, 15, 5); // above all thresholds
  insertComplexity(db, fn5, 5, 3, 2); // test file

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
});
