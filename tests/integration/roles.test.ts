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

// ─── Barrel re-export role classification (#837) ──────────────────────

describe('barrel re-export role classification', () => {
  let barrelTmpDir: string, barrelDbPath: string;

  beforeAll(() => {
    barrelTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-barrel-roles-'));
    fs.mkdirSync(path.join(barrelTmpDir, '.codegraph'));
    barrelDbPath = path.join(barrelTmpDir, '.codegraph', 'graph.db');

    const db = new Database(barrelDbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);

    // File nodes
    const fInspect = insertNode(db, 'src/inspect.ts', 'file', 'src/inspect.ts', 0);
    const fBarrel = insertNode(db, 'src/index.ts', 'file', 'src/index.ts', 0);
    const fConsumer = insertNode(db, 'src/app.ts', 'file', 'src/app.ts', 0);
    const fTest = insertNode(db, 'tests/inspect.test.ts', 'file', 'tests/inspect.test.ts', 0);

    // Symbol nodes
    const queryName = insertNode(db, 'queryName', 'function', 'src/inspect.ts', 10);
    const helperFn = insertNode(db, 'helperFn', 'function', 'src/inspect.ts', 30);
    const appMain = insertNode(db, 'appMain', 'function', 'src/app.ts', 1);
    const testFn = insertNode(db, 'testQueryName', 'function', 'tests/inspect.test.ts', 1);

    // Barrel re-exports inspect.ts
    insertEdge(db, fBarrel, fInspect, 'reexports');
    // Consumer imports from barrel
    insertEdge(db, fConsumer, fBarrel, 'imports');
    // Test file imports from inspect directly
    insertEdge(db, fTest, fInspect, 'imports');

    // Only test code calls queryName — no production calls edges
    insertEdge(db, testFn, queryName, 'calls');

    // helperFn has no callers at all — truly dead
    // appMain has no callers — but is in a production file

    classifyNodeRoles(db);
    db.close();
  });

  afterAll(() => {
    if (barrelTmpDir) fs.rmSync(barrelTmpDir, { recursive: true, force: true });
  });

  test('symbol consumed via barrel re-export is classified as entry, not dead', () => {
    const data = rolesData(barrelDbPath);
    const queryNameResult = data.symbols.find((s) => s.name === 'queryName');
    expect(queryNameResult).toBeDefined();
    // queryName is in a file re-exported by a barrel with production importers
    // → isExported = true, fanIn > 0 from test → falls through to median-based
    //   classification (core/utility/leaf), NOT test-only or dead
    expect(queryNameResult!.role).not.toMatch(/^dead/);
    expect(queryNameResult!.role).not.toBe('test-only');
  });

  test('symbol in re-exported file with no callers is classified as entry (part of exported API)', () => {
    const data = rolesData(barrelDbPath);
    const helperResult = data.symbols.find((s) => s.name === 'helperFn');
    expect(helperResult).toBeDefined();
    // helperFn has 0 callers — but it's in a re-exported file, so isExported = true
    // With fanIn=0 and isExported=true → entry (exported but uncalled)
    expect(helperResult!.role).toBe('entry');
  });
});

// ─── Multi-level barrel re-export chain (#837) ───────────────────────

describe('multi-level barrel re-export chain', () => {
  let chainTmpDir: string, chainDbPath: string;

  beforeAll(() => {
    chainTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-chain-roles-'));
    fs.mkdirSync(path.join(chainTmpDir, '.codegraph'));
    chainDbPath = path.join(chainTmpDir, '.codegraph', 'graph.db');

    const db = new Database(chainDbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);

    // Chain: inspect.ts → index.ts (barrel) → queries-cli.ts (barrel) → query.ts (consumer)
    const fInspect = insertNode(
      db,
      'src/queries-cli/inspect.ts',
      'file',
      'src/queries-cli/inspect.ts',
      0,
    );
    const fIndex = insertNode(
      db,
      'src/queries-cli/index.ts',
      'file',
      'src/queries-cli/index.ts',
      0,
    );
    const fQueriesCli = insertNode(db, 'src/queries-cli.ts', 'file', 'src/queries-cli.ts', 0);
    const fQuery = insertNode(db, 'src/query.ts', 'file', 'src/query.ts', 0);

    const queryName = insertNode(db, 'queryName', 'function', 'src/queries-cli/inspect.ts', 10);
    insertNode(db, 'queryCmd', 'function', 'src/query.ts', 1);

    // Barrel chain: each barrel re-exports from the one below
    insertEdge(db, fIndex, fInspect, 'reexports');
    insertEdge(db, fQueriesCli, fIndex, 'reexports');
    // Consumer imports from the top-level barrel
    insertEdge(db, fQuery, fQueriesCli, 'imports');

    // No calls edges to queryName at all
    classifyNodeRoles(db);
    db.close();
  });

  afterAll(() => {
    if (chainTmpDir) fs.rmSync(chainTmpDir, { recursive: true, force: true });
  });

  test('symbol at bottom of multi-level barrel chain is classified as entry', () => {
    const data = rolesData(chainDbPath);
    const queryNameResult = data.symbols.find((s) => s.name === 'queryName');
    expect(queryNameResult).toBeDefined();
    // 3-level deep re-export chain: inspect → index → queries-cli → query (consumer)
    // Should still be recognized as exported
    expect(queryNameResult!.role).toBe('entry');
  });
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
