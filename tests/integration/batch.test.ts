/**
 * Integration tests for src/batch.js
 *
 * Uses a hand-crafted in-memory DB (same pattern as queries.test.js / audit.test.js).
 *
 * Test graph (5 function nodes, 4 edges):
 *   authenticate → validateToken
 *   handleRoute  → authenticate
 *   handleRoute  → formatResponse
 *   formatResponse (leaf)
 *   validateToken  (leaf)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import {
  BATCH_COMMANDS,
  batchData,
  multiBatchData,
  splitTargets,
} from '../../src/features/batch.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function insertNode(db, name, kind, file, line) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind = 'calls', confidence = 1.0) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, 0)',
  ).run(sourceId, targetId, kind, confidence);
}

function insertComplexity(db, nodeId, cognitive, cyclomatic, maxNesting = 0) {
  db.prepare(
    'INSERT INTO function_complexity (node_id, cognitive, cyclomatic, max_nesting) VALUES (?, ?, ?, ?)',
  ).run(nodeId, cognitive, cyclomatic, maxNesting);
}

// ─── Fixture DB ────────────────────────────────────────────────────────

let tmpDir: string, dbPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-batch-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // File nodes
  const fileAuth = insertNode(db, 'src/auth.js', 'file', 'src/auth.js', 0);
  const fileRoutes = insertNode(db, 'src/routes.js', 'file', 'src/routes.js', 0);
  insertNode(db, 'src/utils.js', 'file', 'src/utils.js', 0);

  // Function nodes
  const fnAuth = insertNode(db, 'authenticate', 'function', 'src/auth.js', 5);
  const fnValidate = insertNode(db, 'validateToken', 'function', 'src/auth.js', 20);
  const fnRoute = insertNode(db, 'handleRoute', 'function', 'src/routes.js', 10);
  const fnFormat = insertNode(db, 'formatResponse', 'function', 'src/utils.js', 1);

  // File-level imports: routes → auth
  insertEdge(db, fileRoutes, fileAuth, 'imports');

  // Call edges
  insertEdge(db, fnAuth, fnValidate);
  insertEdge(db, fnRoute, fnAuth);
  insertEdge(db, fnRoute, fnFormat);

  // Complexity data, distinct per file, so batch complexity can be asserted
  // to scope results to the requested file rather than the whole repo.
  insertComplexity(db, fnAuth, 5, 2);
  insertComplexity(db, fnValidate, 3, 1);
  insertComplexity(db, fnRoute, 10, 4);
  insertComplexity(db, fnFormat, 1, 1);

  db.close();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── batchData: success cases ────────────────────────────────────────

describe('batchData — success', () => {
  test('query: multiple targets both succeed', () => {
    const data = batchData('query', ['authenticate', 'handleRoute'], dbPath);
    expect(data.command).toBe('query');
    expect(data.total).toBe(2);
    expect(data.succeeded).toBe(2);
    expect(data.failed).toBe(0);
    expect(data.results).toHaveLength(2);
    expect(data.results[0].ok).toBe(true);
    expect(data.results[0].target).toBe('authenticate');
    expect(data.results[0].data).toBeDefined();
    expect(data.results[1].ok).toBe(true);
    expect(data.results[1].target).toBe('handleRoute');
  });

  test('where: single target works', () => {
    const data = batchData('where', ['authenticate'], dbPath);
    expect(data.total).toBe(1);
    expect(data.succeeded).toBe(1);
    expect(data.results[0].ok).toBe(true);
    expect(data.results[0].data.target).toBe('authenticate');
  });

  test('explain: file targets', () => {
    const data = batchData('explain', ['src/auth.js', 'src/utils.js'], dbPath);
    expect(data.total).toBe(2);
    expect(data.succeeded).toBe(2);
    for (const r of data.results) {
      expect(r.ok).toBe(true);
      expect(r.data).toBeDefined();
    }
  });

  test('fn-impact: returns impact data', () => {
    const data = batchData('fn-impact', ['authenticate'], dbPath);
    expect(data.succeeded).toBe(1);
    expect(data.results[0].data.name).toBe('authenticate');
  });

  test('context: with depth option', () => {
    const data = batchData('context', ['authenticate'], dbPath, { depth: 1 });
    expect(data.succeeded).toBe(1);
    expect(data.results[0].ok).toBe(true);
  });
});

// ─── batchData: partial failure ──────────────────────────────────────

describe('batchData — partial failure', () => {
  test('non-existent target returns ok:true with empty results (no throw)', () => {
    // fnImpactData returns { name, results: [] } for non-existent symbols — it doesn't throw
    const data = batchData('fn-impact', ['authenticate', 'nonExistentSymbol'], dbPath);
    expect(data.total).toBe(2);
    expect(data.succeeded).toBe(2);
    expect(data.failed).toBe(0);
    const found = data.results.find((r) => r.target === 'authenticate');
    expect(found.ok).toBe(true);
    expect(found.data.results.length).toBeGreaterThanOrEqual(1);
    const notFound = data.results.find((r) => r.target === 'nonExistentSymbol');
    expect(notFound.ok).toBe(true);
    expect(notFound.data.results).toEqual([]);
  });

  test('errors are captured per-target when data function throws', () => {
    // Use a non-existent DB path to force an error per target
    const badDb = path.join(tmpDir, '.codegraph', 'nonexistent.db');
    const data = batchData('query', ['anything'], badDb);
    expect(data.total).toBe(1);
    expect(data.failed).toBe(1);
    expect(data.results[0].ok).toBe(false);
    expect(data.results[0].error).toBeDefined();
  });
});

// ─── batchData: edge cases ───────────────────────────────────────────

describe('batchData — edge cases', () => {
  test('empty targets returns empty results', () => {
    const data = batchData('query', [], dbPath);
    expect(data.total).toBe(0);
    expect(data.succeeded).toBe(0);
    expect(data.failed).toBe(0);
    expect(data.results).toEqual([]);
  });

  test('unknown command throws', () => {
    expect(() => batchData('invalid-cmd', ['add'], dbPath)).toThrow(/Unknown batch command/);
  });

  test('BATCH_COMMANDS has all expected keys', () => {
    const expected = [
      'fn-impact',
      'context',
      'explain',
      'where',
      'query',
      'impact',
      'deps',
      'flow',
      'dataflow',
      'complexity',
    ];
    for (const cmd of expected) {
      expect(BATCH_COMMANDS).toHaveProperty(cmd);
    }
  });

  test('shared opts are forwarded (noTests)', () => {
    const data = batchData('query', ['authenticate'], dbPath, { noTests: true });
    expect(data.succeeded).toBe(1);
    expect(data.results[0].ok).toBe(true);
  });
});

// ─── complexity (dbOnly sig) ─────────────────────────────────────────

describe('batchData — complexity (dbOnly signature)', () => {
  test('complexity command scopes each target to a file, not a symbol name (#1721)', () => {
    // Regression test for #1721: batch previously forwarded the file-path
    // target as opts.target (a symbol-name filter), so complexityData never
    // matched anything and silently fell back to identical, unfiltered
    // whole-repo results for every target. It must land in opts.file instead.
    const data = batchData('complexity', ['src/auth.js', 'src/routes.js'], dbPath);
    expect(data.total).toBe(2);
    expect(data.succeeded).toBe(2);

    const auth = data.results.find((r) => r.target === 'src/auth.js');
    const routes = data.results.find((r) => r.target === 'src/routes.js');
    expect(auth.ok).toBe(true);
    expect(routes.ok).toBe(true);

    // src/auth.js has authenticate (cognitive 5) + validateToken (cognitive 3)
    const authNames = auth.data.functions.map((f) => f.name).sort();
    expect(authNames).toEqual(['authenticate', 'validateToken']);

    // src/routes.js has only handleRoute (cognitive 10)
    const routeNames = routes.data.functions.map((f) => f.name);
    expect(routeNames).toEqual(['handleRoute']);

    // The two targets must not collapse into identical, unfiltered results.
    // (Note: `summary` is a whole-repo health metric independent of the file
    // filter, by design of complexityData — see #1807 for a separate,
    // pre-existing gap where it should but doesn't reflect the file scope.
    // The bug this test guards against is that `functions` came back empty
    // for every target because the file path was routed into a symbol-name
    // filter instead of the file filter.)
    expect(auth.data.functions).not.toEqual(routes.data.functions);
  });

  test('complexity command still accepts a bare symbol name via opts.target passthrough', () => {
    // BATCH_COMMANDS commands other than complexity keep symbol-name targets;
    // this guards that complexity's own --target-style filtering (via shared
    // opts, not the batch target) continues to work for direct callers.
    const data = batchData('complexity', ['src/auth.js'], dbPath, { target: 'valid' });
    expect(data.results[0].ok).toBe(true);
    const names = data.results[0].data.functions.map((f) => f.name);
    expect(names).toEqual(['validateToken']);
  });
});

// ─── CLI smoke test ──────────────────────────────────────────────────

describe('batch CLI', () => {
  const cliPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')),
    '../../src/cli.ts',
  );
  const loaderUrl = new URL('../../scripts/ts-resolve-loader.ts', import.meta.url).href;
  const NODE_TS_FLAGS = ['--experimental-strip-types', '--import', loaderUrl];

  test('outputs valid JSON', () => {
    const out = execFileSync(
      'node',
      [...NODE_TS_FLAGS, cliPath, 'batch', 'query', 'authenticate', '--db', dbPath],
      {
        encoding: 'utf-8',
        timeout: 30_000,
      },
    );
    const parsed = JSON.parse(out);
    expect(parsed.command).toBe('query');
    expect(parsed.total).toBe(1);
    expect(parsed.results).toHaveLength(1);
  });

  test('accepts --json flag without error (no-op)', () => {
    const out = execFileSync(
      'node',
      [...NODE_TS_FLAGS, cliPath, 'batch', 'query', 'authenticate', '--db', dbPath, '--json'],
      {
        encoding: 'utf-8',
        timeout: 30_000,
      },
    );
    const parsed = JSON.parse(out);
    expect(parsed.command).toBe('query');
    expect(parsed.total).toBe(1);
  });

  test('accepts -j flag without error (no-op)', () => {
    const out = execFileSync(
      'node',
      [...NODE_TS_FLAGS, cliPath, 'batch', 'query', 'authenticate', '--db', dbPath, '-j'],
      {
        encoding: 'utf-8',
        timeout: 30_000,
      },
    );
    const parsed = JSON.parse(out);
    expect(parsed.command).toBe('query');
    expect(parsed.total).toBe(1);
  });

  test('batch accepts comma-separated positional targets', () => {
    const out = execFileSync(
      'node',
      [...NODE_TS_FLAGS, cliPath, 'batch', 'where', 'authenticate,validateToken', '--db', dbPath],
      { encoding: 'utf-8', timeout: 30_000 },
    );
    const parsed = JSON.parse(out);
    expect(parsed.command).toBe('where');
    expect(parsed.total).toBe(2);
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results.map((r) => r.target)).toEqual(['authenticate', 'validateToken']);
  });
});

// ─── splitTargets ─────────────────────────────────────────────────────

describe('splitTargets', () => {
  test('splits comma-separated strings', () => {
    expect(splitTargets(['a,b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  test('trims whitespace', () => {
    expect(splitTargets([' a , b '])).toEqual(['a', 'b']);
  });

  test('filters empty segments', () => {
    expect(splitTargets(['a,,b', '', 'c'])).toEqual(['a', 'b', 'c']);
  });

  test('passes through object items unchanged', () => {
    const obj = { command: 'where', target: 'foo' };
    expect(splitTargets([obj, 'a,b'])).toEqual([obj, 'a', 'b']);
  });

  test('handles empty input', () => {
    expect(splitTargets([])).toEqual([]);
  });
});

// ─── multiBatchData ───────────────────────────────────────────────────

describe('multiBatchData', () => {
  test('mixed commands all succeed', () => {
    const items = [
      { command: 'where', target: 'authenticate' },
      { command: 'fn-impact', target: 'validateToken' },
      { command: 'explain', target: 'src/auth.js' },
    ];
    const result = multiBatchData(items, dbPath);
    expect(result.mode).toBe('multi');
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    for (const r of result.results) {
      expect(r.ok).toBe(true);
      expect(r.command).toBeDefined();
      expect(r.data).toBeDefined();
    }
  });

  test('invalid command captured per-item without breaking others', () => {
    const items = [
      { command: 'where', target: 'authenticate' },
      { command: 'not-a-command', target: 'foo' },
      { command: 'query', target: 'handleRoute' },
    ];
    const result = multiBatchData(items, dbPath);
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results[0].ok).toBe(true);
    expect(result.results[1].ok).toBe(false);
    expect(result.results[1].error).toMatch(/Unknown batch command/);
    expect(result.results[2].ok).toBe(true);
  });

  test('per-item opts override shared opts', () => {
    const items = [{ command: 'context', target: 'authenticate', opts: { depth: 1 } }];
    const result = multiBatchData(items, dbPath, { depth: 5 });
    expect(result.succeeded).toBe(1);
    expect(result.results[0].ok).toBe(true);
  });

  test('empty items returns empty results', () => {
    const result = multiBatchData([], dbPath);
    expect(result.mode).toBe('multi');
    expect(result.total).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results).toEqual([]);
  });

  test('error from data function captured per-item', () => {
    const badDb = path.join(tmpDir, '.codegraph', 'nonexistent.db');
    const items = [
      { command: 'query', target: 'authenticate' },
      { command: 'where', target: 'foo' },
    ];
    const result = multiBatchData(items, badDb);
    expect(result.total).toBe(2);
    expect(result.failed).toBe(2);
    for (const r of result.results) {
      expect(r.ok).toBe(false);
      expect(r.error).toBeDefined();
    }
  });
});
