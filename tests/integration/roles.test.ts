/**
 * Integration tests for node role classification.
 *
 * Uses the same fixture DB pattern as queries.test.js — a hand-crafted
 * in-file DB with known nodes and edges — then exercises rolesData,
 * statsData, whereData, explainData, and listFunctionsData to verify
 * roles appear in all expected outputs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import {
  explainData,
  listFunctionsData,
  rolesData,
  statsData,
  whereData,
} from '../../src/domain/queries.js';
import { classifyNodeRoles } from '../../src/features/structure.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function insertNode(db, name, kind, file, line) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind, confidence = 1.0) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, 0)',
  ).run(sourceId, targetId, kind, confidence);
}

// ─── Fixture DB ────────────────────────────────────────────────────────

let tmpDir: string, dbPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-roles-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // File nodes
  const fApp = insertNode(db, 'app.js', 'file', 'app.js', 0);
  const fLib = insertNode(db, 'lib.js', 'file', 'lib.js', 0);
  const fTest = insertNode(db, 'app.test.js', 'file', 'app.test.js', 0);

  // Function nodes
  const main = insertNode(db, 'main', 'function', 'app.js', 1);
  const process_ = insertNode(db, 'processData', 'function', 'app.js', 10);
  const helper = insertNode(db, 'helper', 'function', 'lib.js', 1);
  const format = insertNode(db, 'format', 'function', 'lib.js', 10);
  insertNode(db, 'unused', 'function', 'lib.js', 20);
  const testFn = insertNode(db, 'testMain', 'function', 'app.test.js', 1);

  // Import edges
  insertEdge(db, fApp, fLib, 'imports');
  insertEdge(db, fTest, fApp, 'imports');

  // Call edges:
  // main → processData (same file)
  // main → helper (cross-file) → makes helper exported
  // processData → format (cross-file) → makes format exported
  // helper → format (same file)
  // testFn → main (cross-file) → makes main exported
  insertEdge(db, main, process_, 'calls');
  insertEdge(db, main, helper, 'calls');
  insertEdge(db, process_, format, 'calls');
  insertEdge(db, helper, format, 'calls');
  insertEdge(db, testFn, main, 'calls');

  // unused has no callers and no cross-file callers → dead

  // Classify roles
  classifyNodeRoles(db);

  db.close();
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── rolesData ──────────────────────────────────────────────────────────

describe('rolesData', () => {
  test('returns all classified symbols with correct counts', () => {
    const data = rolesData(dbPath);
    expect(data.count).toBeGreaterThan(0);
    expect(data.summary).toBeDefined();
    expect(Object.keys(data.summary).length).toBeGreaterThan(0);
    // Every symbol should have a role
    for (const s of data.symbols) {
      expect(s.role).toBeTruthy();
    }
  });

  test('dead role includes unused function', () => {
    const data = rolesData(dbPath, { role: 'dead' });
    const names = data.symbols.map((s) => s.name);
    expect(names).toContain('unused');
  });

  test('filters by role (dead matches all sub-roles)', () => {
    const data = rolesData(dbPath, { role: 'dead' });
    for (const s of data.symbols) {
      expect(s.role).toMatch(/^dead/);
    }
  });

  test('filters by file', () => {
    const data = rolesData(dbPath, { file: 'lib.js' });
    for (const s of data.symbols) {
      expect(s.file).toContain('lib.js');
    }
  });

  test('filters by noTests', () => {
    const withTests = rolesData(dbPath);
    const withoutTests = rolesData(dbPath, { noTests: true });
    expect(withoutTests.count).toBeLessThan(withTests.count);
    for (const s of withoutTests.symbols) {
      expect(s.file).not.toMatch(/\.test\./);
    }
  });
});

// ─── statsData includes roles ───────────────────────────────────────────

describe('statsData with roles', () => {
  test('includes roles distribution', () => {
    const data = statsData(dbPath);
    expect(data.roles).toBeDefined();
    expect(Object.keys(data.roles).length).toBeGreaterThan(0);
    // Should have dead for the unused function
    expect(data.roles.dead).toBeGreaterThanOrEqual(1);
  });

  test('roles distribution respects noTests filter', () => {
    const withTests = statsData(dbPath);
    const withoutTests = statsData(dbPath, { noTests: true });
    const totalWith = Object.values(withTests.roles).reduce((a, b) => a + b, 0);
    const totalWithout = Object.values(withoutTests.roles).reduce((a, b) => a + b, 0);
    expect(totalWithout).toBeLessThanOrEqual(totalWith);
  });
});

// ─── whereData includes role ────────────────────────────────────────────

describe('whereData with roles', () => {
  test('includes role field in symbol results', () => {
    const data = whereData('main', dbPath);
    expect(data.results.length).toBeGreaterThan(0);
    const mainResult = data.results.find((r) => r.name === 'main');
    expect(mainResult).toBeDefined();
    expect(mainResult).toHaveProperty('role');
    expect(mainResult.role).toBeTruthy();
  });

  test('dead function has dead role', () => {
    const data = whereData('unused', dbPath);
    const unusedResult = data.results.find((r) => r.name === 'unused');
    expect(unusedResult).toBeDefined();
    expect(unusedResult.role).toMatch(/^dead/);
  });
});

// ─── explainData includes role ──────────────────────────────────────────

describe('explainData with roles', () => {
  test('function explain includes role field', () => {
    const data = explainData('main', dbPath);
    expect(data.results.length).toBeGreaterThan(0);
    const mainResult = data.results.find((r) => r.name === 'main');
    expect(mainResult).toBeDefined();
    expect(mainResult).toHaveProperty('role');
  });

  test('file explain includes role in symbols', () => {
    const data = explainData('lib.js', dbPath);
    expect(data.results.length).toBeGreaterThan(0);
    const fileResult = data.results[0];
    // Check publicApi and internal arrays for role field
    const allSymbols = [...(fileResult.publicApi || []), ...(fileResult.internal || [])];
    expect(allSymbols.length).toBeGreaterThan(0);
    for (const s of allSymbols) {
      expect(s).toHaveProperty('role');
    }
  });
});

// ─── listFunctionsData includes role ────────────────────────────────────

describe('listFunctionsData with roles', () => {
  test('includes role field in function listings', () => {
    const data = listFunctionsData(dbPath);
    expect(data.count).toBeGreaterThan(0);
    // At least some should have roles
    const withRoles = data.functions.filter((f) => f.role);
    expect(withRoles.length).toBeGreaterThan(0);
  });
});
