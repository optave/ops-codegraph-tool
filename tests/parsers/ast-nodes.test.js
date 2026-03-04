/**
 * Tests for AST node extraction from parsed source code.
 *
 * Parses JS fixtures through tree-sitter, runs AST extraction via buildAstNodes,
 * and verifies the correct nodes are captured in the DB.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildAstNodes } from '../../src/ast.js';
import { initSchema } from '../../src/db.js';
import { loadNative } from '../../src/native.js';
import { parseFilesAuto } from '../../src/parser.js';

// ─── Fixture ──────────────────────────────────────────────────────────

const FIXTURE_CODE = `
export function processData(input) {
  const result = new Map();
  const pattern = /^[a-z]+$/i;
  const greeting = "hello world";

  if (typeof input === 'string') {
    eval(input);
  }

  try {
    const data = await fetch('/api/data');
    result.set('data', data);
  } catch (err) {
    throw new Error('fetch failed');
  }

  console.log(result);
  return result;
}

function helper() {
  const re = /\\d{3}-\\d{4}/;
  const msg = \`template string value\`;
  return msg;
}
`;

// ─── Setup ────────────────────────────────────────────────────────────

let tmpDir, dbPath, db;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ast-extract-'));
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));

  // Write fixture file
  const fixturePath = path.join(srcDir, 'fixture.js');
  fs.writeFileSync(fixturePath, FIXTURE_CODE);

  // Parse fixture using parseFilesAuto (preserves _tree for AST walk)
  const allSymbols = await parseFilesAuto([fixturePath], tmpDir, { engine: 'wasm' });
  const symbols = allSymbols.get('src/fixture.js');
  if (!symbols) throw new Error('Failed to parse fixture file');

  // Create DB and schema
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // Insert nodes for definitions so parent resolution works
  const insertNode = db.prepare(
    'INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
  );
  for (const def of symbols.definitions) {
    insertNode.run(def.name, def.kind, 'src/fixture.js', def.line, def.endLine);
  }

  // Build AST nodes
  await buildAstNodes(db, allSymbols, tmpDir);
});

afterAll(() => {
  if (db) db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────

function queryAstNodes(kind) {
  return db.prepare('SELECT * FROM ast_nodes WHERE kind = ? ORDER BY line').all(kind);
}

function queryAllAstNodes() {
  return db.prepare('SELECT * FROM ast_nodes ORDER BY line').all();
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('buildAstNodes — JS extraction', () => {
  test('captures call nodes from symbols.calls', () => {
    const calls = queryAstNodes('call');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const callNames = calls.map((c) => c.name);
    // eval, fetch, console.log should be among calls (depending on parser extraction)
    expect(callNames.some((n) => n === 'eval' || n === 'fetch' || n === 'console.log')).toBe(true);
  });

  test('captures new_expression as kind:new', () => {
    const nodes = queryAstNodes('new');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    const names = nodes.map((n) => n.name);
    expect(names).toContain('Map');
    // Note: `throw new Error(...)` is captured as kind:throw, not kind:new
    // The new_expression inside throw is not separately emitted
  });

  test('captures string literals as kind:string', () => {
    const nodes = queryAstNodes('string');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    const names = nodes.map((n) => n.name);
    // "hello world" should be captured, short strings like 'string' might vary
    expect(names.some((n) => n.includes('hello world'))).toBe(true);
  });

  test('skips trivial strings shorter than 2 chars', () => {
    const nodes = queryAstNodes('string');
    // No single-char or empty strings should be present
    for (const node of nodes) {
      expect(node.name.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('captures regex as kind:regex', () => {
    const nodes = queryAstNodes('regex');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    // At least one regex pattern should be present
    expect(nodes.some((n) => n.name.includes('[a-z]') || n.name.includes('\\d'))).toBe(true);
  });

  test('captures throw as kind:throw', () => {
    const nodes = queryAstNodes('throw');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    // throw new Error('fetch failed') → name should be "Error"
    expect(nodes.some((n) => n.name === 'Error')).toBe(true);
  });

  test('captures await as kind:await', () => {
    const nodes = queryAstNodes('await');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    // await fetch('/api/data') → name should include "fetch"
    expect(nodes.some((n) => n.name.includes('fetch'))).toBe(true);
  });

  test('parent_node_id is resolved for nodes inside functions', () => {
    const all = queryAllAstNodes();
    const withParent = all.filter((n) => n.parent_node_id != null);
    expect(withParent.length).toBeGreaterThan(0);

    // Verify the parent exists in the nodes table
    for (const node of withParent) {
      const parent = db.prepare('SELECT * FROM nodes WHERE id = ?').get(node.parent_node_id);
      expect(parent).toBeDefined();
      expect(['function', 'method', 'class']).toContain(parent.kind);
    }
  });

  test('all inserted nodes have valid kinds', () => {
    const all = queryAllAstNodes();
    const validKinds = new Set(['call', 'new', 'string', 'regex', 'throw', 'await']);
    for (const node of all) {
      expect(validKinds.has(node.kind)).toBe(true);
    }
  });

  test('text column is truncated to max length', () => {
    const all = queryAllAstNodes();
    for (const node of all) {
      if (node.text) {
        expect(node.text.length).toBeLessThanOrEqual(201); // 200 + possible ellipsis char
      }
    }
  });
});

// ─── Native engine AST node extraction ───────────────────────────────

// Check if native addon is available AND supports ast_nodes.
// Old prebuilt binaries return FileSymbols without the ast_nodes field.
function nativeSupportsAstNodes() {
  const native = loadNative();
  if (!native) return false;
  try {
    const tmpCheck = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ast-check-'));
    const srcCheck = path.join(tmpCheck, 'src');
    fs.mkdirSync(srcCheck, { recursive: true });
    const checkPath = path.join(srcCheck, 'check.js');
    fs.writeFileSync(checkPath, 'const x = new Map();');
    const results = native.parseFiles([checkPath], tmpCheck);
    const hasField = results?.[0]?.astNodes?.length > 0 || results?.[0]?.ast_nodes?.length > 0;
    fs.rmSync(tmpCheck, { recursive: true, force: true });
    return hasField;
  } catch {
    return false;
  }
}

const canTestNative = nativeSupportsAstNodes();

describe.skipIf(!canTestNative)('buildAstNodes — native engine', () => {
  let nativeTmpDir, nativeDbPath, nativeDb;

  function queryNativeAstNodes(kind) {
    return nativeDb.prepare('SELECT * FROM ast_nodes WHERE kind = ? ORDER BY line').all(kind);
  }

  function queryAllNativeAstNodes() {
    return nativeDb.prepare('SELECT * FROM ast_nodes ORDER BY line').all();
  }

  beforeAll(async () => {
    nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ast-native-'));
    const srcDir = path.join(nativeTmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(path.join(nativeTmpDir, '.codegraph'));

    const fixturePath = path.join(srcDir, 'fixture.js');
    fs.writeFileSync(fixturePath, FIXTURE_CODE);

    const allSymbols = await parseFilesAuto([fixturePath], nativeTmpDir, { engine: 'native' });
    const symbols = allSymbols.get('src/fixture.js');
    if (!symbols) throw new Error('Failed to parse fixture file with native engine');

    nativeDbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
    nativeDb = new Database(nativeDbPath);
    nativeDb.pragma('journal_mode = WAL');
    initSchema(nativeDb);

    const insertNode = nativeDb.prepare(
      'INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
    );
    for (const def of symbols.definitions) {
      insertNode.run(def.name, def.kind, 'src/fixture.js', def.line, def.endLine);
    }

    await buildAstNodes(nativeDb, allSymbols, nativeTmpDir);
  });

  afterAll(() => {
    if (nativeDb) nativeDb.close();
    if (nativeTmpDir) fs.rmSync(nativeTmpDir, { recursive: true, force: true });
  });

  test('captures new_expression as kind:new', () => {
    const nodes = queryNativeAstNodes('new');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes.map((n) => n.name)).toContain('Map');
  });

  test('captures throw as kind:throw', () => {
    const nodes = queryNativeAstNodes('throw');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes.some((n) => n.name === 'Error')).toBe(true);
  });

  test('captures await as kind:await', () => {
    const nodes = queryNativeAstNodes('await');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes.some((n) => n.name.includes('fetch'))).toBe(true);
  });

  test('captures string literals as kind:string', () => {
    const nodes = queryNativeAstNodes('string');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes.some((n) => n.name.includes('hello world'))).toBe(true);
  });

  test('captures regex as kind:regex', () => {
    const nodes = queryNativeAstNodes('regex');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    expect(nodes.some((n) => n.name.includes('[a-z]') || n.name.includes('\\d'))).toBe(true);
  });

  test('no double-count for throw new Error', () => {
    const newNodes = queryNativeAstNodes('new');
    // "Error" should NOT appear as a new node — it's captured under throw
    expect(newNodes.every((n) => n.name !== 'Error')).toBe(true);
  });

  test('skips trivial strings', () => {
    const nodes = queryNativeAstNodes('string');
    for (const node of nodes) {
      expect(node.name.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('all nodes have valid kinds', () => {
    const all = queryAllNativeAstNodes();
    const validKinds = new Set(['call', 'new', 'string', 'regex', 'throw', 'await']);
    for (const node of all) {
      expect(validKinds.has(node.kind)).toBe(true);
    }
  });

  test('parent_node_id is resolved', () => {
    const all = queryAllNativeAstNodes();
    const withParent = all.filter((n) => n.parent_node_id != null);
    expect(withParent.length).toBeGreaterThan(0);
  });
});
