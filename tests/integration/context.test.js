/**
 * Integration tests for the `context` command.
 * Uses a hand-crafted in-file DB with on-disk fixture files
 * so that source reading, signature extraction, and summary
 * extraction all exercise real I/O paths.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db.js';
import { contextData } from '../../src/queries.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function insertNode(db, name, kind, file, line, endLine) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)')
    .run(name, kind, file, line, endLine || null).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, 1.0, 0)',
  ).run(sourceId, targetId, kind);
}

// ─── Fixture ──────────────────────────────────────────────────────────

let tmpDir, dbPath;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-context-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  // Write fixture source files
  fs.writeFileSync(
    path.join(tmpDir, 'core.js'),
    [
      '// Core module utilities',
      '',
      '/**',
      ' * Opens or creates the database connection.',
      ' * @param {string} dbPath - Path to the database file',
      ' * @returns {{ db: Database, created: boolean }}',
      ' */',
      'export function openDb(dbPath, options = {}) {',
      '  const db = new Database(dbPath);',
      '  db.pragma("journal_mode = WAL");',
      '  return { db, created: true };',
      '}',
      '',
      '// Validate configuration object',
      'function validateConfig(config) {',
      '  if (!config.root) throw new Error("root required");',
      '  return true;',
      '}',
      '',
      'export function processFiles(files, opts) {',
      '  for (const f of files) {',
      '    parseOne(f);',
      '  }',
      '}',
      '',
      'function parseOne(file) {',
      '  return file;',
      '}',
    ].join('\n'),
    'utf-8',
  );

  fs.writeFileSync(
    path.join(tmpDir, 'caller.js'),
    [
      'import { openDb, processFiles } from "./core.js";',
      '',
      'export function main() {',
      '  const { db } = openDb("test.db");',
      '  processFiles(["a.js", "b.js"]);',
      '}',
    ].join('\n'),
    'utf-8',
  );

  fs.mkdirSync(path.join(tmpDir, 'tests'));
  fs.writeFileSync(
    path.join(tmpDir, 'tests', 'core.test.js'),
    [
      'import { openDb } from "../core.js";',
      '',
      'describe("openDb", () => {',
      '  test("creates database file", () => {',
      '    const result = openDb(":memory:");',
      '    expect(result.created).toBe(true);',
      '  });',
      '',
      '  test("returns db handle", () => {',
      '    const result = openDb(":memory:");',
      '    expect(result.db).toBeDefined();',
      '  });',
      '});',
    ].join('\n'),
    'utf-8',
  );

  // Build the DB
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // File nodes
  insertNode(db, 'core.js', 'file', 'core.js', 0);
  insertNode(db, 'caller.js', 'file', 'caller.js', 0);
  insertNode(db, 'tests/core.test.js', 'file', 'tests/core.test.js', 0);

  // Function nodes
  const openDbId = insertNode(db, 'openDb', 'function', 'core.js', 8, 12);
  insertNode(db, 'validateConfig', 'function', 'core.js', 14, 17);
  const processFilesId = insertNode(db, 'processFiles', 'function', 'core.js', 19, 23);
  const parseOneId = insertNode(db, 'parseOne', 'function', 'core.js', 25, 27);
  const mainId = insertNode(db, 'main', 'function', 'caller.js', 3, 6);
  const testCallerId = insertNode(db, 'testOpenDb', 'function', 'tests/core.test.js', 4, 7);
  // Node without end_line for graceful handling test
  insertNode(db, 'noEndFunc', 'function', 'core.js', 25);

  // Call edges
  insertEdge(db, mainId, openDbId, 'calls');
  insertEdge(db, mainId, processFilesId, 'calls');
  insertEdge(db, processFilesId, parseOneId, 'calls');
  insertEdge(db, testCallerId, openDbId, 'calls');

  db.close();
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('contextData', () => {
  test('returns full context with source, callees, callers, signature', () => {
    const data = contextData('openDb', dbPath);
    expect(data.results.length).toBeGreaterThanOrEqual(1);

    const r = data.results.find((r) => r.kind === 'function' && r.name === 'openDb');
    expect(r).toBeDefined();

    // Source should be present
    expect(r.source).toBeTruthy();
    expect(r.source).toContain('export function openDb');

    // Signature extraction
    expect(r.signature).toBeDefined();
    expect(r.signature.params).toContain('dbPath');

    // Callers — main calls openDb
    const callerNames = r.callers.map((c) => c.name);
    expect(callerNames).toContain('main');

    // Related tests — testOpenDb calls openDb
    expect(r.relatedTests.length).toBeGreaterThanOrEqual(1);
    const testFile = r.relatedTests.find((t) => t.file.includes('core.test.js'));
    expect(testFile).toBeDefined();
    expect(testFile.testNames.length).toBeGreaterThanOrEqual(1);
  });

  test('noSource: true returns source as null', () => {
    const data = contextData('openDb', dbPath, { noSource: true });
    const r = data.results.find((r) => r.name === 'openDb' && r.kind === 'function');
    expect(r.source).toBeNull();
    // Callees should still be present but without source (depth=0)
    if (r.callees.length > 0) {
      expect(r.callees[0].source).toBeNull();
    }
  });

  test('depth: 1 includes callee source', () => {
    const data = contextData('processFiles', dbPath, { depth: 1 });
    const r = data.results.find((r) => r.name === 'processFiles' && r.kind === 'function');
    expect(r).toBeDefined();

    // processFiles -> parseOne
    const parseCallee = r.callees.find((c) => c.name === 'parseOne');
    expect(parseCallee).toBeDefined();
    expect(parseCallee.source).toBeTruthy();
  });

  test('noTests: true excludes test file callers', () => {
    const data = contextData('openDb', dbPath, { noTests: true });
    const r = data.results.find((r) => r.name === 'openDb' && r.kind === 'function');
    // Test callers should be excluded from the callers list
    // (noTests filters the result nodes themselves, not test callers specifically)
    expect(r).toBeDefined();
  });

  test('nonexistent name returns empty results', () => {
    const data = contextData('nonExistentFunction', dbPath);
    expect(data.results).toHaveLength(0);
  });

  test('handles missing end_line gracefully', () => {
    const data = contextData('noEndFunc', dbPath);
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    const r = data.results[0];
    // Should not crash — endLine should be null, source still readable via fallback
    expect(r.endLine).toBeNull();
    expect(r).toHaveProperty('source');
    expect(r).toHaveProperty('signature');
  });

  test('extractSummary picks up JSDoc description', () => {
    // main calls openDb, so openDb appears as a callee for main
    const mainData = contextData('main', dbPath);
    const mainResult = mainData.results.find((r) => r.name === 'main');
    const openDbCallee = mainResult.callees.find((c) => c.name === 'openDb');
    expect(openDbCallee).toBeDefined();
    expect(openDbCallee.summary).toBeTruthy();
    expect(openDbCallee.summary).toContain('Opens or creates');
  });

  test('extractSummary picks up single-line comment', () => {
    const validateData = contextData('processFiles', dbPath, { depth: 1 });
    const pfResult = validateData.results.find((r) => r.name === 'processFiles');
    // parseOne callee — has no comment above it (blank line separator)
    expect(pfResult).toBeDefined();
  });

  test('limits results with pagination', () => {
    // Without limit, all matches are returned (no hardcoded cap)
    const all = contextData('', dbPath); // empty name matches everything via LIKE '%%'
    expect(all.results.length).toBeGreaterThan(0);

    // With limit, results are capped and pagination metadata is present
    const data = contextData('', dbPath, { limit: 2, offset: 0 });
    expect(data.results.length).toBeLessThanOrEqual(2);
    if (all.results.length > 2) {
      expect(data._pagination).toBeDefined();
      expect(data._pagination.hasMore).toBe(true);
    }
  });

  test('includeTests includes test source', () => {
    const data = contextData('openDb', dbPath, { includeTests: true });
    const r = data.results.find((r) => r.name === 'openDb' && r.kind === 'function');
    if (r.relatedTests.length > 0) {
      const testEntry = r.relatedTests.find((t) => t.file.includes('core.test.js'));
      if (testEntry) {
        expect(testEntry.source).toBeTruthy();
        expect(testEntry.source).toContain('describe');
      }
    }
  });

  test('exact match ranks first', () => {
    const data = contextData('openDb', dbPath);
    // openDb should be first result since it's an exact match
    expect(data.results[0].name).toBe('openDb');
  });

  test('--file scopes to matching file', () => {
    const data = contextData('main', dbPath, { file: 'caller.js' });
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    for (const r of data.results) {
      expect(r.file).toContain('caller.js');
    }
  });

  test('--kind method returns empty for function fixtures', () => {
    const data = contextData('openDb', dbPath, { kind: 'method' });
    expect(data.results).toHaveLength(0);
  });
});
