/**
 * Integration tests for AST node queries.
 *
 * Uses a hand-crafted in-memory DB with known AST nodes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { AST_NODE_KINDS, astQueryData } from '../../src/features/ast.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function insertNode(db, name, kind, file, line) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid;
}

function insertAstNode(db, file, line, kind, name, text, receiver, parentNodeId) {
  return db
    .prepare(
      'INSERT INTO ast_nodes (file, line, kind, name, text, receiver, parent_node_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(file, line, kind, name, text, receiver, parentNodeId).lastInsertRowid;
}

// ─── Fixture DB ────────────────────────────────────────────────────────

let tmpDir: string, dbPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ast-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // Insert function nodes
  const processId = insertNode(db, 'processInput', 'function', 'src/utils.js', 10);
  const loaderId = insertNode(db, 'loadModule', 'function', 'src/loader.js', 5);
  const handlerId = insertNode(db, 'handleRequest', 'function', 'src/handler.js', 20);
  const defaultsId = insertNode(db, 'defaults', 'function', 'src/config.js', 1);
  const testFnId = insertNode(db, 'testUtils', 'function', 'tests/utils.test.js', 1);

  // Calls
  insertAstNode(db, 'src/utils.js', 42, 'call', 'eval', null, null, processId);
  insertAstNode(db, 'src/loader.js', 8, 'call', 'require', null, null, loaderId);
  insertAstNode(db, 'src/handler.js', 25, 'call', 'console.log', null, 'console', handlerId);
  insertAstNode(db, 'src/handler.js', 30, 'call', 'console.error', null, 'console', handlerId);
  insertAstNode(db, 'src/utils.js', 50, 'call', 'fetch', null, null, processId);

  // new expressions
  insertAstNode(db, 'src/handler.js', 30, 'new', 'Error', 'new Error("bad")', null, handlerId);
  insertAstNode(db, 'src/loader.js', 12, 'new', 'Map', 'new Map()', null, loaderId);

  // strings
  insertAstNode(
    db,
    'src/config.js',
    18,
    'string',
    'password123',
    '"password123"',
    null,
    defaultsId,
  );
  insertAstNode(
    db,
    'src/config.js',
    19,
    'string',
    'localhost:3000',
    '"localhost:3000"',
    null,
    defaultsId,
  );

  // throw
  insertAstNode(
    db,
    'src/handler.js',
    35,
    'throw',
    'Error',
    'new Error("not found")',
    null,
    handlerId,
  );

  // await
  insertAstNode(db, 'src/utils.js', 55, 'await', 'fetch', 'fetch(url)', null, processId);

  // regex
  insertAstNode(db, 'src/utils.js', 60, 'regex', '/\\d+/g', '/\\d+/g', null, processId);

  // Test file nodes (should be excluded by noTests)
  insertAstNode(db, 'tests/utils.test.js', 5, 'call', 'eval', null, null, testFnId);

  db.close();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────────────────

describe('AST_NODE_KINDS', () => {
  test('exports all expected kinds', () => {
    expect(AST_NODE_KINDS).toEqual(['call', 'new', 'string', 'regex', 'throw', 'await']);
  });
});

describe('astQueryData', () => {
  test('returns all nodes when no pattern given', () => {
    const data = astQueryData(undefined, dbPath);
    expect(data.count).toBeGreaterThan(0);
    expect(data.pattern).toBe('*');
  });

  test('substring pattern match', () => {
    const data = astQueryData('eval', dbPath);
    // Should match 'eval' in src/utils.js and tests/utils.test.js
    expect(data.results.length).toBeGreaterThanOrEqual(2);
    expect(data.results.every((r) => r.name.includes('eval'))).toBe(true);
  });

  test('glob wildcard pattern', () => {
    const data = astQueryData('console.*', dbPath);
    expect(data.results.length).toBe(2);
    expect(data.results.every((r) => r.name.startsWith('console.'))).toBe(true);
  });

  test('exact pattern with star', () => {
    const data = astQueryData('*', dbPath);
    expect(data.count).toBeGreaterThan(0);
  });

  test('kind filter — call', () => {
    const data = astQueryData(undefined, dbPath, { kind: 'call' });
    expect(data.results.every((r) => r.kind === 'call')).toBe(true);
    expect(data.results.length).toBeGreaterThanOrEqual(5);
  });

  test('kind filter — string', () => {
    const data = astQueryData(undefined, dbPath, { kind: 'string' });
    expect(data.results.every((r) => r.kind === 'string')).toBe(true);
    expect(data.results.length).toBe(2);
  });

  test('kind filter — new', () => {
    const data = astQueryData(undefined, dbPath, { kind: 'new' });
    expect(data.results.every((r) => r.kind === 'new')).toBe(true);
    expect(data.results.length).toBe(2);
  });

  test('kind filter — throw', () => {
    const data = astQueryData(undefined, dbPath, { kind: 'throw' });
    expect(data.results.every((r) => r.kind === 'throw')).toBe(true);
    expect(data.results.length).toBe(1);
  });

  test('kind filter — await', () => {
    const data = astQueryData(undefined, dbPath, { kind: 'await' });
    expect(data.results.every((r) => r.kind === 'await')).toBe(true);
    expect(data.results.length).toBe(1);
  });

  test('kind filter — regex', () => {
    const data = astQueryData(undefined, dbPath, { kind: 'regex' });
    expect(data.results.every((r) => r.kind === 'regex')).toBe(true);
    expect(data.results.length).toBe(1);
  });

  test('file filter', () => {
    const data = astQueryData(undefined, dbPath, { file: 'config' });
    expect(data.results.every((r) => r.file.includes('config'))).toBe(true);
    expect(data.results.length).toBe(2);
  });

  test('noTests excludes test files', () => {
    const withTests = astQueryData('eval', dbPath);
    const noTests = astQueryData('eval', dbPath, { noTests: true });
    expect(noTests.results.length).toBeLessThan(withTests.results.length);
    expect(noTests.results.every((r) => !r.file.includes('.test.'))).toBe(true);
  });

  test('pagination — limit', () => {
    const data = astQueryData(undefined, dbPath, { limit: 3 });
    expect(data.results.length).toBe(3);
    expect(data._pagination).toBeDefined();
    expect(data._pagination.total).toBeGreaterThan(3);
    expect(data._pagination.hasMore).toBe(true);
  });

  test('pagination — offset', () => {
    const page1 = astQueryData(undefined, dbPath, { limit: 3, offset: 0 });
    const page2 = astQueryData(undefined, dbPath, { limit: 3, offset: 3 });
    expect(page1.results[0].name).not.toBe(page2.results[0].name);
  });

  test('parent node resolution', () => {
    const data = astQueryData('eval', dbPath, { noTests: true });
    expect(data.results.length).toBe(1);
    const r = data.results[0];
    expect(r.parent).toBeDefined();
    expect(r.parent.name).toBe('processInput');
    expect(r.parent.kind).toBe('function');
  });

  test('receiver field for calls', () => {
    const data = astQueryData('console.log', dbPath);
    expect(data.results.length).toBe(1);
    expect(data.results[0].receiver).toBe('console');
  });

  test('empty results for non-matching pattern', () => {
    const data = astQueryData('nonexistent_xyz', dbPath);
    expect(data.results.length).toBe(0);
    expect(data.count).toBe(0);
  });

  test('combined kind + file filter', () => {
    const data = astQueryData(undefined, dbPath, { kind: 'call', file: 'handler' });
    expect(data.results.every((r) => r.kind === 'call' && r.file.includes('handler'))).toBe(true);
    expect(data.results.length).toBe(2);
  });
});
