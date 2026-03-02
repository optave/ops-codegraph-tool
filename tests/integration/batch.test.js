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
import { BATCH_COMMANDS, batchData } from '../../src/batch.js';
import { initSchema } from '../../src/db.js';

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

// ─── Fixture DB ────────────────────────────────────────────────────────

let tmpDir, dbPath;

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

  test('fn: returns dependency chain', () => {
    const data = batchData('fn', ['handleRoute'], dbPath);
    expect(data.succeeded).toBe(1);
    expect(data.results[0].ok).toBe(true);
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
      'fn',
      'impact',
      'deps',
      'flow',
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
  test('complexity command uses target as opts.target', () => {
    const data = batchData('complexity', ['authenticate'], dbPath);
    expect(data.total).toBe(1);
    // complexityData returns functions array — it won't error for unknown targets
    expect(data.results[0].ok).toBe(true);
    expect(data.results[0].data).toHaveProperty('functions');
  });
});

// ─── CLI smoke test ──────────────────────────────────────────────────

describe('batch CLI', () => {
  test('outputs valid JSON', () => {
    const cliPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')),
      '../../src/cli.js',
    );
    const out = execFileSync('node', [cliPath, 'batch', 'query', 'authenticate', '--db', dbPath], {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    const parsed = JSON.parse(out);
    expect(parsed.command).toBe('query');
    expect(parsed.total).toBe(1);
    expect(parsed.results).toHaveLength(1);
  });
});
