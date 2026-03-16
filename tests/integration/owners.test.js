import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { ownersData, ownersForFiles } from '../../src/features/owners.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-owners-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // ── Function nodes across directories ──
  const fnLogin = insertNode(db, 'login', 'function', 'src/auth/login.js', 5);
  const fnSession = insertNode(db, 'createSession', 'function', 'src/auth/session.js', 5);
  const fnQuery = insertNode(db, 'query', 'function', 'src/data/db.js', 5);
  const fnCache = insertNode(db, 'getCache', 'function', 'src/data/cache.js', 5);
  const fnHandler = insertNode(db, 'handleRequest', 'function', 'src/api/handler.js', 5);
  insertNode(db, 'formatOutput', 'method', 'src/utils/format.js', 10);
  insertNode(db, 'testLogin', 'function', 'tests/auth.test.js', 5);

  // ── Cross-owner call edges ──
  // auth -> data (cross-boundary)
  insertEdge(db, fnLogin, fnQuery, 'calls');
  // auth -> auth (same owner)
  insertEdge(db, fnLogin, fnSession, 'calls');
  // api -> auth (cross-boundary)
  insertEdge(db, fnHandler, fnLogin, 'calls');
  // api -> data (cross-boundary)
  insertEdge(db, fnHandler, fnCache, 'calls');

  // ── CODEOWNERS file ──
  const codeowners = `# Ownership rules
* @default-team
/src/auth/ @security-team
/src/data/ @data-team
/src/api/ @api-team
/src/utils/ @utils-team
`;
  fs.writeFileSync(path.join(tmpDir, 'CODEOWNERS'), codeowners);

  db.close();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── ownersData ────────────────────────────────────────────────────────

describe('ownersData', () => {
  test('returns correct coverage and owner counts', () => {
    const data = ownersData(dbPath);
    expect(data.codeownersFile).toBe('CODEOWNERS');
    expect(data.summary.totalFiles).toBe(7);
    expect(data.summary.ownedFiles).toBe(7); // * @default-team catches all
    expect(data.summary.coveragePercent).toBe(100);
    expect(data.summary.ownerCount).toBeGreaterThanOrEqual(5);
  });

  test('maps files to correct owners (last-match-wins)', () => {
    const data = ownersData(dbPath);
    const authFile = data.files.find((f) => f.file === 'src/auth/login.js');
    expect(authFile.owners).toEqual(['@security-team']);
    const dataFile = data.files.find((f) => f.file === 'src/data/db.js');
    expect(dataFile.owners).toEqual(['@data-team']);
    const testFile = data.files.find((f) => f.file === 'tests/auth.test.js');
    expect(testFile.owners).toEqual(['@default-team']);
  });

  test('--owner filter returns only matching files', () => {
    const data = ownersData(dbPath, { owner: '@security-team' });
    expect(data.files.every((f) => f.owners.includes('@security-team'))).toBe(true);
    expect(data.files.length).toBe(2); // login.js, session.js
  });

  test('--file filter scopes to matching paths', () => {
    const data = ownersData(dbPath, { file: 'src/data/' });
    expect(data.files.length).toBe(2);
    expect(data.files.every((f) => f.file.includes('src/data/'))).toBe(true);
  });

  test('--noTests excludes test files', () => {
    const data = ownersData(dbPath, { noTests: true });
    expect(data.files.some((f) => f.file.includes('test'))).toBe(false);
    expect(data.summary.totalFiles).toBe(6);
  });

  test('--kind filters symbols', () => {
    const data = ownersData(dbPath, { kind: 'method' });
    expect(data.symbols.every((s) => s.kind === 'method')).toBe(true);
    expect(data.symbols.length).toBe(1); // formatOutput
  });

  test('--boundary returns cross-owner edges', () => {
    const data = ownersData(dbPath, { boundary: true });
    expect(data.boundaries.length).toBeGreaterThan(0);
    // login -> query crosses auth -> data
    const authToData = data.boundaries.find(
      (b) => b.from.name === 'login' && b.to.name === 'query',
    );
    expect(authToData).toBeDefined();
    expect(authToData.from.owners).toEqual(['@security-team']);
    expect(authToData.to.owners).toEqual(['@data-team']);
  });

  test('same-owner edges are excluded from boundaries', () => {
    const data = ownersData(dbPath, { boundary: true });
    const sameOwner = data.boundaries.find(
      (b) => b.from.name === 'login' && b.to.name === 'createSession',
    );
    expect(sameOwner).toBeUndefined();
  });
});

// ─── ownersForFiles ──────────────────────────────────────────────────

describe('ownersForFiles', () => {
  test('returns correct owners map', () => {
    const result = ownersForFiles(['src/auth/login.js', 'src/data/db.js', 'README.md'], tmpDir);
    expect(result.owners.get('src/auth/login.js')).toEqual(['@security-team']);
    expect(result.owners.get('src/data/db.js')).toEqual(['@data-team']);
    expect(result.owners.get('README.md')).toEqual(['@default-team']);
  });

  test('returns affected owners and suggested reviewers', () => {
    const result = ownersForFiles(['src/auth/login.js', 'src/data/db.js'], tmpDir);
    expect(result.affectedOwners).toContain('@security-team');
    expect(result.affectedOwners).toContain('@data-team');
    expect(result.suggestedReviewers.length).toBeGreaterThan(0);
  });

  test('returns empty when no CODEOWNERS', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeowners-empty-'));
    try {
      const result = ownersForFiles(['src/app.js'], emptyDir);
      expect(result.owners.size).toBe(0);
      expect(result.affectedOwners).toEqual([]);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ─── No CODEOWNERS ───────────────────────────────────────────────────

describe('graceful degradation', () => {
  test('ownersData returns null codeownersFile when missing', () => {
    // Create a temp DB without CODEOWNERS
    const noOwnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noowners-'));
    fs.mkdirSync(path.join(noOwnerDir, '.codegraph'));
    const noOwnerDb = path.join(noOwnerDir, '.codegraph', 'graph.db');
    const db = new Database(noOwnerDb);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    insertNode(db, 'hello', 'function', 'src/main.js', 1);
    db.close();

    try {
      const data = ownersData(noOwnerDb);
      expect(data.codeownersFile).toBeNull();
      expect(data.files).toEqual([]);
      expect(data.symbols).toEqual([]);
      expect(data.boundaries).toEqual([]);
      expect(data.summary.totalFiles).toBe(0);
    } finally {
      fs.rmSync(noOwnerDir, { recursive: true, force: true });
    }
  });
});
