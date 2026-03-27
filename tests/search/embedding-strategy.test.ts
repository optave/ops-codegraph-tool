import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { initSchema } from '../../src/db/index.js';

// ─── Mock setup ────────────────────────────────────────────────────────

// Capture texts passed to the embedding model
const { EMBEDDED_TEXTS } = vi.hoisted(() => ({
  EMBEDDED_TEXTS: [],
}));

vi.mock('@huggingface/transformers', () => ({
  pipeline: async () => async (batch) => {
    const dim = 384;
    const data = new Float32Array(dim * batch.length);
    for (let t = 0; t < batch.length; t++) {
      EMBEDDED_TEXTS.push(batch[t]);
      data[t * dim] = 0.5;
      data[t * dim + 1] = 0.3;
    }
    return { data };
  },
  cos_sim: () => 0,
}));

import {
  buildEmbeddings,
  EMBEDDING_STRATEGIES,
  estimateTokens,
  MODELS,
} from '../../src/domain/search/index.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function insertNode(db, name, kind, file, line, endLine) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)')
    .run(name, kind, file, line, endLine).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind) {
  db.prepare('INSERT INTO edges (source_id, target_id, kind) VALUES (?, ?, ?)').run(
    sourceId,
    targetId,
    kind,
  );
}

// ─── Fixture ───────────────────────────────────────────────────────────

// Source files that match the DB nodes
const FIXTURE_FILES = {
  'math.js': [
    '/**',
    ' * Add two numbers together.',
    ' */',
    'export function add(a, b) { return a + b; }',
    'export function multiply(a, b) { return a * b; }',
    'export function square(x) { return multiply(x, x); }',
  ].join('\n'),
  'utils.js': [
    "import { add, square } from './math.js';",
    'export function sumOfSquares(a, b) { return add(square(a), square(b)); }',
    'export class Calculator {',
    '  compute(x, y) { return sumOfSquares(x, y); }',
    '}',
  ].join('\n'),
};

let tmpDir: string, dbPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-strategy-test-'));

  // Write source files
  for (const [name, content] of Object.entries(FIXTURE_FILES)) {
    fs.writeFileSync(path.join(tmpDir, name), content);
  }

  // Create DB with nodes + edges
  const dbDir = path.join(tmpDir, '.codegraph');
  fs.mkdirSync(dbDir, { recursive: true });
  dbPath = path.join(dbDir, 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // math.js nodes (line numbers are 1-indexed)
  const addId = insertNode(db, 'add', 'function', 'math.js', 4, 4);
  const multiplyId = insertNode(db, 'multiply', 'function', 'math.js', 5, 5);
  const squareId = insertNode(db, 'square', 'function', 'math.js', 6, 6);

  // utils.js nodes
  const sumOfSquaresId = insertNode(db, 'sumOfSquares', 'function', 'utils.js', 2, 2);
  insertNode(db, 'Calculator', 'class', 'utils.js', 3, 5);
  const computeId = insertNode(db, 'compute', 'method', 'utils.js', 4, 4);

  // Call edges: square → multiply, sumOfSquares → add, sumOfSquares → square, compute → sumOfSquares
  insertEdge(db, squareId, multiplyId, 'calls');
  insertEdge(db, sumOfSquaresId, addId, 'calls');
  insertEdge(db, sumOfSquaresId, squareId, 'calls');
  insertEdge(db, computeId, sumOfSquaresId, 'calls');

  db.close();
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────────────────

describe('EMBEDDING_STRATEGIES', () => {
  test('exports valid strategies', () => {
    expect(EMBEDDING_STRATEGIES).toContain('structured');
    expect(EMBEDDING_STRATEGIES).toContain('source');
  });
});

describe('estimateTokens', () => {
  test('estimates ~4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });

  test('rounds up', () => {
    expect(estimateTokens('abcde')).toBe(2);
  });

  test('handles empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('MODELS contextWindow', () => {
  test('every model has a contextWindow', () => {
    for (const [key, config] of Object.entries(MODELS)) {
      expect(config.contextWindow, `${key} missing contextWindow`).toBeGreaterThan(0);
    }
  });
});

describe('buildEmbeddings with structured strategy', () => {
  test('produces embeddings with graph context', async () => {
    EMBEDDED_TEXTS.length = 0;
    await buildEmbeddings(tmpDir, 'minilm', dbPath, { strategy: 'structured' });

    expect(EMBEDDED_TEXTS.length).toBeGreaterThan(0);

    // square calls multiply → should appear in structured text
    const squareText = EMBEDDED_TEXTS.find((t) => t.startsWith('function square'));
    expect(squareText).toBeDefined();
    expect(squareText).toContain('Calls:');
    expect(squareText).toContain('multiply');

    // sumOfSquares calls add and square → should appear
    const sosText = EMBEDDED_TEXTS.find((t) => t.startsWith('function sumOfSquares'));
    expect(sosText).toBeDefined();
    expect(sosText).toContain('Calls:');
    expect(sosText).toContain('add');
    expect(sosText).toContain('square');

    // sumOfSquares is called by compute → should appear
    expect(sosText).toContain('Called by:');
    expect(sosText).toContain('compute');
  });

  test('extracts leading comments', async () => {
    // add has a JSDoc comment above it: "Add two numbers together."
    const addText = EMBEDDED_TEXTS.find((t) => t.startsWith('function add'));
    expect(addText).toBeDefined();
    expect(addText).toContain('Add two numbers together');
  });

  test('extracts parameters from signature', async () => {
    const addText = EMBEDDED_TEXTS.find((t) => t.startsWith('function add'));
    expect(addText).toBeDefined();
    expect(addText).toContain('Parameters:');
    expect(addText).toContain('a, b');
  });

  test('stores strategy in metadata', async () => {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT value FROM embedding_meta WHERE key = 'strategy'").get();
    db.close();
    expect(row.value).toBe('structured');
  });

  test('structured texts are compact', () => {
    for (const text of EMBEDDED_TEXTS) {
      const tokens = estimateTokens(text);
      expect(tokens).toBeLessThan(200);
    }
  });
});

describe('buildEmbeddings with source strategy', () => {
  test('produces embeddings with raw source code', async () => {
    EMBEDDED_TEXTS.length = 0;
    await buildEmbeddings(tmpDir, 'minilm', dbPath, { strategy: 'source' });

    expect(EMBEDDED_TEXTS.length).toBeGreaterThan(0);

    // Source strategy should NOT have graph context lines
    const squareText = EMBEDDED_TEXTS.find((t) => t.startsWith('function square'));
    expect(squareText).toBeDefined();
    expect(squareText).not.toContain('Calls:');
    expect(squareText).not.toContain('Called by:');
    expect(squareText).toContain('return');
  });

  test('stores strategy in metadata', async () => {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT value FROM embedding_meta WHERE key = 'strategy'").get();
    db.close();
    expect(row.value).toBe('source');
  });
});

describe('buildEmbeddings defaults to structured', () => {
  test('no options → structured strategy', async () => {
    EMBEDDED_TEXTS.length = 0;
    await buildEmbeddings(tmpDir, 'minilm', dbPath);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT value FROM embedding_meta WHERE key = 'strategy'").get();
    db.close();
    expect(row.value).toBe('structured');
  });
});

describe('FTS5 index built alongside embeddings', () => {
  test('full_text column is populated in embeddings table', async () => {
    EMBEDDED_TEXTS.length = 0;
    await buildEmbeddings(tmpDir, 'minilm', dbPath, { strategy: 'structured' });

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT full_text FROM embeddings WHERE full_text IS NOT NULL').all();
    db.close();
    expect(rows.length).toBeGreaterThan(0);
    // Each full_text should contain structured text content
    for (const row of rows) {
      expect(row.full_text.length).toBeGreaterThan(0);
    }
  });

  test('FTS5 row count matches embedding count', async () => {
    const db = new Database(dbPath, { readonly: true });
    const embCount = db.prepare('SELECT COUNT(*) as c FROM embeddings').get().c;
    const ftsCount = db.prepare('SELECT COUNT(*) as c FROM fts_index').get().c;
    db.close();
    expect(ftsCount).toBe(embCount);
  });

  test('FTS5 content matches the structured/source text', async () => {
    const db = new Database(dbPath, { readonly: true });
    // FTS5 rowid matches embeddings.node_id
    const emb = db.prepare('SELECT node_id, full_text FROM embeddings').all();
    for (const row of emb) {
      const fts = db.prepare('SELECT content FROM fts_index WHERE rowid = ?').get(row.node_id);
      expect(fts).toBeDefined();
      expect(fts.content).toBe(row.full_text);
    }
    db.close();
  });

  test('fts_count is stored in metadata', async () => {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT value FROM embedding_meta WHERE key = 'fts_count'").get();
    db.close();
    expect(row).toBeDefined();
    expect(Number(row.value)).toBeGreaterThan(0);
  });

  test('FTS5 name column contains symbol names', async () => {
    const db = new Database(dbPath, { readonly: true });
    const results = db
      .prepare("SELECT rowid, name FROM fts_index WHERE fts_index MATCH 'add'")
      .all();
    db.close();
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.name);
    expect(names).toContain('add');
  });
});

describe('context window overflow detection', () => {
  let bigDir: string, bigDbPath: string;

  beforeAll(() => {
    // Create a file with a very large function that will overflow minilm's 256-token window
    bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-overflow-test-'));
    const bigFn =
      'export function bigFunction(x) {\n' +
      '  const data = [];\n'.repeat(400) +
      '  return data;\n}\n';
    fs.writeFileSync(path.join(bigDir, 'big.js'), bigFn);

    const bigDbDir = path.join(bigDir, '.codegraph');
    fs.mkdirSync(bigDbDir, { recursive: true });
    bigDbPath = path.join(bigDbDir, 'graph.db');

    const db = new Database(bigDbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    insertNode(db, 'bigFunction', 'function', 'big.js', 1, 403);
    db.close();
  });

  afterAll(() => {
    if (bigDir) fs.rmSync(bigDir, { recursive: true, force: true });
  });

  test('warns and truncates when source text exceeds context window', async () => {
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    EMBEDDED_TEXTS.length = 0;
    await buildEmbeddings(bigDir, 'minilm', bigDbPath, { strategy: 'source' });

    const warnOutput = warnSpy.mock.calls.map((c) => c[0]).join('');
    warnSpy.mockRestore();

    expect(warnOutput).toContain('exceeded model context window');
    expect(warnOutput).toContain('truncated');

    // Text should be truncated to fit minilm's 256-token ≈ 1024 char limit
    const bigText = EMBEDDED_TEXTS.find((t) => t.includes('bigFunction'));
    expect(bigText).toBeDefined();
    expect(bigText.length).toBeLessThanOrEqual(256 * 4);

    // Metadata records truncation count
    const db = new Database(bigDbPath, { readonly: true });
    const row = db.prepare("SELECT value FROM embedding_meta WHERE key = 'truncated_count'").get();
    db.close();
    expect(row).toBeDefined();
    expect(Number(row.value)).toBeGreaterThan(0);
  });

  test('structured strategy avoids overflow for same function', async () => {
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    EMBEDDED_TEXTS.length = 0;
    await buildEmbeddings(bigDir, 'minilm', bigDbPath, { strategy: 'structured' });

    const warnOutput = warnSpy.mock.calls.map((c) => c[0]).join('');
    warnSpy.mockRestore();

    // Structured strategy only uses first few lines + graph context → should NOT overflow
    const bigText = EMBEDDED_TEXTS.find((t) => t.includes('bigFunction'));
    expect(bigText).toBeDefined();
    expect(estimateTokens(bigText)).toBeLessThan(256);

    // No truncation warning expected
    expect(warnOutput).not.toContain('exceeded model context window');
  });
});
