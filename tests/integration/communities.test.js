/**
 * Integration tests for community detection (Louvain).
 *
 * Uses a hand-crafted in-file DB with multi-directory structure:
 *
 *   src/auth/login.js  + src/auth/session.js   → tight auth cluster
 *   src/data/db.js     + src/data/cache.js      → tight data cluster
 *   src/api/handler.js → imports from both clusters (bridge)
 *   lib/format.js      → depends on data modules (drift signal)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { communitiesData, communitySummaryForStats } from '../../src/features/communities.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-communities-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // ── File nodes (multi-directory) ──
  const fAuthLogin = insertNode(db, 'src/auth/login.js', 'file', 'src/auth/login.js', 0);
  const fAuthSession = insertNode(db, 'src/auth/session.js', 'file', 'src/auth/session.js', 0);
  const fDataDb = insertNode(db, 'src/data/db.js', 'file', 'src/data/db.js', 0);
  const fDataCache = insertNode(db, 'src/data/cache.js', 'file', 'src/data/cache.js', 0);
  const fApiHandler = insertNode(db, 'src/api/handler.js', 'file', 'src/api/handler.js', 0);
  const fLibFormat = insertNode(db, 'lib/format.js', 'file', 'lib/format.js', 0);
  const fTestAuth = insertNode(db, 'tests/auth.test.js', 'file', 'tests/auth.test.js', 0);

  // ── Function nodes ──
  const fnLogin = insertNode(db, 'login', 'function', 'src/auth/login.js', 5);
  const fnCreateSession = insertNode(db, 'createSession', 'function', 'src/auth/session.js', 5);
  const fnValidateSession = insertNode(
    db,
    'validateSession',
    'function',
    'src/auth/session.js',
    20,
  );
  const fnQuery = insertNode(db, 'query', 'function', 'src/data/db.js', 5);
  const fnGetCache = insertNode(db, 'getCache', 'function', 'src/data/cache.js', 5);
  const fnSetCache = insertNode(db, 'setCache', 'function', 'src/data/cache.js', 15);
  const fnHandleRequest = insertNode(db, 'handleRequest', 'function', 'src/api/handler.js', 5);
  const fnFormatOutput = insertNode(db, 'formatOutput', 'function', 'lib/format.js', 5);
  const fnTestLogin = insertNode(db, 'testLogin', 'function', 'tests/auth.test.js', 5);

  // ── File-level import edges ──
  // Auth cluster: login <-> session
  insertEdge(db, fAuthLogin, fAuthSession, 'imports');
  insertEdge(db, fAuthSession, fAuthLogin, 'imports');

  // Data cluster: db <-> cache
  insertEdge(db, fDataDb, fDataCache, 'imports');
  insertEdge(db, fDataCache, fDataDb, 'imports');

  // Bridge: api/handler imports from both clusters
  insertEdge(db, fApiHandler, fAuthLogin, 'imports');
  insertEdge(db, fApiHandler, fDataDb, 'imports');

  // Drift signal: lib/format depends on data modules
  insertEdge(db, fLibFormat, fDataDb, 'imports');
  insertEdge(db, fLibFormat, fDataCache, 'imports');

  // Test file imports
  insertEdge(db, fTestAuth, fAuthLogin, 'imports');

  // ── Function-level call edges ──
  // Auth cluster calls
  insertEdge(db, fnLogin, fnCreateSession, 'calls');
  insertEdge(db, fnLogin, fnValidateSession, 'calls');
  insertEdge(db, fnCreateSession, fnValidateSession, 'calls');

  // Data cluster calls
  insertEdge(db, fnQuery, fnGetCache, 'calls');
  insertEdge(db, fnQuery, fnSetCache, 'calls');
  insertEdge(db, fnGetCache, fnSetCache, 'calls');

  // Bridge: handleRequest calls across clusters
  insertEdge(db, fnHandleRequest, fnLogin, 'calls');
  insertEdge(db, fnHandleRequest, fnQuery, 'calls');
  insertEdge(db, fnHandleRequest, fnFormatOutput, 'calls');

  // lib/format calls data
  insertEdge(db, fnFormatOutput, fnGetCache, 'calls');

  // Test calls
  insertEdge(db, fnTestLogin, fnLogin, 'calls');

  db.close();
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── File-Level Tests ──────────────────────────────────────────────────

describe('communitiesData (file-level)', () => {
  test('returns valid community structure', () => {
    const data = communitiesData(dbPath);
    expect(data.communities).toBeInstanceOf(Array);
    expect(data.communities.length).toBeGreaterThan(0);
    for (const c of data.communities) {
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('size');
      expect(c.size).toBeGreaterThan(0);
      expect(c).toHaveProperty('members');
      expect(c.members.length).toBe(c.size);
      expect(c).toHaveProperty('directories');
    }
  });

  test('detects 2+ communities from distinct clusters', () => {
    const data = communitiesData(dbPath);
    expect(data.summary.communityCount).toBeGreaterThanOrEqual(2);
  });

  test('modularity is between 0 and 1', () => {
    const data = communitiesData(dbPath);
    expect(data.modularity).toBeGreaterThanOrEqual(0);
    expect(data.modularity).toBeLessThanOrEqual(1);
  });

  test('drift analysis finds split candidates', () => {
    const data = communitiesData(dbPath);
    // At minimum, lib/format.js groups with data but lives in a different dir
    expect(data.drift).toHaveProperty('splitCandidates');
    expect(data.drift.splitCandidates).toBeInstanceOf(Array);
  });

  test('drift analysis finds merge candidates', () => {
    const data = communitiesData(dbPath);
    expect(data.drift).toHaveProperty('mergeCandidates');
    expect(data.drift.mergeCandidates).toBeInstanceOf(Array);
  });

  test('drift score is 0-100', () => {
    const data = communitiesData(dbPath);
    expect(data.summary.driftScore).toBeGreaterThanOrEqual(0);
    expect(data.summary.driftScore).toBeLessThanOrEqual(100);
  });

  test('noTests excludes test files', () => {
    const withTests = communitiesData(dbPath);
    const withoutTests = communitiesData(dbPath, { noTests: true });

    const allMembers = withTests.communities.flatMap((c) => c.members.map((m) => m.file));
    const filteredMembers = withoutTests.communities.flatMap((c) => c.members.map((m) => m.file));

    expect(allMembers.some((f) => f.includes('.test.'))).toBe(true);
    expect(filteredMembers.some((f) => f.includes('.test.'))).toBe(false);
  });

  test('higher resolution produces >= same number of communities', () => {
    const low = communitiesData(dbPath, { resolution: 0.5 });
    const high = communitiesData(dbPath, { resolution: 2.0 });
    expect(high.summary.communityCount).toBeGreaterThanOrEqual(low.summary.communityCount);
  });
});

// ─── Function-Level Tests ──────────────────────────────────────────────

describe('communitiesData (function-level)', () => {
  test('returns function-level results with kind field', () => {
    const data = communitiesData(dbPath, { functions: true });
    expect(data.communities.length).toBeGreaterThan(0);
    for (const c of data.communities) {
      for (const m of c.members) {
        expect(m).toHaveProperty('kind');
        expect(['function', 'method', 'class']).toContain(m.kind);
      }
    }
  });

  test('function-level detects 2+ communities', () => {
    const data = communitiesData(dbPath, { functions: true });
    expect(data.summary.communityCount).toBeGreaterThanOrEqual(2);
  });
});

// ─── Drift-Only Mode ──────────────────────────────────────────────────

describe('drift-only mode', () => {
  test('drift: true returns empty communities array', () => {
    const data = communitiesData(dbPath, { drift: true });
    expect(data.communities).toEqual([]);
    expect(data.drift.splitCandidates).toBeInstanceOf(Array);
    expect(data.drift.mergeCandidates).toBeInstanceOf(Array);
    expect(data.summary.communityCount).toBeGreaterThan(0);
  });
});

// ─── Stats Integration ────────────────────────────────────────────────

describe('communitySummaryForStats', () => {
  test('returns lightweight summary with expected fields', () => {
    const summary = communitySummaryForStats(dbPath);
    expect(summary).toHaveProperty('communityCount');
    expect(summary).toHaveProperty('modularity');
    expect(summary).toHaveProperty('driftScore');
    expect(summary).toHaveProperty('nodeCount');
    expect(typeof summary.communityCount).toBe('number');
    expect(typeof summary.modularity).toBe('number');
    expect(typeof summary.driftScore).toBe('number');
  });
});

// ─── Empty Graph ──────────────────────────────────────────────────────

describe('empty graph', () => {
  let emptyTmpDir, emptyDbPath;

  beforeAll(() => {
    emptyTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-communities-empty-'));
    fs.mkdirSync(path.join(emptyTmpDir, '.codegraph'));
    emptyDbPath = path.join(emptyTmpDir, '.codegraph', 'graph.db');

    const db = new Database(emptyDbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    db.close();
  });

  afterAll(() => {
    if (emptyTmpDir) fs.rmSync(emptyTmpDir, { recursive: true, force: true });
  });

  test('empty graph returns zero communities', () => {
    const data = communitiesData(emptyDbPath);
    expect(data.communities).toEqual([]);
    expect(data.summary.communityCount).toBe(0);
    expect(data.summary.modularity).toBe(0);
    expect(data.summary.driftScore).toBe(0);
  });
});
