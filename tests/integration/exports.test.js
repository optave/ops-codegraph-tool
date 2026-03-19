/**
 * Integration tests for the `exports` command (exportsData).
 *
 * Test graph:
 *
 *   Files: lib.js, app.js, barrel.js, lib.test.js
 *
 *   Symbols in lib.js: add (function, line 1), multiply (function, line 10),
 *                       helper (function, line 20), unusedFn (function, line 30)
 *   Symbols in app.js: main (function, line 1)
 *   Symbols in lib.test.js: testAdd (function, line 1)
 *
 *   Exported (exported=1): add, multiply, unusedFn
 *   Internal (not exported): helper
 *
 *   Call edges:
 *     main → add        (cross-file)
 *     main → multiply   (cross-file)
 *     add → helper      (same-file, internal)
 *     testAdd → add     (cross-file, from test)
 *
 *   Reexport edge:
 *     barrel.js → lib.js (kind: 'reexports')
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { exportsData } from '../../src/domain/queries.js';

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

let tmpDir, dbPath;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-exports-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // File nodes
  const fLib = insertNode(db, 'lib.js', 'file', 'lib.js', 0);
  const fApp = insertNode(db, 'app.js', 'file', 'app.js', 0);
  const fBarrel = insertNode(db, 'barrel.js', 'file', 'barrel.js', 0);
  const fTest = insertNode(db, 'lib.test.js', 'file', 'lib.test.js', 0);

  // Function nodes in lib.js
  const add = insertNode(db, 'add', 'function', 'lib.js', 1);
  const multiply = insertNode(db, 'multiply', 'function', 'lib.js', 10);
  const helper = insertNode(db, 'helper', 'function', 'lib.js', 20);
  const unusedFn = insertNode(db, 'unusedFn', 'function', 'lib.js', 30);

  // Function nodes in app.js
  const main = insertNode(db, 'main', 'function', 'app.js', 1);

  // Function nodes in lib.test.js
  const testAdd = insertNode(db, 'testAdd', 'function', 'lib.test.js', 1);

  // Mark exported symbols (add, multiply, unusedFn are exported; helper is not)
  const markExported = db.prepare('UPDATE nodes SET exported = 1 WHERE id = ?');
  markExported.run(add);
  markExported.run(multiply);
  markExported.run(unusedFn);

  // Import edges
  insertEdge(db, fApp, fLib, 'imports');
  insertEdge(db, fTest, fLib, 'imports');

  // Call edges
  insertEdge(db, main, add, 'calls'); // cross-file: app.js → lib.js
  insertEdge(db, main, multiply, 'calls'); // cross-file: app.js → lib.js
  insertEdge(db, add, helper, 'calls'); // same-file: lib.js internal
  insertEdge(db, testAdd, add, 'calls'); // cross-file: test → lib.js

  // Reexport edge: barrel.js re-exports lib.js
  insertEdge(db, fBarrel, fLib, 'reexports');

  db.close();
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────────────────

describe('exportsData', () => {
  test('returns exported symbols with consumers', () => {
    const data = exportsData('lib.js', dbPath);
    expect(data.file).toBe('lib.js');
    expect(data.results.length).toBe(3); // add, multiply, unusedFn

    const addExport = data.results.find((r) => r.name === 'add');
    expect(addExport).toBeDefined();
    expect(addExport.kind).toBe('function');
    expect(addExport.line).toBe(1);
    // main and testAdd both call add from other files
    expect(addExport.consumers.length).toBe(2);
    expect(addExport.consumers.map((c) => c.name).sort()).toEqual(['main', 'testAdd']);

    const mulExport = data.results.find((r) => r.name === 'multiply');
    expect(mulExport).toBeDefined();
    expect(mulExport.consumers.length).toBe(1);
    expect(mulExport.consumers[0].name).toBe('main');

    const unusedExport = data.results.find((r) => r.name === 'unusedFn');
    expect(unusedExport).toBeDefined();
    expect(unusedExport.consumers.length).toBe(0);
    expect(unusedExport.consumerCount).toBe(0);

    // helper is internal (not marked exported)
    const helperExport = data.results.find((r) => r.name === 'helper');
    expect(helperExport).toBeUndefined();
  });

  test('totalExported and totalInternal counts', () => {
    const data = exportsData('lib.js', dbPath);
    expect(data.totalExported).toBe(3); // add, multiply, unusedFn
    expect(data.totalInternal).toBe(1); // helper
  });

  test('reexports detected', () => {
    const data = exportsData('lib.js', dbPath);
    expect(data.reexports.length).toBe(1);
    expect(data.reexports[0].file).toBe('barrel.js');
  });

  test('noTests filters test consumers', () => {
    const data = exportsData('lib.js', dbPath, { noTests: true });
    const addExport = data.results.find((r) => r.name === 'add');
    expect(addExport).toBeDefined();
    // testAdd from lib.test.js should be filtered out
    expect(addExport.consumers.length).toBe(1);
    expect(addExport.consumers[0].name).toBe('main');
    expect(addExport.consumerCount).toBe(1);
  });

  test('empty result for unknown file', () => {
    const data = exportsData('nonexistent.js', dbPath);
    expect(data.results).toEqual([]);
    expect(data.totalExported).toBe(0);
    expect(data.totalInternal).toBe(0);
    expect(data.totalUnused).toBe(0);
  });

  test('pagination works', () => {
    const data = exportsData('lib.js', dbPath, { limit: 1 });
    expect(data.results.length).toBe(1);
    expect(data._pagination).toBeDefined();
    expect(data._pagination.total).toBe(3);
    expect(data._pagination.hasMore).toBe(true);
    expect(data._pagination.returned).toBe(1);
  });

  test('totalUnused is always present', () => {
    const data = exportsData('lib.js', dbPath);
    expect(data.totalUnused).toBe(1); // unusedFn has zero consumers
  });

  test('--unused filters to zero-consumer exports', () => {
    const data = exportsData('lib.js', dbPath, { unused: true });
    expect(data.results.length).toBe(1);
    expect(data.results[0].name).toBe('unusedFn');
    expect(data.results[0].consumerCount).toBe(0);
    // totalExported still reflects all exports
    expect(data.totalExported).toBe(3);
    expect(data.totalUnused).toBe(1);
  });

  test('--unused returns empty when all exports have consumers', () => {
    const data = exportsData('app.js', dbPath, { unused: true });
    expect(data.results).toEqual([]);
  });

  test('--unused with pagination', () => {
    const data = exportsData('lib.js', dbPath, { unused: true, limit: 1 });
    expect(data.results.length).toBe(1);
    expect(data._pagination).toBeDefined();
    expect(data._pagination.total).toBe(1);
    expect(data._pagination.hasMore).toBe(false);
  });

  test('barrel file shows re-exported symbols from target modules', () => {
    const data = exportsData('barrel.js', dbPath);
    expect(data.file).toBe('barrel.js');
    // barrel.js has no own exports
    expect(data.results).toEqual([]);
    expect(data.totalExported).toBe(0);
    // but it surfaces re-exported symbols from lib.js
    expect(data.reexportedSymbols.length).toBe(3); // add, multiply, unusedFn
    const names = data.reexportedSymbols.map((s) => s.name).sort();
    expect(names).toEqual(['add', 'multiply', 'unusedFn']);
    // each re-exported symbol has originFile
    for (const sym of data.reexportedSymbols) {
      expect(sym.originFile).toBe('lib.js');
    }
    // consumer info is preserved
    const addSym = data.reexportedSymbols.find((s) => s.name === 'add');
    expect(addSym.consumerCount).toBe(2);
  });

  test('barrel file --unused filters re-exported symbols', () => {
    const data = exportsData('barrel.js', dbPath, { unused: true });
    expect(data.results).toEqual([]);
    expect(data.reexportedSymbols.length).toBe(1);
    expect(data.reexportedSymbols[0].name).toBe('unusedFn');
    expect(data.reexportedSymbols[0].consumerCount).toBe(0);
  });

  test('reexportedSymbols is empty array for non-barrel files', () => {
    const data = exportsData('lib.js', dbPath);
    expect(data.reexportedSymbols).toEqual([]);
  });
});
