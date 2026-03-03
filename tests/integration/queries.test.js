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
  explainData,
  exportsData,
  fileDepsData,
  fnDepsData,
  fnImpactData,
  impactAnalysisData,
  listFunctionsData,
  moduleMapData,
  pathData,
  queryNameData,
  rolesData,
  statsData,
  whereData,
} from '../../src/queries.js';

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
  const preAuthenticate = insertNode(db, 'preAuthenticate', 'function', 'utils.js', 10);

  // Test file + function
  const fTest = insertNode(db, 'auth.test.js', 'file', 'auth.test.js', 0);
  const testAuth = insertNode(db, 'testAuthenticate', 'function', 'auth.test.js', 5);

  // Import edges (file → file)
  insertEdge(db, fMw, fAuth, 'imports');
  insertEdge(db, fRoutes, fMw, 'imports');
  insertEdge(db, fRoutes, fUtils, 'imports');
  insertEdge(db, fTest, fAuth, 'imports');

  // Call edges (function → function)
  insertEdge(db, authMiddleware, authenticate, 'calls');
  insertEdge(db, authMiddleware, validateToken, 'calls');
  insertEdge(db, handleRoute, authMiddleware, 'calls');
  insertEdge(db, handleRoute, formatResponse, 'calls');
  insertEdge(db, authenticate, validateToken, 'calls');
  insertEdge(db, handleRoute, preAuthenticate, 'calls');
  insertEdge(db, testAuth, authenticate, 'calls');
  // Low-confidence call edge for quality tests
  insertEdge(db, formatResponse, validateToken, 'calls', 0.3);

  // File hashes (for fileHash exposure)
  for (const f of ['auth.js', 'middleware.js', 'routes.js', 'utils.js', 'auth.test.js']) {
    db.prepare('INSERT INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)').run(
      f,
      `hash_${f.replace('.', '_')}`,
      Date.now(),
      100,
    );
  }

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
    expect(fn.fileHash).toBe('hash_auth_js');
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
    expect(level1Files).toContain('auth.test.js');

    const level2Files = data.levels[2].map((n) => n.file);
    expect(level2Files).toContain('routes.js');

    expect(data.totalDependents).toBe(3);
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
    expect(data.topNodes.length).toBe(5);
    expect(data.stats.totalFiles).toBe(5);
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

  test('excludes contains edges from ranking and counts', () => {
    // Build a separate DB with contains + imports edges
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-contains-'));
    fs.mkdirSync(path.join(tmpDir2, '.codegraph'));
    const dbPath2 = path.join(tmpDir2, '.codegraph', 'graph.db');

    const db2 = new Database(dbPath2);
    db2.pragma('journal_mode = WAL');
    initSchema(db2);

    // Two file nodes
    const fA = insertNode(db2, 'a.js', 'file', 'a.js', 0);
    const fB = insertNode(db2, 'b.js', 'file', 'b.js', 0);
    const fC = insertNode(db2, 'c.js', 'file', 'c.js', 0);

    // a.js gets only a contains edge (structural)
    insertEdge(db2, fC, fA, 'contains');
    // b.js gets an imports edge (real dependency)
    insertEdge(db2, fC, fB, 'imports');

    db2.close();

    try {
      const data = moduleMapData(dbPath2);
      const nodeA = data.topNodes.find((n) => n.file === 'a.js');
      const nodeB = data.topNodes.find((n) => n.file === 'b.js');

      // b.js (imports edge) should have inEdges=1, a.js (contains edge) should have inEdges=0
      expect(nodeB.inEdges).toBe(1);
      expect(nodeA.inEdges).toBe(0);

      // b.js should rank above a.js
      const indexA = data.topNodes.indexOf(nodeA);
      const indexB = data.topNodes.indexOf(nodeB);
      expect(indexB).toBeLessThan(indexA);

      // c.js outEdges should only count the imports edge, not contains
      const nodeC = data.topNodes.find((n) => n.file === 'c.js');
      expect(nodeC.outEdges).toBe(1);
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
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

  test('exact match ranks above substring match', () => {
    const data = fnDepsData('authenticate', dbPath);
    const names = data.results.map((r) => r.name);
    // 'authenticate' is exact (100), 'preAuthenticate' is substring (10)
    expect(names).toContain('authenticate');
    expect(names).toContain('preAuthenticate');
    expect(names.indexOf('authenticate')).toBeLessThan(names.indexOf('preAuthenticate'));
  });

  test('prefix match returns multiple results', () => {
    const data = fnDepsData('auth', dbPath);
    const names = data.results.map((r) => r.name);
    expect(names).toContain('authenticate');
    expect(names).toContain('authMiddleware');
  });

  test('--file scopes to a single file', () => {
    const data = fnDepsData('auth', dbPath, { file: 'auth.js' });
    for (const r of data.results) {
      expect(r.file).toContain('auth.js');
    }
    // authMiddleware is in middleware.js, should be excluded
    const names = data.results.map((r) => r.name);
    expect(names).not.toContain('authMiddleware');
  });

  test('--kind method filters to methods only', () => {
    // All fixtures are functions, so filtering by method should return empty
    const data = fnDepsData('auth', dbPath, { kind: 'method' });
    expect(data.results).toHaveLength(0);
  });

  test('--file and --kind work together', () => {
    const data = fnDepsData('auth', dbPath, { file: 'auth.js', kind: 'function' });
    for (const r of data.results) {
      expect(r.file).toContain('auth.js');
      expect(r.kind).toBe('function');
    }
  });
});

// ─── fnImpactData ──────────────────────────────────────────────────────

describe('fnImpactData', () => {
  test('returns transitive callers by level', () => {
    const data = fnImpactData('authenticate', dbPath);
    const r = data.results[0];

    const level1 = r.levels[1].map((n) => n.name);
    expect(level1).toContain('authMiddleware');
    expect(level1).toContain('testAuthenticate');

    const level2 = r.levels[2].map((n) => n.name);
    expect(level2).toContain('handleRoute');

    expect(r.totalDependents).toBe(3);
  });

  test('respects depth option', () => {
    const data = fnImpactData('validateToken', dbPath, { depth: 1 });
    const r = data.results[0];
    expect(r.levels[1]).toBeDefined();
    expect(r.levels[1].length).toBeGreaterThanOrEqual(1);
    expect(r.levels[2]).toBeUndefined();
  });
});

// ─── pathData ─────────────────────────────────────────────────────────

describe('pathData', () => {
  test('finds direct 1-hop path', () => {
    const data = pathData('authMiddleware', 'authenticate', dbPath);
    expect(data.found).toBe(true);
    expect(data.hops).toBe(1);
    expect(data.path).toHaveLength(2);
    expect(data.path[0].name).toBe('authMiddleware');
    expect(data.path[0].edgeKind).toBeNull();
    expect(data.path[1].name).toBe('authenticate');
    expect(data.path[1].edgeKind).toBe('calls');
  });

  test('finds multi-hop path', () => {
    const data = pathData('handleRoute', 'validateToken', dbPath);
    expect(data.found).toBe(true);
    expect(data.hops).toBe(2);
    expect(data.path).toHaveLength(3);
    expect(data.path[0].name).toBe('handleRoute');
    expect(data.path[data.path.length - 1].name).toBe('validateToken');
  });

  test('returns not found when no forward path exists', () => {
    const data = pathData('validateToken', 'handleRoute', dbPath);
    expect(data.found).toBe(false);
    expect(data.path).toHaveLength(0);
  });

  test('reverse direction finds upstream path', () => {
    const data = pathData('validateToken', 'handleRoute', dbPath, { reverse: true });
    expect(data.found).toBe(true);
    expect(data.hops).toBeGreaterThanOrEqual(1);
    expect(data.path[0].name).toBe('validateToken');
    expect(data.path[data.path.length - 1].name).toBe('handleRoute');
    expect(data.reverse).toBe(true);
  });

  test('self-path returns 0 hops', () => {
    const data = pathData('authenticate', 'authenticate', dbPath);
    expect(data.found).toBe(true);
    expect(data.hops).toBe(0);
    expect(data.path).toHaveLength(1);
    expect(data.path[0].name).toBe('authenticate');
  });

  test('maxDepth limits search', () => {
    // handleRoute → validateToken is 2 hops; maxDepth=1 should miss it
    const data = pathData('handleRoute', 'validateToken', dbPath, { maxDepth: 1 });
    expect(data.found).toBe(false);
  });

  test('nonexistent from symbol returns error', () => {
    const data = pathData('nonexistent', 'authenticate', dbPath);
    expect(data.found).toBe(false);
    expect(data.error).toContain('nonexistent');
  });

  test('nonexistent to symbol returns error', () => {
    const data = pathData('authenticate', 'nonexistent', dbPath);
    expect(data.found).toBe(false);
    expect(data.error).toContain('nonexistent');
  });

  test('noTests filters test file nodes', () => {
    // testAuthenticate → authenticate exists, but with noTests testAuthenticate is excluded
    const data = pathData('testAuthenticate', 'validateToken', dbPath, { noTests: true });
    expect(data.found).toBe(false);
    expect(data.fromCandidates).toHaveLength(0);
  });

  test('alternateCount reports alternate shortest paths', () => {
    // handleRoute → validateToken: two 2-hop paths
    //   handleRoute → authMiddleware → validateToken
    //   handleRoute → authenticate → validateToken
    // (also handleRoute → formatResponse → validateToken at 0.3 confidence)
    const data = pathData('handleRoute', 'validateToken', dbPath);
    expect(data.found).toBe(true);
    expect(data.alternateCount).toBeGreaterThanOrEqual(1);
  });

  test('populates fromCandidates and toCandidates', () => {
    const data = pathData('authMiddleware', 'authenticate', dbPath);
    expect(data.fromCandidates.length).toBeGreaterThanOrEqual(1);
    expect(data.toCandidates.length).toBeGreaterThanOrEqual(1);
    expect(data.fromCandidates[0]).toHaveProperty('name');
    expect(data.fromCandidates[0]).toHaveProperty('file');
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

// ─── explainData ──────────────────────────────────────────────────────

describe('explainData', () => {
  test('file-level: returns public/internal split with imports', () => {
    const data = explainData('auth.js', dbPath);
    expect(data.kind).toBe('file');
    expect(data.results).toHaveLength(1);

    const r = data.results[0];
    expect(r.file).toBe('auth.js');
    expect(r.symbolCount).toBe(2);
    // Both authenticate and validateToken are called from middleware.js
    expect(r.publicApi.map((s) => s.name)).toContain('authenticate');
    expect(r.publicApi.map((s) => s.name)).toContain('validateToken');
    // auth.js doesn't import anything
    expect(r.imports).toHaveLength(0);
    expect(r.importedBy.map((i) => i.file)).toContain('middleware.js');
  });

  test('file-level: data flow shows intra-file calls', () => {
    const data = explainData('auth.js', dbPath);
    const r = data.results[0];
    const authFlow = r.dataFlow.find((df) => df.caller === 'authenticate');
    expect(authFlow).toBeDefined();
    expect(authFlow.callees).toContain('validateToken');
  });

  test('file-level: empty for unknown file', () => {
    const data = explainData('nonexistent.js', dbPath);
    expect(data.kind).toBe('file');
    expect(data.results).toHaveLength(0);
  });

  test('function-level: callees and callers', () => {
    const data = explainData('authMiddleware', dbPath);
    expect(data.kind).toBe('function');
    expect(data.results).toHaveLength(1);

    const r = data.results[0];
    expect(r.name).toBe('authMiddleware');
    expect(r.callees.map((c) => c.name)).toContain('authenticate');
    expect(r.callees.map((c) => c.name)).toContain('validateToken');
    expect(r.callers.map((c) => c.name)).toContain('handleRoute');
  });

  test('function-level: empty for unknown', () => {
    const data = explainData('nonexistentFunction', dbPath);
    expect(data.kind).toBe('function');
    expect(data.results).toHaveLength(0);
  });

  test('target detection: file path triggers file mode', () => {
    const data = explainData('auth.js', dbPath);
    expect(data.kind).toBe('file');
  });

  test('target detection: plain name triggers function mode', () => {
    const data = explainData('authenticate', dbPath);
    expect(data.kind).toBe('function');
  });

  test('target detection: path with slash triggers file mode', () => {
    const data = explainData('src/auth.js', dbPath);
    expect(data.kind).toBe('file');
  });
});

// ─── --no-tests filtering ──────────────────────────────────────────────

describe('--no-tests filtering', () => {
  test('fileDepsData excludes test files from importedBy with noTests', () => {
    const withTests = fileDepsData('auth.js', dbPath);
    const withoutTests = fileDepsData('auth.js', dbPath, { noTests: true });
    const r = withTests.results[0];
    expect(r.importedBy.map((i) => i.file)).toContain('auth.test.js');
    const rFiltered = withoutTests.results[0];
    expect(rFiltered.importedBy.map((i) => i.file)).not.toContain('auth.test.js');
  });
});

// ─── whereData ──────────────────────────────────────────────────────

describe('whereData', () => {
  test('symbol: finds definition with uses', () => {
    const data = whereData('authMiddleware', dbPath);
    expect(data.mode).toBe('symbol');
    const r = data.results.find((r) => r.name === 'authMiddleware');
    expect(r).toBeDefined();
    expect(r.file).toBe('middleware.js');
    expect(r.line).toBe(5);
    expect(r.uses.map((u) => u.name)).toContain('handleRoute');
    expect(r.fileHash).toBe('hash_middleware_js');
  });

  test('symbol: exported flag', () => {
    const data = whereData('authenticate', dbPath);
    const r = data.results.find((r) => r.name === 'authenticate');
    expect(r).toBeDefined();
    // authenticate is called from middleware.js (cross-file)
    expect(r.exported).toBe(true);
  });

  test('symbol: empty for unknown', () => {
    const data = whereData('nonexistent', dbPath);
    expect(data.mode).toBe('symbol');
    expect(data.results).toHaveLength(0);
  });

  test('symbol: multiple matches', () => {
    const data = whereData('auth', dbPath);
    const names = data.results.map((r) => r.name);
    expect(names).toContain('authenticate');
    expect(names).toContain('authMiddleware');
  });

  test('file: lists symbols and imports', () => {
    const data = whereData('middleware.js', dbPath, { file: true });
    expect(data.mode).toBe('file');
    expect(data.results).toHaveLength(1);
    const r = data.results[0];
    expect(r.symbols.map((s) => s.name)).toContain('authMiddleware');
    expect(r.imports).toContain('auth.js');
    expect(r.importedBy).toContain('routes.js');
    expect(r.fileHash).toBe('hash_middleware_js');
  });

  test('file: exported list', () => {
    const data = whereData('middleware.js', dbPath, { file: true });
    const r = data.results[0];
    // authMiddleware is called from routes.js (cross-file)
    expect(r.exported).toContain('authMiddleware');
  });

  test('file: empty for unknown', () => {
    const data = whereData('nonexistent.js', dbPath, { file: true });
    expect(data.mode).toBe('file');
    expect(data.results).toHaveLength(0);
  });
});

// ─── noTests filtering ───────────────────────────────────────────────

describe('noTests filtering', () => {
  test('queryNameData excludes test file nodes and callers', () => {
    const all = queryNameData('authenticate', dbPath);
    const filtered = queryNameData('authenticate', dbPath, { noTests: true });

    const allFn = all.results.find((r) => r.name === 'authenticate' && r.kind === 'function');
    const filteredFn = filtered.results.find(
      (r) => r.name === 'authenticate' && r.kind === 'function',
    );

    // testAuthenticate should be in callers without filter
    expect(allFn.callers.map((c) => c.name)).toContain('testAuthenticate');
    // testAuthenticate should be excluded with noTests
    expect(filteredFn.callers.map((c) => c.name)).not.toContain('testAuthenticate');
  });

  test('queryNameData excludes test file results', () => {
    const all = queryNameData('testAuthenticate', dbPath);
    const filtered = queryNameData('testAuthenticate', dbPath, { noTests: true });

    expect(all.results).toHaveLength(1);
    expect(filtered.results).toHaveLength(0);
  });

  test('statsData excludes test files from counts', () => {
    const all = statsData(dbPath);
    const filtered = statsData(dbPath, { noTests: true });

    // File count should be lower
    expect(filtered.files.total).toBeLessThan(all.files.total);
    // Node count should be lower (test file + testAuthenticate removed)
    expect(filtered.nodes.total).toBeLessThan(all.nodes.total);
    // Edge count should be lower (test import + test call edge removed)
    expect(filtered.edges.total).toBeLessThan(all.edges.total);
  });

  test('statsData hotspots exclude test files', () => {
    const filtered = statsData(dbPath, { noTests: true });
    for (const h of filtered.hotspots) {
      expect(h.file).not.toMatch(/\.test\./);
    }
  });

  test('impactAnalysisData excludes test dependents', () => {
    const all = impactAnalysisData('auth.js', dbPath);
    const filtered = impactAnalysisData('auth.js', dbPath, { noTests: true });

    const allFiles = Object.values(all.levels)
      .flat()
      .map((f) => f.file);
    const filteredFiles = Object.values(filtered.levels)
      .flat()
      .map((f) => f.file);

    expect(allFiles).toContain('auth.test.js');
    expect(filteredFiles).not.toContain('auth.test.js');
  });

  test('fileDepsData excludes test importers', () => {
    const all = fileDepsData('auth.js', dbPath);
    const filtered = fileDepsData('auth.js', dbPath, { noTests: true });

    const allImportedBy = all.results[0].importedBy.map((i) => i.file);
    const filteredImportedBy = filtered.results[0].importedBy.map((i) => i.file);

    expect(allImportedBy).toContain('auth.test.js');
    expect(filteredImportedBy).not.toContain('auth.test.js');
  });

  test('moduleMapData excludes test files', () => {
    const all = moduleMapData(dbPath, 20);
    const filtered = moduleMapData(dbPath, 20, { noTests: true });

    const allFiles = all.topNodes.map((n) => n.file);
    const filteredFiles = filtered.topNodes.map((n) => n.file);

    expect(allFiles).toContain('auth.test.js');
    expect(filteredFiles).not.toContain('auth.test.js');
  });
});

// ─── Stable symbol schema conformance ──────────────────────────────────

const STABLE_FIELDS = ['name', 'kind', 'file', 'line', 'endLine', 'role', 'fileHash'];

function expectStableSymbol(sym) {
  for (const field of STABLE_FIELDS) {
    expect(sym).toHaveProperty(field);
  }
  expect(typeof sym.name).toBe('string');
  expect(typeof sym.kind).toBe('string');
  expect(typeof sym.file).toBe('string');
  expect(typeof sym.line).toBe('number');
  // endLine, role, fileHash may be null
  expect(sym.endLine === null || typeof sym.endLine === 'number').toBe(true);
  expect(sym.role === null || typeof sym.role === 'string').toBe(true);
  expect(sym.fileHash === null || typeof sym.fileHash === 'string').toBe(true);
}

describe('stable symbol schema', () => {
  test('queryNameData results have all 7 stable fields', () => {
    const data = queryNameData('authenticate', dbPath);
    expect(data.results.length).toBeGreaterThan(0);
    for (const r of data.results) {
      expectStableSymbol(r);
    }
  });

  test('fnDepsData results have all 7 stable fields', () => {
    const data = fnDepsData('handleRoute', dbPath);
    expect(data.results.length).toBeGreaterThan(0);
    for (const r of data.results) {
      expectStableSymbol(r);
    }
  });

  test('fnImpactData results have all 7 stable fields', () => {
    const data = fnImpactData('authenticate', dbPath);
    expect(data.results.length).toBeGreaterThan(0);
    for (const r of data.results) {
      expectStableSymbol(r);
    }
  });

  test('whereData (symbol) results have all 7 stable fields', () => {
    const data = whereData('authMiddleware', dbPath);
    expect(data.results.length).toBeGreaterThan(0);
    for (const r of data.results) {
      expectStableSymbol(r);
    }
  });

  test('explainData (function) results have all 7 stable fields', () => {
    const data = explainData('authMiddleware', dbPath);
    expect(data.results.length).toBeGreaterThan(0);
    for (const r of data.results) {
      expectStableSymbol(r);
    }
  });

  test('listFunctionsData results have all 7 stable fields', () => {
    const data = listFunctionsData(dbPath);
    expect(data.functions.length).toBeGreaterThan(0);
    for (const r of data.functions) {
      expectStableSymbol(r);
    }
  });

  test('fileHash values match expected hashes', () => {
    const data = queryNameData('authenticate', dbPath);
    const fn = data.results.find((r) => r.name === 'authenticate' && r.kind === 'function');
    expect(fn.fileHash).toBe('hash_auth_js');
  });
});

// ─── exportsData ──────────────────────────────────────────────────────

describe('exportsData', () => {
  test('returns exported symbols with consumers for auth.js', () => {
    const data = exportsData('auth.js', dbPath);
    expect(data.file).toBe('auth.js');
    expect(data.totalExported).toBeGreaterThanOrEqual(2);

    const names = data.results.map((r) => r.name);
    expect(names).toContain('authenticate');
    expect(names).toContain('validateToken');
  });

  test('consumers include cross-file callers', () => {
    const data = exportsData('auth.js', dbPath);
    const auth = data.results.find((r) => r.name === 'authenticate');
    expect(auth).toBeDefined();
    const consumerNames = auth.consumers.map((c) => c.name);
    // authMiddleware calls authenticate from middleware.js (cross-file)
    expect(consumerNames).toContain('authMiddleware');
  });

  test('noTests filters test file consumers', () => {
    const all = exportsData('auth.js', dbPath);
    const filtered = exportsData('auth.js', dbPath, { noTests: true });

    const allAuth = all.results.find((r) => r.name === 'authenticate');
    const filteredAuth = filtered.results.find((r) => r.name === 'authenticate');

    const allConsumers = allAuth.consumers.map((c) => c.name);
    const filteredConsumers = filteredAuth.consumers.map((c) => c.name);

    // testAuthenticate should be in unfiltered consumers
    expect(allConsumers).toContain('testAuthenticate');
    // testAuthenticate should be excluded with noTests
    expect(filteredConsumers).not.toContain('testAuthenticate');
  });

  test('returns empty results for unknown file', () => {
    const data = exportsData('nonexistent.js', dbPath);
    expect(data.results).toHaveLength(0);
    expect(data.totalExported).toBe(0);
    expect(data.totalInternal).toBe(0);
  });

  test('reexports field is present', () => {
    const data = exportsData('auth.js', dbPath);
    expect(data).toHaveProperty('reexports');
    expect(Array.isArray(data.reexports)).toBe(true);
  });

  test('pagination limits results', () => {
    const data = exportsData('auth.js', dbPath, { limit: 1, offset: 0 });
    expect(data.results).toHaveLength(1);
    expect(data._pagination).toBeDefined();
    expect(data._pagination.total).toBeGreaterThanOrEqual(2);
    expect(data._pagination.hasMore).toBe(true);
  });

  test('result shape has expected fields', () => {
    const data = exportsData('auth.js', dbPath);
    expect(data.results.length).toBeGreaterThan(0);
    const sym = data.results[0];
    expect(sym).toHaveProperty('name');
    expect(sym).toHaveProperty('kind');
    expect(sym).toHaveProperty('line');
    expect(sym).toHaveProperty('consumers');
    expect(sym).toHaveProperty('consumerCount');
    expect(sym).toHaveProperty('role');
    expect(sym).toHaveProperty('signature');
    expect(sym).toHaveProperty('summary');
    expect(sym).toHaveProperty('endLine');
    expect(Array.isArray(sym.consumers)).toBe(true);
    expect(typeof sym.consumerCount).toBe('number');
  });
});
