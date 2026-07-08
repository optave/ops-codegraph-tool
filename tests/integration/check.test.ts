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
  checkNoDeletedExportsInUse,
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

  // src/multiline.js: multiLineSig (line 20-24) — declaration spans lines
  // 20-22 (opening line + two parameters, one per line), body on 23-24.
  // Exercises the multi-line-signature guard (issue #1740 follow-up).
  const multiLineSig = insertNode(db, 'multiLineSig', 'function', 'src/multiline.js', 20, 24);
  const paramA = insertNode(db, 'a', 'parameter', 'src/multiline.js', 21);
  const paramB = insertNode(db, 'b', 'parameter', 'src/multiline.js', 22);
  insertEdge(db, paramA, multiLineSig, 'parameter_of');
  insertEdge(db, paramB, multiLineSig, 'parameter_of');

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
  // handleRequest -> multiLineSig (direct); processNode -> handleRequest
  // (above) gives multiLineSig a transitive caller too.
  insertEdge(db, handleRequest, multiLineSig, 'calls');

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

    const { changedRanges, oldRanges, deletedFiles } = parseDiffOutput(diff);
    // kept.js's ranges must reflect only its own hunk, not the deleted
    // file's `+++ /dev/null` header or removed body lines.
    expect(changedRanges.get('src/kept.js')).toEqual([{ start: 1, end: 1 }]);
    expect(oldRanges.get('src/kept.js')).toEqual([{ start: 1, end: 1 }]);
    // The deleted file never gets a changedRanges/oldRanges entry — there is
    // no new-side content to compare post-purge line numbers against — but
    // it IS recorded in `deletedFiles` so checkNoDeletedExportsInUse can
    // still check its pre-purge exports for lingering external callers
    // (#1806).
    expect(changedRanges.has('src/removed.js')).toBe(false);
    expect(oldRanges.has('src/removed.js')).toBe(false);
    expect(deletedFiles.has('src/removed.js')).toBe(true);
  });

  // ─── deletedFiles (issue #1806) ─────────────────────────────────────

  test('detects a fully deleted file via the /dev/null target marker', () => {
    const diff = [
      '--- a/src/old-file.js',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-export function foo() {}',
      '-export function bar() {}',
    ].join('\n');

    const { deletedFiles } = parseDiffOutput(diff);
    expect(deletedFiles.has('src/old-file.js')).toBe(true);
    expect(deletedFiles.size).toBe(1);
  });

  test('does not mark a modified file as deleted', () => {
    const diff = ['--- a/src/kept.js', '+++ b/src/kept.js', '@@ -1,1 +1,1 @@', '-old', '+new'].join(
      '\n',
    );

    const { deletedFiles } = parseDiffOutput(diff);
    expect(deletedFiles.size).toBe(0);
  });

  test('a new file is not also recorded as deleted (/dev/null on the source side)', () => {
    // `--- /dev/null` (new-file creation) must not be confused with
    // `+++ /dev/null` (deletion) — isDevNullSourceLine clears pendingOldFile
    // so a subsequent unrelated `+++ /dev/null` elsewhere can't attribute a
    // deletion to this file.
    const diff = ['--- /dev/null', '+++ b/src/new-file.js', '@@ -0,0 +1,1 @@', '+line1'].join('\n');

    const { deletedFiles, newFiles } = parseDiffOutput(diff);
    expect(newFiles.has('src/new-file.js')).toBe(true);
    expect(deletedFiles.size).toBe(0);
  });

  test('tracks multiple deleted files in the same diff', () => {
    const diff = [
      '--- a/src/first.js',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-export function first() {}',
      '--- a/src/second.js',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-export function second() {}',
    ].join('\n');

    const { deletedFiles } = parseDiffOutput(diff);
    expect(deletedFiles.has('src/first.js')).toBe(true);
    expect(deletedFiles.has('src/second.js')).toBe(true);
    expect(deletedFiles.size).toBe(2);
  });

  test('handles multiple files', () => {
    // Each hunk header's declared old/new line counts must be backed by a
    // matching number of actual body lines — parseDiffOutput is
    // position-aware (issue #1761) and treats a hunk as still "open" until
    // its declared counts are consumed, so a header with no body would
    // swallow the next file's `--- `/`+++ ` lines as hunk content instead of
    // recognizing them.
    const diff = [
      '--- a/src/a.js',
      '+++ b/src/a.js',
      '@@ -5,2 +5,3 @@',
      ' context a',
      '-old a',
      '+new a',
      '+extra a',
      '--- a/src/b.js',
      '+++ b/src/b.js',
      '@@ -10,1 +10,2 @@',
      '-old b',
      '+new b',
      '+extra b',
    ].join('\n');

    const { changedRanges } = parseDiffOutput(diff);
    expect(changedRanges.size).toBe(2);
    expect(changedRanges.has('src/a.js')).toBe(true);
    expect(changedRanges.has('src/b.js')).toBe(true);
  });

  // ─── changedEdits (issue #1740) ───────────────────────────────────────

  test('changedEdits pairs a replacement run with its added/removed text', () => {
    const diff = [
      '--- a/src/math.js',
      '+++ b/src/math.js',
      '@@ -3,1 +3,1 @@',
      '-  return a + b + 0;',
      '+  return a + b + ZERO_OFFSET;',
    ].join('\n');

    const { changedRanges, changedEdits } = parseDiffOutput(diff);
    expect(changedRanges.get('src/math.js')).toEqual([{ start: 3, end: 3 }]);
    expect(changedEdits.get('src/math.js')).toEqual([
      {
        start: 3,
        end: 3,
        addedText: ['  return a + b + ZERO_OFFSET;'],
        removedText: ['  return a + b + 0;'],
      },
    ]);
  });

  test('changedEdits records empty removedText for a pure insertion', () => {
    const diff = ['--- a/src/math.js', '+++ b/src/math.js', '@@ -3,0 +4,1 @@', '+  // note'].join(
      '\n',
    );

    const { changedEdits } = parseDiffOutput(diff);
    expect(changedEdits.get('src/math.js')).toEqual([
      { start: 4, end: 4, addedText: ['  // note'], removedText: [] },
    ]);
  });

  test('changedEdits does not pair a pure deletion with an unrelated later hunk', () => {
    // First hunk is a pure deletion (no added lines) so it never becomes a
    // changedEdits entry; the second hunk's pure insertion must NOT be
    // paired with the first hunk's removed text (they are unrelated edits).
    const diff = [
      '--- a/src/math.js',
      '+++ b/src/math.js',
      '@@ -3,1 +3,0 @@',
      '-  // stale comment',
      '@@ -10,0 +9,1 @@',
      '+  // fresh comment',
    ].join('\n');

    const { changedEdits } = parseDiffOutput(diff);
    expect(changedEdits.get('src/math.js')).toEqual([
      { start: 9, end: 9, addedText: ['  // fresh comment'], removedText: [] },
    ]);
  });

  test('changedEdits pairs multi-line replacement blocks as a single edit', () => {
    const diff = [
      '--- a/src/math.js',
      '+++ b/src/math.js',
      '@@ -1,2 +1,2 @@',
      '-line A',
      '-line A2',
      '+line B',
      '+line B2',
    ].join('\n');

    const { changedEdits } = parseDiffOutput(diff);
    expect(changedEdits.get('src/math.js')).toEqual([
      { start: 1, end: 2, addedText: ['line B', 'line B2'], removedText: ['line A', 'line A2'] },
    ]);
  });

  test('changedEdits does not pair a removal with an unrelated addition separated by a context line', () => {
    // Within a single hunk (non-zero context, e.g. a plain `git diff`
    // without `--unified=0`), a context line between a removal and a later,
    // unrelated addition must break the pairing — otherwise the removal's
    // text gets wrongly attributed as "replaced by" the addition purely
    // because it was the most recently closed removed run. `getGitDiff`
    // always uses `--unified=0` so this never happens in production, but
    // `parseDiffOutput` is a public export and must stay correct for any
    // unified diff.
    const diff = [
      '--- a/src/math.js',
      '+++ b/src/math.js',
      '@@ -1,2 +1,2 @@',
      '-old line 1',
      ' unchanged context',
      '+new line 3',
    ].join('\n');

    const { changedEdits } = parseDiffOutput(diff);
    expect(changedEdits.get('src/math.js')).toEqual([
      { start: 2, end: 2, addedText: ['new line 3'], removedText: [] },
    ]);
  });

  // ─── hunk-scoped file-header detection (issue #1761) ───────────────────

  test('a removed line whose content starts with "-- " is treated as hunk content, not a file header', () => {
    // A removed line whose original text is `-- horizontal rule` becomes the
    // diff line `--- horizontal rule` once prefixed with the single-`-`
    // removal marker — three dashes plus a space, indistinguishable from a
    // `--- a/file` source header by content alone (confirmed against real
    // `git diff` output on a fixture with this exact content). Without
    // position-aware parsing this line is misdetected as a file header and
    // silently dropped, desyncing the old-line cursor for the rest of the
    // hunk.
    const diff = [
      '--- a/src/oldfile.md',
      '+++ b/src/oldfile.md',
      '@@ -10,4 +10,2 @@',
      '-line A',
      '--- horizontal rule',
      ' context unchanged',
      '-line D',
      '+replacement',
    ].join('\n');

    const { oldRanges, changedRanges } = parseDiffOutput(diff);
    // Both removed lines (old lines 10-11) form one contiguous run, and the
    // trailing removed line correctly lands at old line 13 — after the
    // untouched context line at 12 — rather than shifted down by one.
    expect(oldRanges.get('src/oldfile.md')).toEqual([
      { start: 10, end: 11 },
      { start: 13, end: 13 },
    ]);
    expect(changedRanges.get('src/oldfile.md')).toEqual([{ start: 11, end: 11 }]);
  });

  test('an added line whose content starts with "++ b/" is treated as hunk content, not a new-file header', () => {
    // Symmetric case: an added line whose original text is
    // `++ b/some-file-path` becomes the diff line `+++ b/some-file-path`
    // once prefixed with the single-`+` addition marker — indistinguishable
    // from a `+++ b/<file>` new-file header by content alone (confirmed
    // against real `git diff` output on a fixture with this exact content).
    // Without position-aware parsing this line is misdetected as the start
    // of a new file section, flushing the in-progress run under a phantom
    // file key derived from the line's own content and misattributing every
    // line that follows it in the hunk.
    const diff = [
      '--- a/src/real-file.md',
      '+++ b/src/real-file.md',
      '@@ -1,2 +1,4 @@',
      ' context unchanged',
      '-old line',
      '+line A',
      '+++ b/some-file-path',
      '+line D',
    ].join('\n');

    const { changedRanges, oldRanges } = parseDiffOutput(diff);
    // All three added lines (new lines 2-4) form one contiguous run under
    // the real file, and no phantom "some-file-path" entry is created.
    expect(changedRanges.get('src/real-file.md')).toEqual([{ start: 2, end: 4 }]);
    expect(oldRanges.get('src/real-file.md')).toEqual([{ start: 2, end: 2 }]);
    expect(changedRanges.has('some-file-path')).toBe(false);
    expect(oldRanges.has('some-file-path')).toBe(false);
  });
});

// ─── checkNoNewCycles ─────────────────────────────────────────────────

describe('checkNoNewCycles', () => {
  test('passes when changed file is NOT in a cycle', () => {
    const result = checkNoNewCycles(db, new Set(['src/handler.js']), false, false);
    expect(result.passed).toBe(true);
    expect(result.cycles).toEqual([]);
  });

  test('fails when changed file participates in a cycle', () => {
    const result = checkNoNewCycles(db, new Set(['src/math.js']), false, false);
    expect(result.passed).toBe(false);
    expect(result.cycles.length).toBeGreaterThan(0);
    // The cycle should involve math.js, and isn't speculative (plain static imports).
    const flat = result.cycles.flatMap((c) => c.nodes);
    expect(flat).toContain('src/math.js');
    expect(result.cycles.every((c) => c.speculative === false)).toBe(true);
  });

  test('excludeSpeculative has no effect on cycles formed entirely of static import edges', () => {
    // File-level cycles are built from 'imports'/'imports-type' edges only —
    // dynamic imports carry a distinct 'dynamic-imports' kind that's excluded
    // from cycle detection entirely, so no file-level cycle can be
    // speculative today. This asserts that invariant rather than assuming it.
    //
    // Normalized (sorted nodes + sorted cycle list) before comparing: an SCC's
    // member order isn't semantically meaningful, and Tarjan (native or JS)
    // makes no ordering guarantee across separate calls on the same input.
    const normalize = (cycles: { nodes: string[]; speculative: boolean }[]) =>
      cycles
        .map((c) => ({ ...c, nodes: [...c.nodes].sort() }))
        .sort((a, b) => a.nodes.join('\0').localeCompare(b.nodes.join('\0')));
    const withSpeculative = checkNoNewCycles(db, new Set(['src/math.js']), false, false);
    const withoutSpeculative = checkNoNewCycles(db, new Set(['src/math.js']), false, true);
    expect(normalize(withoutSpeculative.cycles)).toEqual(normalize(withSpeculative.cycles));
  });
});

// ─── checkMaxBlastRadius ──────────────────────────────────────────────

describe('checkMaxBlastRadius', () => {
  test('passes when max callers is below threshold', () => {
    // multiply has callers: add(d1), handleRequest+formatResult(d2), processNode+parseInput(d3) = 5
    // With depth 1 only, multiply has 1 caller (add), so threshold 3 passes
    const ranges = new Map([['src/math.js', [{ start: 7, end: 12 }]]]);
    const result = checkMaxBlastRadius(db, ranges, new Map(), 3, false, 1);
    expect(result.passed).toBe(true);
  });

  test('fails when max callers exceeds threshold', () => {
    // add has callers: handleRequest, formatResult at depth 1; parseInput, processNode at depth 2
    // No changedEdits data is provided (empty map) — a range with no matching
    // edit entry is conservatively treated as a call-graph-shape change, so
    // this predates and is unaffected by the issue #1740 exemption.
    const ranges = new Map([['src/math.js', [{ start: 1, end: 5 }]]]);
    const result = checkMaxBlastRadius(db, ranges, new Map(), 1, false, 3);
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].name).toBe('add');
    expect(result.violations[0].transitiveCallers).toBeGreaterThan(1);
  });

  test('respects maxDepth', () => {
    // With depth 1, add has 2 direct callers (handleRequest, formatResult)
    const ranges = new Map([['src/math.js', [{ start: 1, end: 5 }]]]);
    const result = checkMaxBlastRadius(db, ranges, new Map(), 10, false, 1);
    expect(result.passed).toBe(true);
    expect(result.maxFound).toBeLessThanOrEqual(10);
  });

  // ─── Call-graph shape exemption (issue #1740) ────────────────────────
  //
  // `add` (src/math.js, lines 1-5) has several transitive callers in the
  // fixture graph (handleRequest, formatResult direct; parseInput,
  // processNode transitive) — a real "high fan-in spine function" shape.
  // These tests drive `checkMaxBlastRadius` through `parseDiffOutput` (not
  // hand-built ranges) so `changedEdits` is populated for real, proving the
  // exemption logic itself rather than just the safe-fallback path above.

  test('passes for a high-fan-in function when only an internal literal changes (no call graph shape change)', () => {
    // Body-only edit on line 3 (inside add's 1-5 span), declaration
    // untouched, and neither side of the edit contains any call syntax.
    const diff = [
      '--- a/src/math.js',
      '+++ b/src/math.js',
      '@@ -3,1 +3,1 @@',
      '-  return a + b + 0;',
      '+  return a + b + ZERO_OFFSET;',
    ].join('\n');
    const { changedRanges, changedEdits } = parseDiffOutput(diff);

    // Threshold 1 would normally fail on add's multiple callers (as proven
    // by the "fails when max callers exceeds threshold" test above using
    // the same threshold) — but this diff never changed add's call graph
    // shape, so its pre-existing fan-in should not fail the gate.
    const result = checkMaxBlastRadius(db, changedRanges, changedEdits, 1, false, 3);
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.exemptedCount).toBe(1);
    expect(result.note).toMatch(/exempted/);
  });

  test('still fails for a high-fan-in function when the diff adds a new call', () => {
    // Same line, but the replacement introduces a brand new call target
    // (`validate`) that wasn't referenced before — a genuine call-graph
    // shape change, so the pre-existing fan-in must still gate.
    const diff = [
      '--- a/src/math.js',
      '+++ b/src/math.js',
      '@@ -3,1 +3,1 @@',
      '-  return a + b;',
      '+  return validate(a) + b;',
    ].join('\n');
    const { changedRanges, changedEdits } = parseDiffOutput(diff);

    const result = checkMaxBlastRadius(db, changedRanges, changedEdits, 1, false, 3);
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].name).toBe('add');
    expect(result.exemptedCount).toBe(0);
  });

  test('still fails for a high-fan-in function when the diff changes its own declaration line', () => {
    // add's declaration is at line 1. Even though neither side references a
    // new call target, touching the declaration line itself is a signature
    // risk and must not be exempted.
    const diff = [
      '--- a/src/math.js',
      '+++ b/src/math.js',
      '@@ -1,1 +1,1 @@',
      '-function add(a, b) {',
      '+function add(a, b, c) {',
    ].join('\n');
    const { changedRanges, changedEdits } = parseDiffOutput(diff);

    const result = checkMaxBlastRadius(db, changedRanges, changedEdits, 1, false, 3);
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].name).toBe('add');
  });

  test('still fails when a call target is swapped even though a paren token is reused', () => {
    // Both sides reference identifiers followed by `(`, but the SETS differ
    // (formatResult replaced by parseInput) — a real callee swap, not a
    // no-op, so it must not be exempted.
    const diff = [
      '--- a/src/math.js',
      '+++ b/src/math.js',
      '@@ -3,1 +3,1 @@',
      '-  return formatResult(a) + b;',
      '+  return parseInput(a) + b;',
    ].join('\n');
    const { changedRanges, changedEdits } = parseDiffOutput(diff);

    const result = checkMaxBlastRadius(db, changedRanges, changedEdits, 1, false, 3);
    expect(result.passed).toBe(false);
    expect(result.exemptedCount).toBe(0);
  });

  test('still fails for a high-fan-in function when a parameter is added on line 2+ of a multi-line signature', () => {
    // multiLineSig's declaration spans lines 20 (opening) through 22 (its
    // last parameter, `b`, on its own line) — only line 20 is `def.line`.
    // Editing line 22 to add a parameter must still be read as a
    // declaration/signature change even though it never touches line 20
    // itself, and a parameter list has no `identifier(` tokens for the
    // paren-token comparison to catch either.
    const diff = [
      '--- a/src/multiline.js',
      '+++ b/src/multiline.js',
      '@@ -22,1 +22,1 @@',
      '-  b,',
      '+  b, c,',
    ].join('\n');
    const { changedRanges, changedEdits } = parseDiffOutput(diff);

    const result = checkMaxBlastRadius(db, changedRanges, changedEdits, 1, false, 3);
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].name).toBe('multiLineSig');
    expect(result.exemptedCount).toBe(0);
  });

  test('passes for a high-fan-in function when a multi-line signature is untouched and only the body changes', () => {
    // Sanity check for the fix above: an edit strictly inside the body
    // (line 23, past the last parameter on line 22) with no new call target
    // must still be exempted — the signature-end-line widening must not
    // over-exempt the whole function span.
    const diff = [
      '--- a/src/multiline.js',
      '+++ b/src/multiline.js',
      '@@ -23,1 +23,1 @@',
      '-  return a + b + 0;',
      '+  return a + b + ZERO_OFFSET;',
    ].join('\n');
    const { changedRanges, changedEdits } = parseDiffOutput(diff);

    const result = checkMaxBlastRadius(db, changedRanges, changedEdits, 1, false, 3);
    expect(result.passed).toBe(true);
    expect(result.exemptedCount).toBe(1);
  });

  test('still fails when a real call is replaced by a string literal merely mentioning the same identifier', () => {
    // The removed line makes a genuine call to `bar`; the added line only
    // *mentions* `bar(` inside a string literal. Without stripping string
    // content first, the naive regex would read both sides as referencing
    // the token "bar" and wrongly treat this as a no-op.
    const diff = [
      '--- a/src/math.js',
      '+++ b/src/math.js',
      '@@ -3,1 +3,1 @@',
      '-  return bar() + b;',
      "+  return 'invoke bar(x)' + b;",
    ].join('\n');
    const { changedRanges, changedEdits } = parseDiffOutput(diff);

    const result = checkMaxBlastRadius(db, changedRanges, changedEdits, 1, false, 3);
    expect(result.passed).toBe(false);
    expect(result.exemptedCount).toBe(0);
  });
});

// ─── checkNoSignatureChanges ──────────────────────────────────────────

describe('checkNoSignatureChanges', () => {
  test('passes for body-only changes', () => {
    // add is at line 1. Changing lines 3-5 (body only) should pass
    const changedRanges = new Map([['src/math.js', [{ start: 3, end: 5 }]]]);
    const result = checkNoSignatureChanges(db, changedRanges, false);
    expect(result.passed).toBe(true);
  });

  test('fails when declaration line is in a changed hunk', () => {
    // add is at line 1. Changing lines 1-2 (includes declaration) should fail
    const changedRanges = new Map([['src/math.js', [{ start: 1, end: 2 }]]]);
    const result = checkNoSignatureChanges(db, changedRanges, false);
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.violations[0].name).toBe('add');
  });

  test('skips test files when noTests is true', () => {
    const changedRanges = new Map([['tests/math.test.js', [{ start: 1, end: 5 }]]]);
    const result = checkNoSignatureChanges(db, changedRanges, true);
    expect(result.passed).toBe(true);
  });

  test('does not flag a private (non-exported) symbol whose declaration was removed', () => {
    // roundHalfEven is at line 14, exported=0. Deleting it entirely — the
    // exact "adopt shared helper, drop the file-local duplicate" pattern
    // grind performs — must not trip this check: every caller of a
    // private helper lives in the same file and is already part of the diff.
    const changedRanges = new Map([['src/math.js', [{ start: 14, end: 16 }]]]);
    const result = checkNoSignatureChanges(db, changedRanges, false);
    expect(result.passed).toBe(true);
  });

  test('still flags an exported symbol even when a private symbol shares the file', () => {
    // Sanity check that the exported-only filter doesn't accidentally
    // suppress real violations on exported declarations in the same file.
    const changedRanges = new Map([
      [
        'src/math.js',
        [
          { start: 1, end: 2 }, // add's declaration (exported)
          { start: 14, end: 16 }, // roundHalfEven's declaration (private)
        ],
      ],
    ]);
    const result = checkNoSignatureChanges(db, changedRanges, false);
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

    const { oldRanges, changedRanges } = parseDiffOutput(diff);
    // parseDiffOutput's old-side tracking is still verified directly here...
    expect(oldRanges.get('src/math.js')).toEqual([{ start: 6, end: 6 }]);

    // ...but checkNoSignatureChanges itself is driven by changedRanges
    // (new-file coordinates). This hunk has no added lines, so there is
    // nothing to compare against and multiply is correctly left alone.
    const result = checkNoSignatureChanges(db, changedRanges, false);
    expect(result.passed).toBe(true);
  });

  test('regression: coordinate-space mismatch does not falsely flag an untouched function after a shifting deletion (issues #1732, #1737)', () => {
    // Real-world repro shape: an exported function sits right after an
    // 11-line block that gets deleted outright. The db reflects the
    // POST-change file (the block is gone, the function shifted up 11
    // lines), while the diff's old-side range still spans the pre-change
    // line numbers. Before the fix, checkNoSignatureChanges was wired to
    // `oldRanges`, so the function's new (post-change) line would
    // coincidentally fall inside the old hunk's numeric range and get
    // falsely flagged, even though its body is byte-for-byte identical.
    insertNode(db, 'isPidAlive', 'function', 'src/coordshift.js', 2, 4, 1);

    const diff = [
      '--- a/src/coordshift.js',
      '+++ b/src/coordshift.js',
      '@@ -2,11 +1,0 @@',
      '-function helperToRemove() {',
      '-  return 1;',
      '-}',
      '-',
      '-function alsoUnused() {',
      '-  return 2;',
      '-}',
      '-',
      '-function oneMoreUnused() {',
      '-  return 3;',
      '-}',
    ].join('\n');

    const parsed = parseDiffOutput(diff);
    // Pure deletion: the old side covers exactly the 11 removed lines; the
    // new side has nothing added, so changedRanges is empty for this file.
    expect(parsed.oldRanges.get('src/coordshift.js')).toEqual([{ start: 2, end: 12 }]);
    expect(parsed.changedRanges.get('src/coordshift.js')).toEqual([]);

    // Prove the regression is real: had the call site still passed
    // oldRanges, isPidAlive's post-change line (2) falls inside the old
    // range [2, 12] and would be wrongly flagged.
    const buggyResult = checkNoSignatureChanges(db, parsed.oldRanges, false);
    expect(buggyResult.passed).toBe(false);
    expect(buggyResult.violations.map((v) => v.name)).toContain('isPidAlive');

    // The fix: changedRanges is empty for a pure deletion, so there is
    // nothing to compare against and isPidAlive is correctly left alone.
    const fixedResult = checkNoSignatureChanges(db, parsed.changedRanges, false);
    expect(fixedResult.passed).toBe(true);
  });

  test('a genuinely touched exported function IS flagged via changedRanges (issues #1732, #1737)', () => {
    // Complements the untouched-function case above: when a hunk actually
    // replaces a declaration line, the post-change db line falls inside
    // the *new*-side range and must still be flagged.
    insertNode(db, 'someExportedFn', 'function', 'src/coordshift2.js', 1, 3, 1);

    const diff = [
      '--- a/src/coordshift2.js',
      '+++ b/src/coordshift2.js',
      '@@ -1,1 +1,1 @@',
      '-function someExportedFn() {',
      '+function someExportedFn(extra) {',
    ].join('\n');

    const { changedRanges } = parseDiffOutput(diff);
    expect(changedRanges.get('src/coordshift2.js')).toEqual([{ start: 1, end: 1 }]);

    const result = checkNoSignatureChanges(db, changedRanges, false);
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.name)).toContain('someExportedFn');
  });
});

// ─── checkNoDeletedExportsInUse (issue #1806) ──────────────────────────

describe('checkNoDeletedExportsInUse', () => {
  test('flags an exported symbol whose file is deleted when it still has external callers', () => {
    // Fixture: add (exported, src/math.js) is called by handleRequest
    // (src/handler.js) and formatResult (src/utils.js) — both external.
    const result = checkNoDeletedExportsInUse(db, new Set(['src/math.js']), false);
    expect(result.passed).toBe(false);
    const violation = result.violations.find((v) => v.name === 'add');
    expect(violation).toBeDefined();
    expect(violation.reason).toBe('file-deleted');
    expect(violation.consumers.map((c) => c.file).sort()).toEqual([
      'src/handler.js',
      'src/utils.js',
    ]);
  });

  test('does not flag an exported symbol whose only caller lives in the same deleted file', () => {
    // multiply (exported, src/math.js) is only called by `add`, which lives
    // in the same file being deleted — not an external consumer left
    // dangling by this diff.
    const result = checkNoDeletedExportsInUse(db, new Set(['src/math.js']), false);
    expect(result.violations.map((v) => v.name)).not.toContain('multiply');
  });

  test('passes for a deleted file with no exported symbols', () => {
    const result = checkNoDeletedExportsInUse(db, new Set(['src/processor.js']), false);
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('passes when deletedFiles is empty', () => {
    const result = checkNoDeletedExportsInUse(db, new Set(), false);
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('excludes a caller that is itself among the files this diff also deletes', () => {
    // handler.js (home of handleRequest, one of add's two external callers)
    // is being deleted in the same diff — its call to `add` must not count
    // as a dangling external consumer. formatResult (utils.js) is untouched
    // and must still be reported.
    const result = checkNoDeletedExportsInUse(
      db,
      new Set(['src/math.js', 'src/handler.js']),
      false,
    );
    const violation = result.violations.find((v) => v.name === 'add');
    expect(violation).toBeDefined();
    expect(violation.consumers.map((c) => c.file)).toEqual(['src/utils.js']);
  });

  test('skips a deleted file when noTests is true and it is a test file', () => {
    const result = checkNoDeletedExportsInUse(db, new Set(['tests/math.test.js']), true);
    expect(result.passed).toBe(true);
  });

  test('suppresses a violation when noTests is true and every consumer of a deleted non-test file is a test file', () => {
    // onlyTestConsumer (exported, src/only-test-consumer.js) is called only
    // from a test file — a real violation with noTests=false, but the
    // consumer-side filter (`consumers.filter((c) => !isTestFile(c.file))`)
    // must drop that lone consumer when noTests=true, leaving zero
    // consumers and suppressing the violation entirely. Distinct from the
    // test above, which skips a *deleted test file*, not a deleted
    // non-test file whose consumers are all tests.
    const onlyTestConsumer = insertNode(
      db,
      'onlyTestConsumer',
      'function',
      'src/only-test-consumer.js',
      1,
      3,
      1,
    );
    const callerTest = insertNode(
      db,
      'callsOnlyTestConsumer',
      'function',
      'tests/only-test-consumer.test.js',
      1,
      3,
    );
    insertEdge(db, callerTest, onlyTestConsumer, 'calls');

    const withTests = checkNoDeletedExportsInUse(db, new Set(['src/only-test-consumer.js']), false);
    expect(withTests.violations.map((v) => v.name)).toContain('onlyTestConsumer');

    const noTests = checkNoDeletedExportsInUse(db, new Set(['src/only-test-consumer.js']), true);
    expect(noTests.violations.map((v) => v.name)).not.toContain('onlyTestConsumer');
  });
});

// ─── checkNoDeletedExportsInUse: advisory fallback (issue #1938) ───────
//
// `src/purged.js` deliberately has NO rows in `nodes` — simulating a file
// whose exported-symbol rows were already purged by an intervening rebuild
// before `codegraph check` ran. Its persisted `deleted_export_advisories`
// snapshot (captured by that rebuild, before the purge) is what
// `checkNoDeletedExportsInUse` must fall back to.

function insertAdvisory(db, file, name, kind, line, consumerName, consumerFile, consumerLine) {
  db.prepare(
    `INSERT INTO deleted_export_advisories
       (file, name, kind, line, consumer_name, consumer_file, consumer_line, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(file, name, kind, line, consumerName, consumerFile, consumerLine, Date.now());
}

describe('checkNoDeletedExportsInUse: advisory fallback after purge (issue #1938)', () => {
  test('flags a violation from the persisted advisory snapshot once live nodes are already purged', () => {
    insertAdvisory(
      db,
      'src/purged.js',
      'purgedHelper',
      'function',
      3,
      'useIt',
      'src/other-consumer.js',
      5,
    );

    const result = checkNoDeletedExportsInUse(db, new Set(['src/purged.js']), false);
    expect(result.passed).toBe(false);
    const violation = result.violations.find((v) => v.name === 'purgedHelper');
    expect(violation).toBeDefined();
    expect(violation.reason).toBe('file-deleted');
    expect(violation.consumers.map((c) => c.file)).toEqual(['src/other-consumer.js']);
  });

  test('excludes an advisory consumer that is itself part of the current deletion batch', () => {
    insertAdvisory(
      db,
      'src/purged-2.js',
      'purgedHelper2',
      'function',
      1,
      'useIt2',
      'src/purged-2-consumer.js',
      2,
    );

    const result = checkNoDeletedExportsInUse(
      db,
      new Set(['src/purged-2.js', 'src/purged-2-consumer.js']),
      false,
    );
    expect(result.violations.map((v) => v.name)).not.toContain('purgedHelper2');
  });

  test('respects noTests when filtering advisory consumers', () => {
    insertAdvisory(
      db,
      'src/purged-3.js',
      'purgedHelper3',
      'function',
      1,
      'testOnlyCaller',
      'tests/purged-3.test.js',
      2,
    );

    const result = checkNoDeletedExportsInUse(db, new Set(['src/purged-3.js']), true);
    expect(result.violations.map((v) => v.name)).not.toContain('purgedHelper3');
  });

  test('prefers the live query over a stale advisory when nodes still exist', () => {
    // src/math.js DOES have live nodes in the fixture DB — a stale advisory
    // row for it (as if left over from a since-resolved earlier deletion)
    // must not be surfaced instead of (or in addition to) the live result.
    insertAdvisory(
      db,
      'src/math.js',
      'stalePhantomExport',
      'function',
      99,
      'staleCaller',
      'src/stale-caller.js',
      1,
    );

    const result = checkNoDeletedExportsInUse(db, new Set(['src/math.js']), false);
    expect(result.violations.map((v) => v.name)).not.toContain('stalePhantomExport');
    // The real live violation (`add`) must still be reported normally.
    expect(result.violations.map((v) => v.name)).toContain('add');
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

// ─── checkData: full file deletion (issue #1806) ───────────────────────
//
// End-to-end repro of the scenario the issue describes: file A exports a
// symbol used by file B; staging A's deletion (with B untouched) must be
// flagged, while deleting a file with no external callers must not be.
// checkData is exercised directly (not via a rebuild) so `db` reflects the
// pre-purge state checkNoDeletedExportsInUse depends on — see that
// function's docstring for why purge ordering matters here.

describe('checkData: full file deletion (issue #1806)', () => {
  test('flags an exported function whose entire file is deleted while a real external caller remains', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-check-delfile-'));
    fs.mkdirSync(path.join(projectDir, '.codegraph'));
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    const projectDbPath = path.join(projectDir, '.codegraph', 'graph.db');

    const projectDb = new Database(projectDbPath);
    projectDb.pragma('journal_mode = WAL');
    initSchema(projectDb);
    // src/shared.js exports sharedHelper, called by src/consumer.js.
    const sharedHelperId = insertNode(
      projectDb,
      'sharedHelper',
      'function',
      'src/shared.js',
      1,
      3,
      1,
    );
    const callerId = insertNode(projectDb, 'useShared', 'function', 'src/consumer.js', 1, 3, 0);
    insertEdge(projectDb, callerId, sharedHelperId, 'calls');
    projectDb.close();

    const { execFileSync } = require('node:child_process');
    try {
      execFileSync('git', ['init'], { cwd: projectDir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], {
        cwd: projectDir,
        stdio: 'pipe',
      });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectDir, stdio: 'pipe' });

      fs.writeFileSync(
        path.join(projectDir, 'src', 'shared.js'),
        'export function sharedHelper() {\n  return 1;\n}\n',
      );
      fs.writeFileSync(
        path.join(projectDir, 'src', 'consumer.js'),
        "import { sharedHelper } from './shared.js';\nfunction useShared() {\n  return sharedHelper();\n}\n",
      );
      execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'pipe' });

      // Stage ONLY the deletion of shared.js — consumer.js is left
      // untouched, still importing/calling it. A real diff-parsing bug
      // would let this slip through silently.
      execFileSync('git', ['rm', 'src/shared.js'], { cwd: projectDir, stdio: 'pipe' });

      const data = checkData(projectDbPath, {
        staged: true,
        signatures: true,
        cycles: false,
        boundaries: false,
      });

      expect(data.error).toBeUndefined();
      expect(data.summary.deletedFiles).toBe(1);
      expect(data.passed).toBe(false);

      const sigPred = data.predicates.find((p) => p.name === 'signatures');
      expect(sigPred).toBeDefined();
      expect(sigPred.passed).toBe(false);
      const violation = sigPred.violations.find((v) => v.name === 'sharedHelper');
      expect(violation).toBeDefined();
      expect(violation.reason).toBe('file-deleted');
      expect(violation.consumers.map((c) => c.file)).toContain('src/consumer.js');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('does not flag deleting a file whose exports have no external callers', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-check-delfile-safe-'));
    fs.mkdirSync(path.join(projectDir, '.codegraph'));
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    const projectDbPath = path.join(projectDir, '.codegraph', 'graph.db');

    const projectDb = new Database(projectDbPath);
    projectDb.pragma('journal_mode = WAL');
    initSchema(projectDb);
    // src/orphan.js exports unusedHelper — zero callers anywhere.
    insertNode(projectDb, 'unusedHelper', 'function', 'src/orphan.js', 1, 3, 1);
    projectDb.close();

    const { execFileSync } = require('node:child_process');
    try {
      execFileSync('git', ['init'], { cwd: projectDir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], {
        cwd: projectDir,
        stdio: 'pipe',
      });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectDir, stdio: 'pipe' });

      fs.writeFileSync(
        path.join(projectDir, 'src', 'orphan.js'),
        'export function unusedHelper() {\n  return 1;\n}\n',
      );
      execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'pipe' });

      execFileSync('git', ['rm', 'src/orphan.js'], { cwd: projectDir, stdio: 'pipe' });

      const data = checkData(projectDbPath, {
        staged: true,
        signatures: true,
        cycles: false,
        boundaries: false,
      });

      expect(data.error).toBeUndefined();
      expect(data.summary.deletedFiles).toBe(1);
      expect(data.passed).toBe(true);
      const sigPred = data.predicates.find((p) => p.name === 'signatures');
      expect(sigPred).toBeDefined();
      expect(sigPred.passed).toBe(true);
      expect(sigPred.violations).toEqual([]);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
