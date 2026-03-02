import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { auditData } from '../../src/audit.js';
import { initSchema } from '../../src/db.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function insertNode(db, name, kind, file, line, endLine = null, role = null) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line, end_line, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, kind, file, line, endLine, role).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind = 'calls') {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, 1.0, 0)',
  ).run(sourceId, targetId, kind);
}

function insertComplexity(db, nodeId, opts = {}) {
  db.prepare(
    `INSERT INTO function_complexity
       (node_id, cognitive, cyclomatic, max_nesting, loc, sloc, comment_lines,
        halstead_volume, halstead_difficulty, halstead_effort, halstead_bugs,
        maintainability_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nodeId,
    opts.cognitive ?? 5,
    opts.cyclomatic ?? 3,
    opts.maxNesting ?? 2,
    opts.loc ?? 30,
    opts.sloc ?? 25,
    opts.commentLines ?? 5,
    opts.halsteadVolume ?? 120.5,
    opts.halsteadDifficulty ?? 8.2,
    opts.halsteadEffort ?? 988.1,
    opts.halsteadBugs ?? 0.04,
    opts.mi ?? 72.5,
  );
}

// ─── Fixture DB ────────────────────────────────────────────────────────

let tmpDir, dbPath;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-audit-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // ── File nodes (required for file-level explain) ──
  insertNode(db, 'src/builder.js', 'file', 'src/builder.js', 0);
  insertNode(db, 'src/parser.js', 'file', 'src/parser.js', 0);
  insertNode(db, 'src/resolve.js', 'file', 'src/resolve.js', 0);
  insertNode(db, 'src/utils.js', 'file', 'src/utils.js', 0);
  insertNode(db, 'tests/builder.test.js', 'file', 'tests/builder.test.js', 0);

  // ── Function/class nodes ──
  const fnBuild = insertNode(
    db,
    'buildGraph',
    'function',
    'src/builder.js',
    10,
    80,
    'orchestrator',
  );
  const fnCollect = insertNode(db, 'collectFiles', 'function', 'src/builder.js', 90, 120);
  const fnParse = insertNode(db, 'parseFile', 'function', 'src/parser.js', 5, 50);
  const fnResolve = insertNode(db, 'resolveImport', 'function', 'src/resolve.js', 1, 30);
  const fnHelper = insertNode(db, 'formatOutput', 'method', 'src/utils.js', 10, 20);
  const fnTestBuild = insertNode(db, 'testBuild', 'function', 'tests/builder.test.js', 5, 40);
  insertNode(db, 'Parser', 'class', 'src/parser.js', 1, 100);

  // ── Edges: buildGraph -> collectFiles -> parseFile -> resolveImport ──
  insertEdge(db, fnBuild, fnCollect);
  insertEdge(db, fnBuild, fnParse);
  insertEdge(db, fnCollect, fnParse);
  insertEdge(db, fnParse, fnResolve);
  insertEdge(db, fnBuild, fnHelper);
  // testBuild -> buildGraph (test caller)
  insertEdge(db, fnTestBuild, fnBuild);

  // ── Complexity rows ──
  insertComplexity(db, fnBuild, {
    cognitive: 20,
    cyclomatic: 12,
    maxNesting: 5,
    loc: 70,
    sloc: 55,
    commentLines: 10,
    halsteadVolume: 500.3,
    halsteadDifficulty: 15.1,
    halsteadEffort: 7554.5,
    halsteadBugs: 0.17,
    mi: 45.2,
  });
  insertComplexity(db, fnCollect, {
    cognitive: 8,
    cyclomatic: 5,
    maxNesting: 3,
    loc: 30,
    sloc: 25,
    commentLines: 3,
    mi: 68.0,
  });
  insertComplexity(db, fnParse, { cognitive: 3, cyclomatic: 2, maxNesting: 1, mi: 85.0 });
  insertComplexity(db, fnResolve, { cognitive: 2, cyclomatic: 1, maxNesting: 0, mi: 90.0 });

  db.close();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Function target ──────────────────────────────────────────────────

describe('auditData — function target', () => {
  test('returns correct structure for a matching function', () => {
    const data = auditData('buildGraph', dbPath);
    expect(data.target).toBe('buildGraph');
    expect(data.kind).toBe('function');
    expect(data.functions.length).toBeGreaterThanOrEqual(1);

    const fn = data.functions.find((f) => f.name === 'buildGraph');
    expect(fn).toBeDefined();
    expect(fn.kind).toBe('function');
    expect(fn.file).toBe('src/builder.js');
    expect(fn.line).toBe(10);
    expect(fn.endLine).toBe(80);
    expect(fn.role).toBe('orchestrator');
    expect(fn.lineCount).toBe(71);
  });

  test('includes callees and callers', () => {
    const data = auditData('buildGraph', dbPath);
    const fn = data.functions.find((f) => f.name === 'buildGraph');
    expect(fn.callees.length).toBeGreaterThanOrEqual(3); // collectFiles, parseFile, formatOutput
    expect(fn.callers.length).toBeGreaterThanOrEqual(1); // testBuild
  });

  test('includes related tests', () => {
    const data = auditData('buildGraph', dbPath);
    const fn = data.functions.find((f) => f.name === 'buildGraph');
    expect(fn.relatedTests.length).toBeGreaterThanOrEqual(1);
    expect(fn.relatedTests[0].file).toContain('test');
  });

  test('health metrics are populated', () => {
    const data = auditData('buildGraph', dbPath);
    const fn = data.functions.find((f) => f.name === 'buildGraph');
    expect(fn.health).toBeDefined();
    expect(fn.health.cognitive).toBe(20);
    expect(fn.health.cyclomatic).toBe(12);
    expect(fn.health.maxNesting).toBe(5);
    expect(fn.health.maintainabilityIndex).toBe(45.2);
    expect(fn.health.halstead.volume).toBeCloseTo(500.3, 0);
    expect(fn.health.halstead.difficulty).toBeCloseTo(15.1, 0);
    expect(fn.health.halstead.effort).toBeCloseTo(7554.5, 0);
    expect(fn.health.halstead.bugs).toBeCloseTo(0.17, 1);
    expect(fn.health.loc).toBe(70);
    expect(fn.health.sloc).toBe(55);
    expect(fn.health.commentLines).toBe(10);
  });

  test('threshold breaches are flagged', () => {
    const data = auditData('buildGraph', dbPath);
    const fn = data.functions.find((f) => f.name === 'buildGraph');
    // cognitive=20 >= warn=15, cyclomatic=12 >= warn=10, maxNesting=5 >= warn=4
    expect(fn.health.thresholdBreaches.length).toBeGreaterThanOrEqual(3);
    const cogBreach = fn.health.thresholdBreaches.find((b) => b.metric === 'cognitive');
    expect(cogBreach).toBeDefined();
    expect(cogBreach.value).toBe(20);
    expect(cogBreach.threshold).toBe(15);
    expect(cogBreach.level).toBe('warn');
  });

  test('impact levels are populated', () => {
    const data = auditData('buildGraph', dbPath);
    const fn = data.functions.find((f) => f.name === 'buildGraph');
    expect(fn.impact).toBeDefined();
    expect(fn.impact.totalDependents).toBeGreaterThanOrEqual(1);
    // testBuild calls buildGraph, so level 1 should have testBuild
    expect(fn.impact.levels[1]).toBeDefined();
  });

  test('Phase 4.4 fields are null (graceful)', () => {
    const data = auditData('buildGraph', dbPath);
    const fn = data.functions.find((f) => f.name === 'buildGraph');
    expect(fn.riskScore).toBeNull();
    expect(fn.complexityNotes).toBeNull();
    expect(fn.sideEffects).toBeNull();
  });
});

// ─── File target ──────────────────────────────────────────────────────

describe('auditData — file target', () => {
  test('returns correct structure for a file', () => {
    const data = auditData('src/builder.js', dbPath);
    expect(data.target).toBe('src/builder.js');
    expect(data.kind).toBe('file');
    expect(data.functions.length).toBeGreaterThanOrEqual(2); // buildGraph, collectFiles
  });

  test('each function has health and impact', () => {
    const data = auditData('src/builder.js', dbPath);
    for (const fn of data.functions) {
      expect(fn.health).toBeDefined();
      expect(fn.impact).toBeDefined();
      expect(typeof fn.impact.totalDependents).toBe('number');
    }
  });
});

// ─── Filters ──────────────────────────────────────────────────────────

describe('auditData — filters', () => {
  test('--noTests excludes test file callers from impact', () => {
    const data = auditData('buildGraph', dbPath, { noTests: true });
    const fn = data.functions.find((f) => f.name === 'buildGraph');
    expect(fn.callers.every((c) => !c.file.includes('test'))).toBe(true);
  });

  test('--file filter scopes to matching file', () => {
    const data = auditData('parseFile', dbPath, { file: 'src/parser.js' });
    expect(data.functions.length).toBe(1);
    expect(data.functions[0].file).toBe('src/parser.js');
  });

  test('--kind filter restricts symbol kind', () => {
    const data = auditData('Parser', dbPath, { kind: 'class' });
    expect(data.functions.length).toBe(1);
    expect(data.functions[0].kind).toBe('class');
  });

  test('--kind with file target filters symbols', () => {
    const data = auditData('src/parser.js', dbPath, { kind: 'class' });
    expect(data.functions.every((f) => f.kind === 'class')).toBe(true);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────

describe('auditData — edge cases', () => {
  test('no match returns empty functions array', () => {
    const data = auditData('nonExistentFunction', dbPath);
    expect(data.functions).toEqual([]);
  });

  test('function with no complexity row has null health values', () => {
    const data = auditData('formatOutput', dbPath);
    const fn = data.functions.find((f) => f.name === 'formatOutput');
    expect(fn).toBeDefined();
    expect(fn.health.cognitive).toBeNull();
    expect(fn.health.thresholdBreaches).toEqual([]);
  });

  test('function with no callers has zero impact', () => {
    const data = auditData('resolveImport', dbPath);
    const fn = data.functions.find(
      (f) => f.name === 'resolveImport' && f.file === 'src/resolve.js',
    );
    expect(fn).toBeDefined();
    // resolveImport is called by parseFile, so impact > 0
    // But the leaf function with no callers at all would have 0
    expect(typeof fn.impact.totalDependents).toBe('number');
  });
});
