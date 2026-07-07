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
import { initSchema } from '../../src/db/index.js';
import { parseFilesAuto } from '../../src/domain/parser.js';
import { buildAstNodes } from '../../src/features/ast.js';
import { loadNative } from '../../src/infrastructure/native.js';

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

let tmpDir: string, dbPath: string, db: any;

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
  test('does not extract call_expression as AST nodes', () => {
    const calls = queryAstNodes('call');
    expect(calls.length).toBe(0);
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
    const validKinds = new Set(['new', 'string', 'regex', 'throw', 'await']);
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

// ─── TypeScript fixture (#1729: predefined_type keyword false-positives) ──
//
// tree-sitter-typescript's `predefined_type` production (the `string`,
// `number`, `boolean`, ... primitive type keywords) lexes its keyword as an
// anonymous token whose `type` string collides with the *named* `string`
// literal node type. `--kind string` must only match the latter.

const TS_FIXTURE_CODE = `
interface Person {
  name: string;
  age: number;
}

type UserId = "user-id-literal";

function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

function processItems(items: string[]): void {
  console.log(items);
}

import { helper } from './helper.js';

const greeting = "hello world";
`;

describe('buildAstNodes — TypeScript extraction (#1729)', () => {
  let tsTmpDir: string, tsDb: any;

  function queryTsAstNodes(kind: string) {
    return tsDb.prepare('SELECT * FROM ast_nodes WHERE kind = ? ORDER BY line').all(kind);
  }

  beforeAll(async () => {
    tsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ast-ts-extract-'));
    const srcDir = path.join(tsTmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(path.join(tsTmpDir, '.codegraph'));

    const fixturePath = path.join(srcDir, 'fixture.ts');
    fs.writeFileSync(fixturePath, TS_FIXTURE_CODE);

    const allSymbols = await parseFilesAuto([fixturePath], tsTmpDir, { engine: 'wasm' });
    const symbols = allSymbols.get('src/fixture.ts');
    if (!symbols) throw new Error('Failed to parse TS fixture file');

    const dbPath = path.join(tsTmpDir, '.codegraph', 'graph.db');
    tsDb = new Database(dbPath);
    tsDb.pragma('journal_mode = WAL');
    initSchema(tsDb);

    const insertNode = tsDb.prepare(
      'INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
    );
    for (const def of symbols.definitions) {
      insertNode.run(def.name, def.kind, 'src/fixture.ts', def.line, def.endLine);
    }

    await buildAstNodes(tsDb, allSymbols, tsTmpDir);
  });

  afterAll(() => {
    if (tsDb) tsDb.close();
    fs.rmSync(tsTmpDir, { recursive: true, force: true });
  });

  test('does not misclassify interface field type annotation as kind:string', () => {
    // `name: string;` (line 3) must never surface as a bare, unquoted "string"
    // row — genuine literals are always quoted in `text` (e.g. "hello world").
    const nodes = queryTsAstNodes('string');
    expect(nodes.some((n) => n.text === 'string')).toBe(false);
  });

  test('does not misclassify parameter or return type annotations as kind:string', () => {
    // `greet(name: string): string` (param + return type, line 9) must not
    // contribute bare "string" rows.
    const nodes = queryTsAstNodes('string');
    expect(nodes.filter((n) => n.text === 'string').length).toBe(0);
  });

  test('does not misclassify array-of-primitive parameter type as kind:string', () => {
    // `processItems(items: string[])` (line 13) wraps predefined_type in
    // array_type — must not contribute a bare "string" row either.
    const nodes = queryTsAstNodes('string');
    expect(nodes.some((n) => n.line === 13)).toBe(false);
  });

  test('still captures genuine string literals, template literals, and string-literal types', () => {
    const nodes = queryTsAstNodes('string');
    const names = nodes.map((n) => n.name);
    expect(names).toContain('user-id-literal'); // type UserId = "user-id-literal"
    expect(names).toContain('./helper.js'); // import source path
    expect(names).toContain('hello world'); // genuine string literal
    expect(nodes.some((n) => n.text?.startsWith('`Hello, '))).toBe(true); // template literal
  });

  test('captures exactly the 4 genuine literals — no keyword false-positives', () => {
    const nodes = queryTsAstNodes('string');
    expect(nodes.length).toBe(4);
  });
});

// ─── TSX fixture (#1729) — shares JS_AST_TYPES + grammar family with TS ───

const TSX_FIXTURE_CODE = `
interface Props {
  label: string;
}

function Greeting(props: Props) {
  return <div>{"hello world"}</div>;
}
`;

describe('buildAstNodes — TSX extraction (#1729)', () => {
  let tsxTmpDir: string, tsxDb: any;

  beforeAll(async () => {
    tsxTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ast-tsx-extract-'));
    const srcDir = path.join(tsxTmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(path.join(tsxTmpDir, '.codegraph'));

    const fixturePath = path.join(srcDir, 'fixture.tsx');
    fs.writeFileSync(fixturePath, TSX_FIXTURE_CODE);

    const allSymbols = await parseFilesAuto([fixturePath], tsxTmpDir, { engine: 'wasm' });
    const symbols = allSymbols.get('src/fixture.tsx');
    if (!symbols) throw new Error('Failed to parse TSX fixture file');

    const dbPath = path.join(tsxTmpDir, '.codegraph', 'graph.db');
    tsxDb = new Database(dbPath);
    tsxDb.pragma('journal_mode = WAL');
    initSchema(tsxDb);

    const insertNode = tsxDb.prepare(
      'INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
    );
    for (const def of symbols.definitions) {
      insertNode.run(def.name, def.kind, 'src/fixture.tsx', def.line, def.endLine);
    }

    await buildAstNodes(tsxDb, allSymbols, tsxTmpDir);
  });

  afterAll(() => {
    if (tsxDb) tsxDb.close();
    fs.rmSync(tsxTmpDir, { recursive: true, force: true });
  });

  test('does not misclassify interface field type annotation as kind:string, still captures JSX-embedded literal', () => {
    const nodes = tsxDb
      .prepare('SELECT * FROM ast_nodes WHERE kind = ? ORDER BY line')
      .all('string');
    expect(nodes.some((n) => n.text === 'string')).toBe(false);
    expect(nodes.length).toBe(1);
    expect(nodes[0].name).toBe('hello world');
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
  let nativeTmpDir: string, nativeDbPath: string, nativeDb: any;

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
    // 'call' accepted transitionally: published native binary (v3.7.0) still emits it
    const validKinds = new Set(['new', 'string', 'regex', 'throw', 'await', 'call']);
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

// ─── Native engine: TypeScript predefined_type false-positives (#1729) ────

describe.skipIf(!canTestNative)('buildAstNodes — native TypeScript extraction (#1729)', () => {
  let nativeTsTmpDir: string, nativeTsDb: any;

  function queryNativeTsAstNodes(kind: string) {
    return nativeTsDb.prepare('SELECT * FROM ast_nodes WHERE kind = ? ORDER BY line').all(kind);
  }

  beforeAll(async () => {
    nativeTsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ast-ts-native-'));
    const srcDir = path.join(nativeTsTmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(path.join(nativeTsTmpDir, '.codegraph'));

    const fixturePath = path.join(srcDir, 'fixture.ts');
    fs.writeFileSync(fixturePath, TS_FIXTURE_CODE);

    const allSymbols = await parseFilesAuto([fixturePath], nativeTsTmpDir, { engine: 'native' });
    const symbols = allSymbols.get('src/fixture.ts');
    if (!symbols) throw new Error('Failed to parse TS fixture file with native engine');

    const dbPath = path.join(nativeTsTmpDir, '.codegraph', 'graph.db');
    nativeTsDb = new Database(dbPath);
    nativeTsDb.pragma('journal_mode = WAL');
    initSchema(nativeTsDb);

    const insertNode = nativeTsDb.prepare(
      'INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
    );
    for (const def of symbols.definitions) {
      insertNode.run(def.name, def.kind, 'src/fixture.ts', def.line, def.endLine);
    }

    await buildAstNodes(nativeTsDb, allSymbols, nativeTsTmpDir);
  });

  afterAll(() => {
    if (nativeTsDb) nativeTsDb.close();
    if (nativeTsTmpDir) fs.rmSync(nativeTsTmpDir, { recursive: true, force: true });
  });

  test('does not misclassify interface field type annotation as kind:string', () => {
    const nodes = queryNativeTsAstNodes('string');
    expect(nodes.some((n) => n.text === 'string')).toBe(false);
  });

  test('does not misclassify parameter, return, or array-element type annotations as kind:string', () => {
    const nodes = queryNativeTsAstNodes('string');
    expect(nodes.filter((n) => n.text === 'string').length).toBe(0);
  });

  test('still captures genuine string literals, template literals, and string-literal types', () => {
    const nodes = queryNativeTsAstNodes('string');
    const names = nodes.map((n) => n.name);
    expect(names).toContain('user-id-literal');
    expect(names).toContain('./helper.js');
    expect(names).toContain('hello world');
    expect(nodes.some((n) => n.text?.startsWith('`Hello, '))).toBe(true);
  });

  test('captures exactly the 4 genuine literals — no keyword false-positives', () => {
    const nodes = queryNativeTsAstNodes('string');
    expect(nodes.length).toBe(4);
  });
});

// ─── PHP fixture (#1821: primitive_type/cast_type keyword false-positives) ─
//
// tree-sitter-php's `primitive_type` production (scalar type-hints like
// `string $x` and `: string` return types) and `cast_type` production
// (`(string) $x`) both lex the `string` keyword as an anonymous token whose
// `type` string collides with the *named* `string` literal node type —
// mirroring TypeScript's `predefined_type` construct (#1729).

const PHP_FIXTURE_CODE = `<?php

class Greeter {
    public function greet(string $name): string {
        $greeting = "Hello, $name!";
        return $greeting;
    }

    public function label(): string {
        return 'static label';
    }

    public function normalize($value): string {
        return (string) $value;
    }
}

$greeting = 'hello world';
`;

describe('buildAstNodes — PHP extraction (#1821)', () => {
  let phpTmpDir: string, phpDb: any;

  function queryPhpAstNodes(kind: string) {
    return phpDb.prepare('SELECT * FROM ast_nodes WHERE kind = ? ORDER BY line').all(kind);
  }

  beforeAll(async () => {
    phpTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ast-php-extract-'));
    const srcDir = path.join(phpTmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(path.join(phpTmpDir, '.codegraph'));

    const fixturePath = path.join(srcDir, 'fixture.php');
    fs.writeFileSync(fixturePath, PHP_FIXTURE_CODE);

    const allSymbols = await parseFilesAuto([fixturePath], phpTmpDir, { engine: 'wasm' });
    const symbols = allSymbols.get('src/fixture.php');
    if (!symbols) throw new Error('Failed to parse PHP fixture file');

    const dbPath = path.join(phpTmpDir, '.codegraph', 'graph.db');
    phpDb = new Database(dbPath);
    phpDb.pragma('journal_mode = WAL');
    initSchema(phpDb);

    const insertNode = phpDb.prepare(
      'INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
    );
    for (const def of symbols.definitions) {
      insertNode.run(def.name, def.kind, 'src/fixture.php', def.line, def.endLine);
    }

    await buildAstNodes(phpDb, allSymbols, phpTmpDir);
  });

  afterAll(() => {
    if (phpDb) phpDb.close();
    fs.rmSync(phpTmpDir, { recursive: true, force: true });
  });

  test('does not misclassify parameter scalar type-hint as kind:string', () => {
    // `string $name` (line 4) must never surface as a bare, unquoted "string"
    // row — genuine literals are always quoted in `text`.
    const nodes = queryPhpAstNodes('string');
    expect(nodes.some((n) => n.text === 'string')).toBe(false);
  });

  test('does not misclassify return type-hint as kind:string', () => {
    // `: string` return types on greet/label/normalize must not contribute
    // bare "string" rows.
    const nodes = queryPhpAstNodes('string');
    expect(nodes.filter((n) => n.text === 'string').length).toBe(0);
  });

  test('does not misclassify (string) cast as kind:string', () => {
    // `(string) $value` (line 12) must not contribute a bare "string" row.
    const nodes = queryPhpAstNodes('string');
    expect(nodes.some((n) => n.line === 12)).toBe(false);
  });

  test('still captures genuine string literals (interpolated and plain)', () => {
    const nodes = queryPhpAstNodes('string');
    const names = nodes.map((n) => n.name);
    expect(names.some((n) => n?.includes('Hello,'))).toBe(true); // interpolated
    expect(names).toContain('static label');
    expect(names).toContain('hello world');
  });

  test('captures exactly the 3 genuine literals — no keyword false-positives', () => {
    const nodes = queryPhpAstNodes('string');
    expect(nodes.length).toBe(3);
  });
});

// ─── Native engine: PHP primitive_type/cast_type false-positives (#1821) ──

describe.skipIf(!canTestNative)('buildAstNodes — native PHP extraction (#1821)', () => {
  let nativePhpTmpDir: string, nativePhpDb: any;

  function queryNativePhpAstNodes(kind: string) {
    return nativePhpDb.prepare('SELECT * FROM ast_nodes WHERE kind = ? ORDER BY line').all(kind);
  }

  beforeAll(async () => {
    nativePhpTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ast-php-native-'));
    const srcDir = path.join(nativePhpTmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(path.join(nativePhpTmpDir, '.codegraph'));

    const fixturePath = path.join(srcDir, 'fixture.php');
    fs.writeFileSync(fixturePath, PHP_FIXTURE_CODE);

    const allSymbols = await parseFilesAuto([fixturePath], nativePhpTmpDir, { engine: 'native' });
    const symbols = allSymbols.get('src/fixture.php');
    if (!symbols) throw new Error('Failed to parse PHP fixture file with native engine');

    const dbPath = path.join(nativePhpTmpDir, '.codegraph', 'graph.db');
    nativePhpDb = new Database(dbPath);
    nativePhpDb.pragma('journal_mode = WAL');
    initSchema(nativePhpDb);

    const insertNode = nativePhpDb.prepare(
      'INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
    );
    for (const def of symbols.definitions) {
      insertNode.run(def.name, def.kind, 'src/fixture.php', def.line, def.endLine);
    }

    await buildAstNodes(nativePhpDb, allSymbols, nativePhpTmpDir);
  });

  afterAll(() => {
    if (nativePhpDb) nativePhpDb.close();
    if (nativePhpTmpDir) fs.rmSync(nativePhpTmpDir, { recursive: true, force: true });
  });

  test('does not misclassify parameter scalar type-hint as kind:string', () => {
    const nodes = queryNativePhpAstNodes('string');
    expect(nodes.some((n) => n.text === 'string')).toBe(false);
  });

  test('does not misclassify return type-hint or cast as kind:string', () => {
    const nodes = queryNativePhpAstNodes('string');
    expect(nodes.filter((n) => n.text === 'string').length).toBe(0);
  });

  test('still captures genuine string literals (interpolated and plain)', () => {
    const nodes = queryNativePhpAstNodes('string');
    const names = nodes.map((n) => n.name);
    expect(names.some((n) => n?.includes('Hello,'))).toBe(true);
    expect(names).toContain('static label');
    expect(names).toContain('hello world');
  });

  test('captures exactly the 3 genuine literals — no keyword false-positives', () => {
    const nodes = queryNativePhpAstNodes('string');
    expect(nodes.length).toBe(3);
  });
});
