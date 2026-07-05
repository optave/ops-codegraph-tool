/**
 * Integration tests for check validation predicates.
 *
 * Creates a temp DB with fixture data and tests each predicate
 * in isolation and in combination.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import {
  checkData,
  checkMaxBlastRadius,
  checkNoBoundaryViolations,
  checkNoNewCycles,
  checkNoSignatureChanges,
  parseDiffOutput,
} from '../../src/features/check.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function insertNode(db, name, kind, file, line, endLine = null, exported = 0) {
  return db
    .prepare(
      'INSERT INTO nodes (name, kind, file, line, end_line, exported) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(name, kind, file, line, endLine, exported).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence) VALUES (?, ?, ?, 1.0)',
  ).run(sourceId, targetId, kind);
}

// ─── Fixture DB ────────────────────────────────────────────────────────

let tmpDir: string, dbPath: string, db: any;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-check-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // --- Functions ---
  // src/math.js: add (line 1-5, exported), multiply (line 7-12, exported),
  // roundHalfEven (line 14-16, private — not part of the module's public API)
  const add = insertNode(db, 'add', 'function', 'src/math.js', 1, 5, 1);
  const multiply = insertNode(db, 'multiply', 'function', 'src/math.js', 7, 12, 1);
  insertNode(db, 'roundHalfEven', 'function', 'src/math.js', 14, 16, 0);

  // src/utils.js: formatResult (line 1-10), parseInput (line 12-20)
  const formatResult = insertNode(db, 'formatResult', 'function', 'src/utils.js', 1, 10);
  const parseInput = insertNode(db, 'parseInput', 'function', 'src/utils.js', 12, 20);

  // src/handler.js: handleRequest (line 1-30)
  const handleRequest = insertNode(db, 'handleRequest', 'function', 'src/handler.js', 1, 30);

  // src/processor.js: process (line 1-15)
  const processNode = insertNode(db, 'process', 'function', 'src/processor.js', 1, 15);

  // tests/math.test.js: testAdd (line 1-5)
  insertNode(db, 'testAdd', 'function', 'tests/math.test.js', 1, 5);

  // --- Call edges (for blast radius) ---
  // handleRequest -> add -> multiply (chain of 2)
  insertEdge(db, handleRequest, add, 'calls');
  insertEdge(db, add, multiply, 'calls');
  // formatResult -> add (another caller of add)
  insertEdge(db, formatResult, add, 'calls');
  // parseInput -> formatResult
  insertEdge(db, parseInput, formatResult, 'calls');
  // processNode -> handleRequest
  insertEdge(db, processNode, handleRequest, 'calls');

  // --- Import edges (for cycles) ---
  // Create a file-level cycle: math.js <-> utils.js
  const fileMath = insertNode(db, 'src/math.js', 'file', 'src/math.js', 1);
  const fileUtils = insertNode(db, 'src/utils.js', 'file', 'src/utils.js', 1);
  const fileHandler = insertNode(db, 'src/handler.js', 'file', 'src/handler.js', 1);
  insertEdge(db, fileMath, fileUtils, 'imports');
  insertEdge(db, fileUtils, fileMath, 'imports');

  // No cycle for handler.js
  insertEdge(db, fileHandler, fileMath, 'imports');
});

afterAll(() => {
  if (db) db.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── parseDiffOutput ──────────────────────────────────────────────────

describe('parseDiffOutput', () => {
  test('parses new-side and old-side ranges', () => {
    const diff = [
      '--- a/src/math.js',
      '+++ b/src/math.js',
      '@@ -1,3 +1,4 @@',
      '-old line 1',
      '-old line 2',
      '-old line 3',
      '+new line 1',
      '+new line 2',
      '+new line 3',
      '+new line 4',
    ].join('\n');

    const { changedRanges, oldRanges, newFiles } = parseDiffOutput(diff);
    expect(changedRanges.has('src/math.js')).toBe(true);
    expect(changedRanges.get('src/math.js')).toEqual([{ start: 1, end: 4 }]);
    expect(oldRanges.get('src/math.js')).toEqual([{ start: 1, end: 3 }]);
    expect(newFiles.size).toBe(0);
  });

  test('old-side ranges exclude unchanged context lines around a removal', () => {
    // Simulates deleting a block that sits between two untouched declarations —
    // the hunk header span (2..9) must not swallow the untouched line 9.
    const diff = [
      '--- a/src/math.js',
      '+++ b/src/math.js',
      '@@ -2,8 +2,2 @@',
      ' function add() {}', // context, old line 2 — untouched
      '-function removedHelper() {',
      '-  return 1;',
      '-}',
      '-function alsoRemoved() {',
      '-  return 2;',
      '-}',
      ' function multiply() {}', // context, old line 9 — untouched
    ].join('\n');

    const { oldRanges } = parseDiffOutput(diff);
    // Only the 6 actually-removed lines (3-8) should appear, not the
    // untouched context lines immediately before (2) and after (9).
    expect(oldRanges.get('src/math.js')).toEqual([{ start: 3, end: 8 }]);
  });

  test('new-side ranges exclude unchanged context lines around an addition', () => {
    // Symmetric counterpart of the old-side test above: `getGitDiff` always
    // uses `--unified=0` so this never happens in practice, but
    // `parseDiffOutput` is a public export and must stay correct for any
    // unified diff, including ones with non-zero context.
    const diff = [
      '--- a/src/math.js',
      '+++ b/src/math.js',
      '@@ -2,2 +2,8 @@',
      ' function add() {}', // context, line 2 — untouched
      '+function addedHelper() {',
      '+  return 1;',
      '+}',
      '+function alsoAdded() {',
      '+  return 2;',
      '+}',
      ' function multiply() {}', // context, line 9 — untouched
    ].join('\n');

    const { changedRanges } = parseDiffOutput(diff);
    // Only the 6 actually-added lines (3-8) should appear, not the untouched
    // context lines immediately before (2) and after (9) — even though the
    // raw hunk header span for the new side is 2..9.
    expect(changedRanges.get('src/math.js')).toEqual([{ start: 3, end: 8 }]);
  });

  test('detects new files', () => {
    const diff = ['--- /dev/null', '+++ b/src/new-file.js', '@@ -0,0 +1,5 @@', '+line1'].join('\n');

    const { newFiles, oldRanges } = parseDiffOutput(diff);
    expect(newFiles.has('src/new-file.js')).toBe(true);
    // Old range count=0, so no entry
    expect(oldRanges.get('src/new-file.js')).toEqual([]);
  });

  test('a deleted file does not corrupt the ranges of the preceding file', () => {
    // Regression test: `+++ /dev/null` (file deletion) is not `b/`-prefixed,
    // so it was previously missed by every guard and fell through to
    // tracker.consume, which recorded it as an added line under whichever
    // file preceded it in the diff — corrupting that file's changedRanges
    // and then misattributing the deleted file's removed lines to it too.
    const diff = [
      '--- a/src/kept.js',
      '+++ b/src/kept.js',
      '@@ -1,1 +1,1 @@',
      '-old kept line',
      '+new kept line',
      '--- a/src/removed.js',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-deleted line 1',
      '-deleted line 2',
    ].join('\n');

    const { changedRanges, oldRanges } = parseDiffOutput(diff);
    // kept.js's ranges must reflect only its own hunk, not the deleted
    // file's `+++ /dev/null` header or removed body lines.
    expect(changedRanges.get('src/kept.js')).toEqual([{ start: 1, end: 1 }]);
    expect(oldRanges.get('src/kept.js')).toEqual([{ start: 1, end: 1 }]);
    // The deleted file itself is not tracked — its nodes are purged from the
    // DB during the rebuild, so there is nothing for the check predicates to
    // match against.
    expect(changedRanges.has('src/removed.js')).toBe(false);
    expect(oldRanges.has('src/removed.js')).toBe(false);
  });

  test('handles multiple files', () => {
    const diff = [
      '--- a/src/a.js',
      '+++ b/src/a.js',
      '@@ -5,2 +5,3 @@',
      '--- a/src/b.js',
      '+++ b/src/b.js',
      '@@ -10,1 +10,2 @@',
    ].join('\n');

    const { changedRanges } = parseDiffOutput(diff);
    expect(changedRanges.size).toBe(2);
    expect(changedRanges.has('src/a.js')).toBe(true);
    expect(changedRanges.has('src/b.js')).toBe(true);
  });
});

// ─── checkNoNewCycles ─────────────────────────────────────────────────

describe('checkNoNewCycles', () => {
  test('passes when changed file is NOT in a cycle', () => {
    const result = checkNoNewCycles(db, new Set(['src/handler.js']), false);
    expect(result.passed).toBe(true);
    expect(result.cycles).toEqual([]);
  });

  test('fails when changed file participates in a cycle', () => {
    const result = checkNoNewCycles(db, new Set(['src/math.js']), false);
    expect(result.passed).toBe(false);
    expect(result.cycles.length).toBeGreaterThan(0);
    // The cycle should involve math.js
    const flat = result.cycles.flat();
    expect(flat).toContain('src/math.js');
  });
});

// ─── checkMaxBlastRadius ──────────────────────────────────────────────

describe('checkMaxBlastRadius', () => {
  test('passes when max callers is below threshold', () => {
    // multiply has callers: add(d1), handleRequest+formatResult(d2), processNode+parseInput(d3) = 5
    // With depth 1 only, multiply has 1 caller (add), so threshold 3 passes
    const ranges = new Map([['src/math.js', [{ start: 7, end: 12 }]]]);
    const result = checkMaxBlastRadius(db, ranges, 3, false, 1);
    expect(result.passed).toBe(true);
  });

  test('fails when max callers exceeds threshold', () => {
    // add has callers: handleRequest, formatResult at depth 1; parseInput, processNode at depth 2
    const ranges = new Map([['src/math.js', [{ start: 1, end: 5 }]]]);
    const result = checkMaxBlastRadius(db, ranges, 1, false, 3);
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].name).toBe('add');
    expect(result.violations[0].transitiveCallers).toBeGreaterThan(1);
  });

  test('respects maxDepth', () => {
    // With depth 1, add has 2 direct callers (handleRequest, formatResult)
    const ranges = new Map([['src/math.js', [{ start: 1, end: 5 }]]]);
    const result = checkMaxBlastRadius(db, ranges, 10, false, 1);
    expect(result.passed).toBe(true);
    expect(result.maxFound).toBeLessThanOrEqual(10);
  });
});

// ─── checkNoSignatureChanges ──────────────────────────────────────────

describe('checkNoSignatureChanges', () => {
  test('passes for body-only changes', () => {
    // add is at line 1. Changing lines 3-5 (body only) should pass
    const oldRanges = new Map([['src/math.js', [{ start: 3, end: 5 }]]]);
    const result = checkNoSignatureChanges(db, oldRanges, false);
    expect(result.passed).toBe(true);
  });

  test('fails when declaration line is in a changed hunk', () => {
    // add is at line 1. Changing lines 1-2 (includes declaration) should fail
    const oldRanges = new Map([['src/math.js', [{ start: 1, end: 2 }]]]);
    const result = checkNoSignatureChanges(db, oldRanges, false);
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.violations[0].name).toBe('add');
  });

  test('skips test files when noTests is true', () => {
    const oldRanges = new Map([['tests/math.test.js', [{ start: 1, end: 5 }]]]);
    const result = checkNoSignatureChanges(db, oldRanges, true);
    expect(result.passed).toBe(true);
  });

  test('does not flag a private (non-exported) symbol whose declaration was removed', () => {
    // roundHalfEven is at line 14, exported=0. Deleting it entirely — the
    // exact "adopt shared helper, drop the file-local duplicate" pattern
    // grind performs — must not trip this check: every caller of a
    // private helper lives in the same file and is already part of the diff.
    const oldRanges = new Map([['src/math.js', [{ start: 14, end: 16 }]]]);
    const result = checkNoSignatureChanges(db, oldRanges, false);
    expect(result.passed).toBe(true);
  });

  test('still flags an exported symbol even when a private symbol shares the file', () => {
    // Sanity check that the exported-only filter doesn't accidentally
    // suppress real violations on exported declarations in the same file.
    const oldRanges = new Map([
      [
        'src/math.js',
        [
          { start: 1, end: 2 }, // add's declaration (exported)
          { start: 14, end: 16 }, // roundHalfEven's declaration (private)
        ],
      ],
    ]);
    const result = checkNoSignatureChanges(db, oldRanges, false);
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.name)).toEqual(['add']);
  });

  test('regression: deleting a line near a declaration does not flag it (issue #1760)', () => {
    // Fixture DB: `add` spans lines 1-5, `multiply`'s declaration is at
    // line 7. A real `git diff` carries 3 lines of context around a
    // change, so deleting the single stale line 6 produces a hunk whose
    // *header span* (3..9) includes multiply's declaration line (7) even
    // though multiply's own text is untouched. parseDiffOutput must only
    // record line 6 as removed, not the surrounding context.
    const diff = [
      '--- a/src/math.js',
      '+++ b/src/math.js',
      '@@ -3,7 +3,6 @@',
      '   return 1;', // context, old line 3 (inside add)
      ' }', // context, old line 4
      ' ', // context, old line 5
      '-// stale comment', // removed, old line 6
      ' function multiply() {', // context, old line 7 — multiply's declaration
      '   return 2;', // context, old line 8
      ' }', // context, old line 9
    ].join('\n');

    const { oldRanges } = parseDiffOutput(diff);
    expect(oldRanges.get('src/math.js')).toEqual([{ start: 6, end: 6 }]);

    const result = checkNoSignatureChanges(db, oldRanges, false);
    expect(result.passed).toBe(true);
  });
});

// ─── checkNoBoundaryViolations ────────────────────────────────────────

describe('checkNoBoundaryViolations', () => {
  test('passes (with note) when no CODEOWNERS exists', () => {
    const result = checkNoBoundaryViolations(db, new Set(['src/math.js']), tmpDir, false);
    expect(result.passed).toBe(true);
    expect(result.note).toMatch(/CODEOWNERS/);
  });

  test('passes with same-owner edges', () => {
    // Create CODEOWNERS where all src files have same owner
    const codeownersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-check-owners-'));
    fs.writeFileSync(path.join(codeownersDir, 'CODEOWNERS'), 'src/ @team-a\n');

    const result = checkNoBoundaryViolations(db, new Set(['src/math.js']), codeownersDir, false);
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);

    fs.rmSync(codeownersDir, { recursive: true, force: true });
  });

  test('fails with cross-owner edges', () => {
    // Create CODEOWNERS where math.js and handler.js have different owners
    const codeownersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-check-owners2-'));
    fs.writeFileSync(
      path.join(codeownersDir, 'CODEOWNERS'),
      'src/math.js @team-a\nsrc/handler.js @team-b\nsrc/utils.js @team-a\n',
    );

    // handler.js calls add in math.js — cross-owner edge
    const result = checkNoBoundaryViolations(db, new Set(['src/handler.js']), codeownersDir, false);
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);

    fs.rmSync(codeownersDir, { recursive: true, force: true });
  });
});

// ─── checkData (integration) ──────────────────────────────────────────

describe('checkData', () => {
  test('predicate selection: only specified predicates appear in results', () => {
    // Create a git repo with staged changes to test checkData end-to-end
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-check-int-'));
    fs.mkdirSync(path.join(projectDir, '.codegraph'));
    const projectDbPath = path.join(projectDir, '.codegraph', 'graph.db');

    // Create a fresh DB
    const projectDb = new Database(projectDbPath);
    projectDb.pragma('journal_mode = WAL');
    initSchema(projectDb);
    insertNode(projectDb, 'foo', 'function', 'src/foo.js', 1, 10);
    projectDb.close();

    // Init git repo with a file and staged change
    const { execFileSync } = require('node:child_process');
    try {
      execFileSync('git', ['init'], { cwd: projectDir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], {
        cwd: projectDir,
        stdio: 'pipe',
      });
      execFileSync('git', ['config', 'user.name', 'Test'], {
        cwd: projectDir,
        stdio: 'pipe',
      });
      fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'src', 'foo.js'), 'function foo() {}');
      fs.writeFileSync(path.join(projectDir, 'src', 'foo.js'), 'function foo() {}\n');
      execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'pipe' });

      // Make a change and stage it
      fs.writeFileSync(
        path.join(projectDir, 'src', 'foo.js'),
        'function foo() {\n  return 42;\n}\n',
      );
      execFileSync('git', ['add', 'src/foo.js'], { cwd: projectDir, stdio: 'pipe' });

      // Run with only --cycles enabled
      const data = checkData(projectDbPath, {
        staged: true,
        cycles: true,
        signatures: false,
        boundaries: false,
      });

      expect(data.predicates).toBeDefined();
      const names = data.predicates.map((p) => p.name);
      expect(names).toContain('cycles');
      expect(names).not.toContain('signatures');
      expect(names).not.toContain('boundaries');
      expect(names).not.toContain('blast-radius');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('no changes returns passed=true with empty predicates', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-check-empty-'));
    fs.mkdirSync(path.join(projectDir, '.codegraph'));
    const projectDbPath = path.join(projectDir, '.codegraph', 'graph.db');

    const projectDb = new Database(projectDbPath);
    projectDb.pragma('journal_mode = WAL');
    initSchema(projectDb);
    projectDb.close();

    const { execFileSync } = require('node:child_process');
    try {
      execFileSync('git', ['init'], { cwd: projectDir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], {
        cwd: projectDir,
        stdio: 'pipe',
      });
      execFileSync('git', ['config', 'user.name', 'Test'], {
        cwd: projectDir,
        stdio: 'pipe',
      });
      fs.writeFileSync(path.join(projectDir, 'placeholder.txt'), 'hello');
      execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'pipe' });

      // No staged changes
      const data = checkData(projectDbPath, { staged: true });
      expect(data.passed).toBe(true);
      expect(data.predicates).toEqual([]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('JSON output structure matches schema', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-check-json-'));
    fs.mkdirSync(path.join(projectDir, '.codegraph'));
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    const projectDbPath = path.join(projectDir, '.codegraph', 'graph.db');

    const projectDb = new Database(projectDbPath);
    projectDb.pragma('journal_mode = WAL');
    initSchema(projectDb);
    insertNode(projectDb, 'bar', 'function', 'src/bar.js', 1, 10);
    projectDb.close();

    const { execFileSync } = require('node:child_process');
    try {
      execFileSync('git', ['init'], { cwd: projectDir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], {
        cwd: projectDir,
        stdio: 'pipe',
      });
      execFileSync('git', ['config', 'user.name', 'Test'], {
        cwd: projectDir,
        stdio: 'pipe',
      });
      fs.writeFileSync(path.join(projectDir, 'src', 'bar.js'), 'function bar() {}\n');
      execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'pipe' });

      fs.writeFileSync(path.join(projectDir, 'src', 'bar.js'), 'function bar() { return 1; }\n');
      execFileSync('git', ['add', 'src/bar.js'], { cwd: projectDir, stdio: 'pipe' });

      const data = checkData(projectDbPath, { staged: true });

      // Verify schema
      expect(data).toHaveProperty('predicates');
      expect(data).toHaveProperty('summary');
      expect(data).toHaveProperty('passed');
      expect(Array.isArray(data.predicates)).toBe(true);
      expect(typeof data.summary.total).toBe('number');
      expect(typeof data.summary.passed).toBe('number');
      expect(typeof data.summary.failed).toBe('number');
      expect(typeof data.summary.changedFiles).toBe('number');
      expect(typeof data.summary.newFiles).toBe('number');
      expect(typeof data.passed).toBe('boolean');

      for (const p of data.predicates) {
        expect(p).toHaveProperty('name');
        expect(p).toHaveProperty('passed');
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('default activation: all boolean predicates run when no flags given', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-check-defaults-'));
    fs.mkdirSync(path.join(projectDir, '.codegraph'));
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    const projectDbPath = path.join(projectDir, '.codegraph', 'graph.db');

    const projectDb = new Database(projectDbPath);
    projectDb.pragma('journal_mode = WAL');
    initSchema(projectDb);
    insertNode(projectDb, 'baz', 'function', 'src/baz.js', 1, 5);
    projectDb.close();

    const { execFileSync } = require('node:child_process');
    try {
      execFileSync('git', ['init'], { cwd: projectDir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], {
        cwd: projectDir,
        stdio: 'pipe',
      });
      execFileSync('git', ['config', 'user.name', 'Test'], {
        cwd: projectDir,
        stdio: 'pipe',
      });
      fs.writeFileSync(path.join(projectDir, 'src', 'baz.js'), 'function baz() {}\n');
      execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'pipe' });

      fs.writeFileSync(path.join(projectDir, 'src', 'baz.js'), 'function baz() { return 1; }\n');
      execFileSync('git', ['add', 'src/baz.js'], { cwd: projectDir, stdio: 'pipe' });

      // No predicate flags → all boolean predicates should run
      const data = checkData(projectDbPath, { staged: true });
      const names = data.predicates.map((p) => p.name);
      expect(names).toContain('cycles');
      expect(names).toContain('signatures');
      expect(names).toContain('boundaries');
      // blast-radius should NOT appear (no default threshold)
      expect(names).not.toContain('blast-radius');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
