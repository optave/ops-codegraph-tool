/**
 * Integration tests for all core query commands.
 * Uses a hand-crafted in-file DB for deterministic, fast tests.
 *
 * Test graph (9 nodes, 8 edges):
 *
 *   Files: auth.js, middleware.js, routes.js, utils.js
 *
 *   Import edges:
 *     middleware.js → auth.js
 *     routes.js    → middleware.js
 *     routes.js    → utils.js
 *
 *   Call edges:
 *     authMiddleware → authenticate
 *     authMiddleware → validateToken
 *     handleRoute    → authMiddleware
 *     handleRoute    → formatResponse
 *     authenticate   → validateToken
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db.js';
import {
  diffImpactData,
  fileDepsData,
  fnDepsData,
  fnImpactData,
  impactAnalysisData,
  moduleMapData,
  queryNameData,
} from '../../src/queries.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function insertNode(db, name, kind, file, line) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, 1.0, 0)',
  ).run(sourceId, targetId, kind);
}

// ─── Fixture DB ────────────────────────────────────────────────────────

let tmpDir, dbPath;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-queries-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // File nodes
  const fAuth = insertNode(db, 'auth.js', 'file', 'auth.js', 0);
  const fMw = insertNode(db, 'middleware.js', 'file', 'middleware.js', 0);
  const fRoutes = insertNode(db, 'routes.js', 'file', 'routes.js', 0);
  const fUtils = insertNode(db, 'utils.js', 'file', 'utils.js', 0);

  // Function nodes
  const authenticate = insertNode(db, 'authenticate', 'function', 'auth.js', 10);
  const validateToken = insertNode(db, 'validateToken', 'function', 'auth.js', 25);
  const authMiddleware = insertNode(db, 'authMiddleware', 'function', 'middleware.js', 5);
  const handleRoute = insertNode(db, 'handleRoute', 'function', 'routes.js', 10);
  const formatResponse = insertNode(db, 'formatResponse', 'function', 'utils.js', 1);

  // Import edges (file → file)
  insertEdge(db, fMw, fAuth, 'imports');
  insertEdge(db, fRoutes, fMw, 'imports');
  insertEdge(db, fRoutes, fUtils, 'imports');

  // Call edges (function → function)
  insertEdge(db, authMiddleware, authenticate, 'calls');
  insertEdge(db, authMiddleware, validateToken, 'calls');
  insertEdge(db, handleRoute, authMiddleware, 'calls');
  insertEdge(db, handleRoute, formatResponse, 'calls');
  insertEdge(db, authenticate, validateToken, 'calls');

  db.close();
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── queryNameData ─────────────────────────────────────────────────────

describe('queryNameData', () => {
  test('finds exact symbol with callers and callees', () => {
    const data = queryNameData('authenticate', dbPath);
    const fn = data.results.find((r) => r.kind === 'function' && r.name === 'authenticate');
    expect(fn).toBeDefined();
    expect(fn.callers.map((c) => c.name)).toContain('authMiddleware');
    expect(fn.callees.map((c) => c.name)).toContain('validateToken');
  });

  test('returns empty results for nonexistent name', () => {
    const data = queryNameData('nonexistent', dbPath);
    expect(data.results).toHaveLength(0);
  });

  test('partial match returns multiple results', () => {
    const data = queryNameData('auth', dbPath);
    const names = data.results.map((r) => r.name);
    expect(names).toContain('authenticate');
    expect(names).toContain('authMiddleware');
    expect(data.results.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── impactAnalysisData ────────────────────────────────────────────────

describe('impactAnalysisData', () => {
  test('returns transitive file dependents by level', () => {
    const data = impactAnalysisData('auth.js', dbPath);
    expect(data.sources).toContain('auth.js');

    const level1Files = data.levels[1].map((n) => n.file);
    expect(level1Files).toContain('middleware.js');

    const level2Files = data.levels[2].map((n) => n.file);
    expect(level2Files).toContain('routes.js');

    expect(data.totalDependents).toBe(2);
  });

  test('returns empty for unknown file', () => {
    const data = impactAnalysisData('nonexistent.js', dbPath);
    expect(data.sources).toHaveLength(0);
    expect(data.totalDependents).toBe(0);
  });
});

// ─── moduleMapData ─────────────────────────────────────────────────────

describe('moduleMapData', () => {
  test('returns files with connectivity info', () => {
    const data = moduleMapData(dbPath);
    expect(data.topNodes.length).toBe(4);
    expect(data.stats.totalFiles).toBe(4);
    for (const node of data.topNodes) {
      expect(node).toHaveProperty('file');
      expect(node).toHaveProperty('inEdges');
      expect(node).toHaveProperty('outEdges');
    }
  });

  test('respects limit parameter', () => {
    const data = moduleMapData(dbPath, 2);
    expect(data.topNodes).toHaveLength(2);
  });
});

// ─── fileDepsData ──────────────────────────────────────────────────────

describe('fileDepsData', () => {
  test('returns imports, importedBy, and definitions', () => {
    const data = fileDepsData('middleware.js', dbPath);
    const r = data.results[0];
    expect(r.file).toBe('middleware.js');
    expect(r.imports.map((i) => i.file)).toContain('auth.js');
    expect(r.importedBy.map((i) => i.file)).toContain('routes.js');
    expect(r.definitions.map((d) => d.name)).toContain('authMiddleware');
  });

  test('returns empty for unknown file', () => {
    const data = fileDepsData('nonexistent.js', dbPath);
    expect(data.results).toHaveLength(0);
  });
});

// ─── fnDepsData ────────────────────────────────────────────────────────

describe('fnDepsData', () => {
  test('returns callees and callers for handleRoute', () => {
    const data = fnDepsData('handleRoute', dbPath);
    const r = data.results[0];
    expect(r.callees.map((c) => c.name)).toContain('authMiddleware');
    expect(r.callees.map((c) => c.name)).toContain('formatResponse');
    expect(r.callers).toHaveLength(0);
  });

  test('returns callers from upstream for authMiddleware', () => {
    const data = fnDepsData('authMiddleware', dbPath);
    const r = data.results[0];
    expect(r.callees.map((c) => c.name)).toContain('authenticate');
    expect(r.callees.map((c) => c.name)).toContain('validateToken');
    expect(r.callers.map((c) => c.name)).toContain('handleRoute');
  });
});

// ─── fnImpactData ──────────────────────────────────────────────────────

describe('fnImpactData', () => {
  test('returns transitive callers by level', () => {
    const data = fnImpactData('authenticate', dbPath);
    const r = data.results[0];

    const level1 = r.levels[1].map((n) => n.name);
    expect(level1).toContain('authMiddleware');

    const level2 = r.levels[2].map((n) => n.name);
    expect(level2).toContain('handleRoute');

    expect(r.totalDependents).toBe(2);
  });

  test('respects depth option', () => {
    const data = fnImpactData('validateToken', dbPath, { depth: 1 });
    const r = data.results[0];
    expect(r.levels[1]).toBeDefined();
    expect(r.levels[1].length).toBeGreaterThanOrEqual(1);
    expect(r.levels[2]).toBeUndefined();
  });
});

// ─── diffImpactData ───────────────────────────────────────────────────

describe('diffImpactData', () => {
  test('returns error when run outside a git repo', () => {
    const data = diffImpactData(dbPath);
    expect(data).toHaveProperty('error');
    expect(data.error).toMatch(/not a git repository/i);
  });
});
