import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { initSchema } from '../../src/db/index.js';

// ─── Mock setup ────────────────────────────────────────────────────────

// Hoisted so the mock factory can reference it
const { QUERY_VECTORS } = vi.hoisted(() => ({
  QUERY_VECTORS: new Map(),
}));

// Mock @huggingface/transformers so embed() returns controlled vectors
// without downloading or loading a real ML model.
vi.mock('@huggingface/transformers', () => ({
  pipeline: async () => async (batch) => {
    const dim = 384; // must match minilm config
    const data = new Float32Array(dim * batch.length);
    for (let t = 0; t < batch.length; t++) {
      const vec = QUERY_VECTORS.get(batch[t]);
      if (vec) {
        for (let i = 0; i < vec.length; i++) {
          data[t * dim + i] = vec[i];
        }
      }
    }
    return { data };
  },
  cos_sim: () => 0,
}));

import {
  cosineSim,
  ftsSearchData,
  hybridSearchData,
  multiSearchData,
  search,
  searchData,
} from '../../src/domain/search/index.js';

// ─── Helpers ───────────────────────────────────────────────────────────

/** Create a 384-dim vector with only the first N components set. */
function makeVec(components) {
  const vec = new Float32Array(384);
  for (let i = 0; i < components.length; i++) vec[i] = components[i];
  return vec;
}

function insertNode(db, name, kind, file, line) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid;
}

function insertEmbedding(db, nodeId, vec, preview, fullText) {
  db.prepare(
    'INSERT INTO embeddings (node_id, vector, text_preview, full_text) VALUES (?, ?, ?, ?)',
  ).run(nodeId, Buffer.from(vec.buffer), preview, fullText || preview);
}

function insertFts(db, nodeId, name, content) {
  db.prepare('INSERT INTO fts_index(rowid, name, content) VALUES (?, ?, ?)').run(
    nodeId,
    name,
    content,
  );
}

/** Capture console.log calls and return joined output. */
function captureLog(fn) {
  const lines = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));
  return fn().then(() => {
    spy.mockRestore();
    return lines.join('\n');
  });
}

// ─── Fixture DB ────────────────────────────────────────────────────────
//
// Nodes & vectors:
//   A  authenticate   [1, 0, 0]  — pure "auth"
//   B  validateJWT    [0, 1, 0]  — pure "jwt"
//   C  authMiddleware [√½, √½, 0] — both auth + jwt
//   D  formatDate     [0, 0, 1]  — unrelated
//
// Query vectors:
//   "auth"  → [1, 0, 0]   (cosine: A=1.0, C≈0.707)
//   "jwt"   → [0, 1, 0]   (cosine: B=1.0, C≈0.707)
//
// FTS5 content:
//   A: "function authenticate (authenticate) in src/auth.js"
//   B: "function validateJWT (validate JWT) in src/jwt.js"
//   C: "function authMiddleware (auth Middleware) in src/middleware.js"
//   D: "function formatDate (format Date) in src/utils.js"

let tmpDir, dbPath;
let noFtsDir, noFtsDbPath;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-'));
  dbPath = path.join(tmpDir, 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      node_id INTEGER PRIMARY KEY,
      vector BLOB NOT NULL,
      text_preview TEXT,
      full_text TEXT,
      FOREIGN KEY(node_id) REFERENCES nodes(id)
    );
    CREATE TABLE IF NOT EXISTS embedding_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_index USING fts5(
      name,
      content,
      tokenize='unicode61'
    );
  `);

  const idA = insertNode(db, 'authenticate', 'function', 'src/auth.js', 10);
  const idB = insertNode(db, 'validateJWT', 'function', 'src/jwt.js', 20);
  const idC = insertNode(db, 'authMiddleware', 'function', 'src/middleware.js', 5);
  const idD = insertNode(db, 'formatDate', 'function', 'src/utils.js', 1);

  const S = Math.SQRT1_2; // ≈ 0.7071
  const textA = 'function authenticate (authenticate) in src/auth.js\nValidate user credentials';
  const textB = 'function validateJWT (validate JWT) in src/jwt.js\nCheck JWT token validity';
  const textC =
    'function authMiddleware (auth Middleware) in src/middleware.js\nExpress auth middleware';
  const textD = 'function formatDate (format Date) in src/utils.js\nFormat a date object';

  insertEmbedding(db, idA, makeVec([1, 0, 0]), 'authenticate (function) -- src/auth.js:10', textA);
  insertEmbedding(db, idB, makeVec([0, 1, 0]), 'validateJWT (function) -- src/jwt.js:20', textB);
  insertEmbedding(
    db,
    idC,
    makeVec([S, S, 0]),
    'authMiddleware (function) -- src/middleware.js:5',
    textC,
  );
  insertEmbedding(db, idD, makeVec([0, 0, 1]), 'formatDate (function) -- src/utils.js:1', textD);

  // Populate FTS5 index
  insertFts(db, idA, 'authenticate', textA);
  insertFts(db, idB, 'validateJWT', textB);
  insertFts(db, idC, 'authMiddleware', textC);
  insertFts(db, idD, 'formatDate', textD);

  db.prepare(
    "INSERT INTO embedding_meta (key, value) VALUES ('model', 'Xenova/all-MiniLM-L6-v2')",
  ).run();
  db.prepare("INSERT INTO embedding_meta (key, value) VALUES ('dim', '384')").run();
  db.prepare("INSERT INTO embedding_meta (key, value) VALUES ('count', '4')").run();
  db.prepare("INSERT INTO embedding_meta (key, value) VALUES ('fts_count', '4')").run();
  db.close();

  // Query vectors used by the mocked embed()
  QUERY_VECTORS.set('auth', makeVec([1, 0, 0]));
  QUERY_VECTORS.set('jwt', makeVec([0, 1, 0]));
  QUERY_VECTORS.set('authenticate', makeVec([0.99, 0.1, 0])); // very similar to 'auth'
  QUERY_VECTORS.set('"authenticate"', makeVec([0.99, 0.1, 0]));
  QUERY_VECTORS.set('"formatDate"', makeVec([0, 0, 1]));
  QUERY_VECTORS.set('buildGraph', makeVec([0.2, 0.2, 0.2]));
  QUERY_VECTORS.set('"buildGraph"', makeVec([0.2, 0.2, 0.2]));

  // ─── Second DB without FTS5 (for fallback tests) ────────────────────
  noFtsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-nofts-'));
  noFtsDbPath = path.join(noFtsDir, 'graph.db');
  const db2 = new Database(noFtsDbPath);
  db2.pragma('journal_mode = WAL');
  initSchema(db2);
  db2.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      node_id INTEGER PRIMARY KEY,
      vector BLOB NOT NULL,
      text_preview TEXT,
      FOREIGN KEY(node_id) REFERENCES nodes(id)
    );
    CREATE TABLE IF NOT EXISTS embedding_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  const nfIdA = insertNode(db2, 'hello', 'function', 'src/hello.js', 1);
  db2
    .prepare('INSERT INTO embeddings (node_id, vector, text_preview) VALUES (?, ?, ?)')
    .run(nfIdA, Buffer.from(makeVec([1, 0, 0]).buffer), 'hello (function) -- src/hello.js:1');
  db2
    .prepare("INSERT INTO embedding_meta (key, value) VALUES ('model', 'Xenova/all-MiniLM-L6-v2')")
    .run();
  db2.prepare("INSERT INTO embedding_meta (key, value) VALUES ('dim', '384')").run();
  db2.prepare("INSERT INTO embedding_meta (key, value) VALUES ('count', '1')").run();
  db2.close();
  QUERY_VECTORS.set('hello', makeVec([1, 0, 0]));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(noFtsDir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────────────────

describe('cosineSim', () => {
  test('identical vectors → 1', () => {
    expect(cosineSim(new Float32Array([1, 0, 0]), new Float32Array([1, 0, 0]))).toBeCloseTo(1.0);
  });

  test('orthogonal vectors → 0', () => {
    expect(cosineSim(new Float32Array([1, 0, 0]), new Float32Array([0, 1, 0]))).toBeCloseTo(0.0);
  });

  test('45-degree vectors → ~0.707', () => {
    const S = Math.SQRT1_2;
    expect(cosineSim(new Float32Array([1, 0, 0]), new Float32Array([S, S, 0]))).toBeCloseTo(S, 3);
  });
});

describe('searchData', () => {
  test('returns matching results sorted by similarity', async () => {
    const data = await searchData('auth', dbPath, { minScore: 0.2 });
    expect(data).not.toBeNull();
    expect(data.results).toHaveLength(2);
    expect(data.results[0].name).toBe('authenticate');
    expect(data.results[0].similarity).toBeCloseTo(1.0);
    expect(data.results[1].name).toBe('authMiddleware');
    expect(data.results[1].similarity).toBeCloseTo(Math.SQRT1_2, 3);
  });

  test('respects minScore filter', async () => {
    const data = await searchData('auth', dbPath, { minScore: 0.8 });
    expect(data).not.toBeNull();
    expect(data.results).toHaveLength(1);
    expect(data.results[0].name).toBe('authenticate');
  });

  test('respects limit', async () => {
    const data = await searchData('auth', dbPath, { minScore: 0.2, limit: 1 });
    expect(data).not.toBeNull();
    expect(data.results).toHaveLength(1);
  });

  test('result shape has expected fields', async () => {
    const data = await searchData('auth', dbPath, { minScore: 0.2, limit: 1 });
    const r = data.results[0];
    expect(r).toHaveProperty('name');
    expect(r).toHaveProperty('kind');
    expect(r).toHaveProperty('file');
    expect(r).toHaveProperty('line');
    expect(r).toHaveProperty('similarity');
  });
});

describe('multiSearchData', () => {
  test('RRF ranks results appearing in multiple queries higher', async () => {
    const data = await multiSearchData(['auth', 'jwt'], dbPath, { minScore: 0.2 });
    expect(data).not.toBeNull();
    // authMiddleware appears in both query results → highest RRF
    expect(data.results[0].name).toBe('authMiddleware');
    expect(data.results[0].rrf).toBeGreaterThan(data.results[1].rrf);
  });

  test('returns per-query scores for each result', async () => {
    const data = await multiSearchData(['auth', 'jwt'], dbPath, { minScore: 0.2 });
    const mw = data.results.find((r) => r.name === 'authMiddleware');
    expect(mw.queryScores).toHaveLength(2);
    for (const qs of mw.queryScores) {
      expect(qs).toHaveProperty('query');
      expect(qs).toHaveProperty('similarity');
      expect(qs).toHaveProperty('rank');
    }
  });

  test('lower rrfK produces higher scores', async () => {
    const d60 = await multiSearchData(['auth', 'jwt'], dbPath, { minScore: 0.2, rrfK: 60 });
    const d10 = await multiSearchData(['auth', 'jwt'], dbPath, { minScore: 0.2, rrfK: 10 });
    expect(d10.results[0].rrf).toBeGreaterThan(d60.results[0].rrf);
  });

  test('respects limit', async () => {
    const data = await multiSearchData(['auth', 'jwt'], dbPath, { minScore: 0.2, limit: 1 });
    expect(data.results).toHaveLength(1);
  });

  test('warns when queries are too similar', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {});
    await multiSearchData(['auth', 'authenticate'], dbPath, { minScore: 0.2 });
    const output = spy.mock.calls.map((c) => c[0]).join('');
    expect(output).toContain('very similar');
    expect(output).toContain('bias RRF');
    spy.mockRestore();
  });

  test('does not warn when queries are distinct', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {});
    await multiSearchData(['auth', 'jwt'], dbPath, { minScore: 0.2 });
    const output = spy.mock.calls.map((c) => c[0]).join('');
    expect(output).not.toContain('very similar');
    spy.mockRestore();
  });
});

describe('searchData file pattern', () => {
  test('glob src/*.js matches only direct children of src/', async () => {
    const data = await searchData('auth', dbPath, { minScore: 0.01, filePattern: 'src/*.js' });
    expect(data).not.toBeNull();
    for (const r of data.results) {
      expect(r.file).toMatch(/^src\/[^/]+\.js$/);
    }
  });

  test('plain substring auth still works (backward compat)', async () => {
    const data = await searchData('auth', dbPath, { minScore: 0.01, filePattern: 'auth' });
    expect(data).not.toBeNull();
    for (const r of data.results) {
      expect(r.file).toContain('auth');
    }
  });
});

// ─── FTS5 keyword search tests ─────────────────────────────────────────

describe('ftsSearchData', () => {
  test('returns results sorted by BM25 score', () => {
    const data = ftsSearchData('authenticate', dbPath);
    expect(data).not.toBeNull();
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results[0].name).toBe('authenticate');
    expect(data.results[0].bm25Score).toBeGreaterThan(0);
  });

  test('respects limit parameter', () => {
    const data = ftsSearchData('function', dbPath, { limit: 2 });
    expect(data).not.toBeNull();
    expect(data.results.length).toBeLessThanOrEqual(2);
  });

  test('respects kind filter', () => {
    const data = ftsSearchData('authenticate', dbPath, { kind: 'function' });
    expect(data).not.toBeNull();
    for (const r of data.results) {
      expect(r.kind).toBe('function');
    }
  });

  test('respects noTests filter', () => {
    // Our fixture has no test files, so all results should pass
    const data = ftsSearchData('authenticate', dbPath, { noTests: true });
    expect(data).not.toBeNull();
    expect(data.results.length).toBeGreaterThan(0);
  });

  test('returns null when FTS5 table does not exist (old DB)', () => {
    const data = ftsSearchData('hello', noFtsDbPath);
    expect(data).toBeNull();
  });

  test('handles special characters in query without crashing', () => {
    const data = ftsSearchData('auth*"()', dbPath);
    expect(data).not.toBeNull();
    // Should return results or empty array, not throw
    expect(data.results).toBeInstanceOf(Array);
  });

  test('result shape has expected fields', () => {
    const data = ftsSearchData('authenticate', dbPath);
    const r = data.results[0];
    expect(r).toHaveProperty('name');
    expect(r).toHaveProperty('kind');
    expect(r).toHaveProperty('file');
    expect(r).toHaveProperty('line');
    expect(r).toHaveProperty('bm25Score');
  });

  test('returns empty results for query with no matches', () => {
    const data = ftsSearchData('zzzznonexistent', dbPath);
    expect(data).not.toBeNull();
    expect(data.results).toHaveLength(0);
  });
});

// ─── Hybrid search tests ───────────────────────────────────────────────

describe('hybridSearchData', () => {
  test('RRF fusion produces higher scores for results in both BM25 and semantic', async () => {
    const data = await hybridSearchData('authenticate', dbPath, { minScore: 0.01 });
    expect(data).not.toBeNull();
    expect(data.results.length).toBeGreaterThan(0);

    // authenticate should rank high — it appears in both BM25 (exact match) and semantic
    const auth = data.results.find((r) => r.name === 'authenticate');
    expect(auth).toBeDefined();
    expect(auth.rrf).toBeGreaterThan(0);
  });

  test('a result in BM25-only still appears', async () => {
    // "formatDate" text matches BM25 for "format" but may not match semantically
    const data = await hybridSearchData('formatDate', dbPath, { minScore: 0.01 });
    expect(data).not.toBeNull();
    const fd = data.results.find((r) => r.name === 'formatDate');
    expect(fd).toBeDefined();
  });

  test('respects rrfK parameter', async () => {
    const d60 = await hybridSearchData('authenticate', dbPath, { minScore: 0.01, rrfK: 60 });
    const d10 = await hybridSearchData('authenticate', dbPath, { minScore: 0.01, rrfK: 10 });
    expect(d60).not.toBeNull();
    expect(d10).not.toBeNull();
    // Lower k = higher RRF scores
    expect(d10.results[0].rrf).toBeGreaterThan(d60.results[0].rrf);
  });

  test('falls back to null when no FTS5 index', async () => {
    const data = await hybridSearchData('hello', noFtsDbPath, { minScore: 0.01 });
    expect(data).toBeNull();
  });

  test('result shape has hybrid fields', async () => {
    const data = await hybridSearchData('authenticate', dbPath, { minScore: 0.01 });
    expect(data).not.toBeNull();
    const r = data.results[0];
    expect(r).toHaveProperty('rrf');
    expect(r).toHaveProperty('name');
    expect(r).toHaveProperty('kind');
    expect(r).toHaveProperty('file');
    expect(r).toHaveProperty('line');
    // At least one of these should be non-null
    expect(r.bm25Rank !== null || r.semanticRank !== null).toBe(true);
  });

  test('multi-query with semicolons works', async () => {
    const data = await hybridSearchData('auth ; jwt', dbPath, { minScore: 0.01 });
    expect(data).not.toBeNull();
    expect(data.results.length).toBeGreaterThan(0);
  });
});

// ─── search CLI wrapper tests ──────────────────────────────────────────

describe('search (CLI wrapper)', () => {
  test('mode: semantic — single query prints similarity format', async () => {
    const out = await captureLog(() => search('auth', dbPath, { minScore: 0.2, mode: 'semantic' }));
    expect(out).toContain('Semantic search: "auth"');
    expect(out).toContain('%');
    expect(out).toContain('authenticate');
  });

  test('mode: semantic — semicolons trigger multi-query RRF format', async () => {
    const out = await captureLog(() =>
      search('auth ; jwt', dbPath, { minScore: 0.2, mode: 'semantic' }),
    );
    expect(out).toContain('Multi-query semantic search');
    expect(out).toContain('RRF');
    expect(out).toContain('[1] "auth"');
    expect(out).toContain('[2] "jwt"');
  });

  test('mode: semantic — trailing semicolons fall back to single-query', async () => {
    const out = await captureLog(() =>
      search('auth ;', dbPath, { minScore: 0.2, mode: 'semantic' }),
    );
    expect(out).toContain('Semantic search: "auth"');
    expect(out).not.toContain('Multi-query');
  });

  test('mode: semantic — json output has similarity', async () => {
    const out = await captureLog(() =>
      search('auth', dbPath, { minScore: 0.2, json: true, mode: 'semantic' }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.results).toBeInstanceOf(Array);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0]).toHaveProperty('similarity');
    expect(parsed.results[0]).toHaveProperty('name');
  });

  test('mode: semantic — multi query json has rrf and queryScores', async () => {
    const out = await captureLog(() =>
      search('auth ; jwt', dbPath, { minScore: 0.2, json: true, mode: 'semantic' }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.results).toBeInstanceOf(Array);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0]).toHaveProperty('rrf');
    expect(parsed.results[0]).toHaveProperty('queryScores');
  });

  test('mode: keyword — prints BM25 format', async () => {
    const out = await captureLog(() => search('authenticate', dbPath, { mode: 'keyword' }));
    expect(out).toContain('Keyword search');
    expect(out).toContain('BM25');
    expect(out).toContain('authenticate');
  });

  test('mode: keyword — json output has bm25Score', async () => {
    const out = await captureLog(() =>
      search('authenticate', dbPath, { json: true, mode: 'keyword' }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.results).toBeInstanceOf(Array);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0]).toHaveProperty('bm25Score');
  });

  test('mode: keyword — no FTS5 index prints error', async () => {
    const out = await captureLog(() => search('hello', noFtsDbPath, { mode: 'keyword' }));
    expect(out).toContain('No FTS5 index found');
  });

  test('default mode (hybrid) — prints hybrid format', async () => {
    const out = await captureLog(() => search('authenticate', dbPath, { minScore: 0.01 }));
    expect(out).toContain('Hybrid search');
    expect(out).toContain('BM25 + semantic');
  });

  test('default mode (hybrid) — json output has rrf and bm25/semantic breakdown', async () => {
    const out = await captureLog(() =>
      search('authenticate', dbPath, { minScore: 0.01, json: true }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.results).toBeInstanceOf(Array);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0]).toHaveProperty('rrf');
  });

  test('hybrid mode falls back to semantic when no FTS5 index', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {});
    const out = await captureLog(() => search('hello', noFtsDbPath, { minScore: 0.01 }));
    const stderrOutput = spy.mock.calls.map((c) => c[0]).join('');
    spy.mockRestore();
    // Should fall back gracefully and still produce output
    expect(stderrOutput).toContain('FTS5 index not found');
    expect(out).toContain('Semantic search');
  });

  test('multi-query hybrid works', async () => {
    const out = await captureLog(() => search('auth ; jwt', dbPath, { minScore: 0.01 }));
    expect(out).toContain('Hybrid');
    expect(out).toContain('RRF');
  });
});
