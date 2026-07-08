import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  findDbPath,
  findExportedDefinitions,
  findExternalConsumers,
  getDeletedExportAdvisories,
  openReadonlyOrFail,
} from '../db/index.js';
import { bfsTransitiveCallers } from '../domain/analysis/impact.js';
import type { Cycle } from '../domain/graph/cycles.js';
import { findCycles } from '../domain/graph/cycles.js';
import { DEFAULTS, loadConfig } from '../infrastructure/config.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import type { BetterSqlite3Database, CodegraphConfig } from '../types.js';
import { matchOwners, parseCodeowners } from './owners.js';

// ─── Diff Parser ──────────────────────────────────────────────────────

interface DiffRange {
  start: number;
  end: number;
}

interface ParsedDiff {
  changedRanges: Map<string, DiffRange[]>;
  oldRanges: Map<string, DiffRange[]>;
  newFiles: Set<string>;
  /**
   * One entry per `changedRanges` run (same file, same start/end), carrying
   * the actual added-line text plus whatever removed-line text immediately
   * preceded it within the same hunk (empty for a pure insertion). Powers
   * `checkMaxBlastRadius`'s call-graph-shape exemption — see issue #1740.
   */
  changedEdits: Map<string, DiffTextEdit[]>;
  /**
   * Files removed in their entirety (a `--- a/<file>` header followed by a
   * `+++ /dev/null` target, git's marker for a full-file deletion) — distinct
   * from `changedRanges`/`oldRanges`, which never gain an entry for these
   * files since there is no new-side content to track. Powers
   * `checkNoDeletedExportsInUse` — see issue #1806.
   */
  deletedFiles: Set<string>;
}

/** An added-line run paired with whatever it replaced, for shape comparison. */
interface DiffTextEdit extends DiffRange {
  addedText: string[];
  removedText: string[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NEW_FILE_RE = /^\+\+\+ b\/(.+)/;
const OLD_FILE_RE = /^--- a\/(.+)/;

/** Returns true if the diff line marks the old file as /dev/null (new-file creation). */
function isDevNullSourceLine(line: string): boolean {
  return line.startsWith('--- /dev/null');
}

/** Returns true if the diff line is a `---` source file header (not /dev/null). */
function isSourceFileHeaderLine(line: string): boolean {
  return line.startsWith('--- ');
}

/** Extracts the new filename from a `+++ b/<file>` diff header, or null. */
function extractNewFileName(line: string): string | null {
  const m = line.match(NEW_FILE_RE);
  return m ? m[1]! : null;
}

/** Extracts the old filename from a `--- a/<file>` diff header, or null. */
function extractOldFileName(line: string): string | null {
  const m = line.match(OLD_FILE_RE);
  return m ? m[1]! : null;
}

/** Returns true if the diff line marks the new file as /dev/null (file deletion). */
function isDevNullTargetLine(line: string): boolean {
  return line.startsWith('+++ /dev/null');
}

/**
 * Tracks the old-side and new-side line cursors and the current runs of
 * contiguously removed/added lines while walking a hunk body, so
 * `parseDiffOutput` can emit precise `oldRanges` and `changedRanges` (only
 * lines actually deleted/replaced or added) instead of the raw hunk header
 * span (which always includes unchanged context lines on each side per the
 * unified diff format whenever the diff was produced with non-zero context).
 * `getGitDiff` always passes `--unified=0`, so in practice the header span
 * and the tracked lines coincide today — but `parseDiffOutput` is a public
 * export and this keeps it correct for any diff input, not just this one
 * caller's.
 */
class DiffLineTracker {
  private oldLineCursor = 0;
  private newLineCursor = 0;
  /** End-exclusive old/new bounds declared by the current hunk's `@@ -a,b +c,d @@` header — see `insideHunk`. */
  private oldHunkEnd = 0;
  private newHunkEnd = 0;
  private removedRunStart: number | null = null;
  private removedRunEnd: number | null = null;
  private addedRunStart: number | null = null;
  private addedRunEnd: number | null = null;
  private currentRemovedText: string[] = [];
  private currentAddedText: string[] = [];
  /**
   * Text of the most recently closed removed run, staged so the next added
   * run (if any, within the same hunk) can be paired with it into one
   * `DiffTextEdit`. Cleared at the start of every hunk (`startHunk`) so
   * pairing never crosses a hunk boundary — an unpaired trailing deletion in
   * one hunk must never be attributed to an unrelated insertion in the next.
   */
  private pendingRemovedText: string[] = [];

  startHunk(oldStart: number, oldCount: number, newStart: number, newCount: number): void {
    this.oldLineCursor = oldStart;
    this.newLineCursor = newStart;
    this.oldHunkEnd = oldStart + oldCount;
    this.newHunkEnd = newStart + newCount;
    this.pendingRemovedText = [];
  }

  /**
   * True while either cursor is still short of the bounds declared by the
   * most recent hunk header — i.e. while a hunk body is still being walked.
   * False before the first hunk header of a file is seen, and again once
   * both sides' declared line counts have been fully consumed.
   *
   * `parseDiffOutput` only attempts `--- `/`+++ b/` file-header matching
   * while this is false. A hunk body line whose own content starts with
   * `-- `/`++ ` (e.g. removing a Markdown horizontal rule `-- foo`) becomes
   * `--- foo`/`+++ foo` once diff-prefixed — indistinguishable from a real
   * file header by content alone — so position, not pattern, is what must
   * disambiguate it. See issue #1761.
   */
  insideHunk(): boolean {
    return this.oldLineCursor < this.oldHunkEnd || this.newLineCursor < this.newHunkEnd;
  }

  /**
   * Consumes one hunk body line, advancing the old- and new-side cursors as
   * needed. The caller only attempts `--- `/`+++ ` file-header matching while
   * `insideHunk()` is false, so a body line that happens to start with one of
   * those prefixes (the diff-prefixed form of a removed/added line whose own
   * content starts with dashes or pluses, e.g. literal text `-- foo`) still
   * reaches here as ordinary content instead of being misdetected as a
   * header. A leading `-`/`+` therefore unambiguously marks a removed/added
   * line regardless of what follows it.
   */
  consume(
    line: string,
    file: string,
    oldRanges: Map<string, DiffRange[]>,
    changedRanges: Map<string, DiffRange[]>,
    changedEdits: Map<string, DiffTextEdit[]>,
  ): void {
    if (line.startsWith('-')) {
      this.flushAdded(file, changedRanges, changedEdits);
      if (this.removedRunStart === null) this.removedRunStart = this.oldLineCursor;
      this.removedRunEnd = this.oldLineCursor;
      this.currentRemovedText.push(line.slice(1));
      this.oldLineCursor++;
      return;
    }
    if (line.startsWith('+')) {
      this.flushRemoved(file, oldRanges);
      if (this.addedRunStart === null) this.addedRunStart = this.newLineCursor;
      this.addedRunEnd = this.newLineCursor;
      this.currentAddedText.push(line.slice(1));
      this.newLineCursor++;
      return;
    }
    // A context line or a "\ No newline" marker ends both runs. Also clear
    // any staged `pendingRemovedText`: `flushAdded` only pairs it with an
    // added run that starts flushing right here, immediately adjacent (no
    // intervening line) to the removal that staged it. A context line breaks
    // that adjacency, so a later, unrelated added run must not be paired
    // with a removal that sat on the other side of unchanged context. This
    // only matters for diffs with non-zero context (`getGitDiff` always
    // passes `--unified=0`, so it never fires in production) — but
    // `parseDiffOutput` is a public export and must stay correct for any
    // diff input.
    this.flushRemoved(file, oldRanges);
    this.flushAdded(file, changedRanges, changedEdits);
    this.pendingRemovedText = [];
    if (line.startsWith(' ')) {
      this.oldLineCursor++;
      this.newLineCursor++;
    }
  }

  /**
   * Closes out the current removed-line run, if any, into `oldRanges` and
   * stages its text as `pendingRemovedText` for the next added run to
   * (optionally) pair with.
   */
  flushRemoved(file: string, oldRanges: Map<string, DiffRange[]>): void {
    if (this.removedRunStart !== null) {
      oldRanges.get(file)!.push({ start: this.removedRunStart, end: this.removedRunEnd! });
      this.removedRunStart = null;
      this.removedRunEnd = null;
      this.pendingRemovedText = this.currentRemovedText;
      this.currentRemovedText = [];
    }
  }

  /**
   * Closes out the current added-line run, if any, into `changedRanges` and
   * records the paired `DiffTextEdit` (added text + whatever removed text was
   * staged immediately before it) into `changedEdits`.
   */
  flushAdded(
    file: string,
    changedRanges: Map<string, DiffRange[]>,
    changedEdits: Map<string, DiffTextEdit[]>,
  ): void {
    if (this.addedRunStart !== null) {
      const range = { start: this.addedRunStart, end: this.addedRunEnd! };
      changedRanges.get(file)!.push(range);
      changedEdits.get(file)!.push({
        ...range,
        addedText: this.currentAddedText,
        removedText: this.pendingRemovedText,
      });
      this.addedRunStart = null;
      this.addedRunEnd = null;
      this.currentAddedText = [];
      this.pendingRemovedText = [];
    }
  }

  /** Closes out both the removed- and added-line runs, if any. */
  flush(
    file: string,
    oldRanges: Map<string, DiffRange[]>,
    changedRanges: Map<string, DiffRange[]>,
    changedEdits: Map<string, DiffTextEdit[]>,
  ): void {
    this.flushRemoved(file, oldRanges);
    this.flushAdded(file, changedRanges, changedEdits);
  }
}

export function parseDiffOutput(diffOutput: string): ParsedDiff {
  const changedRanges = new Map<string, DiffRange[]>();
  const oldRanges = new Map<string, DiffRange[]>();
  const changedEdits = new Map<string, DiffTextEdit[]>();
  const newFiles = new Set<string>();
  const deletedFiles = new Set<string>();
  let currentFile: string | null = null;
  let prevIsDevNull = false;
  // Old-side filename staged by a `--- a/<file>` header, in case the very
  // next header turns out to be `+++ /dev/null` (this file was deleted in
  // its entirety). Cleared whenever the following header resolves to
  // anything else, so it never leaks across an unrelated file's headers.
  let pendingOldFile: string | null = null;
  const tracker = new DiffLineTracker();

  for (const line of diffOutput.split('\n')) {
    // File-header lines (`--- `/`+++ b/`/`+++ /dev/null`) only ever appear
    // between hunks — before the first hunk of a file, or once the previous
    // hunk's declared old/new line counts are fully consumed. Gating this
    // whole block on `!insideHunk()` keeps a hunk-body line whose own
    // content starts with `-- `/`++ ` (e.g. a Markdown horizontal rule) from
    // being misdetected as a file header purely because of a text
    // coincidence — position, not pattern, decides. See issue #1761.
    if (!tracker.insideHunk()) {
      if (isDevNullSourceLine(line)) {
        prevIsDevNull = true;
        pendingOldFile = null;
        continue;
      }
      if (isSourceFileHeaderLine(line)) {
        prevIsDevNull = false;
        pendingOldFile = extractOldFileName(line);
        continue;
      }
      const newFile = extractNewFileName(line);
      if (newFile) {
        if (currentFile) tracker.flush(currentFile, oldRanges, changedRanges, changedEdits);
        currentFile = newFile;
        if (!changedRanges.has(currentFile)) changedRanges.set(currentFile, []);
        if (!oldRanges.has(currentFile)) oldRanges.set(currentFile, []);
        if (!changedEdits.has(currentFile)) changedEdits.set(currentFile, []);
        if (prevIsDevNull) newFiles.add(currentFile);
        prevIsDevNull = false;
        pendingOldFile = null;
        continue;
      }
      if (isDevNullTargetLine(line)) {
        // `+++ /dev/null` (file deletion) is not `b/`-prefixed, so
        // extractNewFileName returned null above and this line would otherwise
        // fall through to tracker.consume and be misread as an added source
        // line under whichever file preceded this one in the diff. Flush and
        // clear the file context instead — a deleted file never accumulates
        // changedRanges/oldRanges entries (there is no new-side content, and
        // the old-side body is about to disappear along with the file), but
        // its pre-purge DB rows are still worth checking for lingering
        // external consumers — see `checkNoDeletedExportsInUse` (#1806).
        if (currentFile) tracker.flush(currentFile, oldRanges, changedRanges, changedEdits);
        if (pendingOldFile) deletedFiles.add(pendingOldFile);
        currentFile = null;
        prevIsDevNull = false;
        pendingOldFile = null;
        continue;
      }
    }
    if (!currentFile) continue;

    const hunkMatch = line.match(HUNK_RE);
    if (hunkMatch) {
      tracker.flush(currentFile, oldRanges, changedRanges, changedEdits);
      const oldCount = hunkMatch[2] === undefined ? 1 : parseInt(hunkMatch[2], 10);
      const newCount = hunkMatch[4] === undefined ? 1 : parseInt(hunkMatch[4], 10);
      tracker.startHunk(
        parseInt(hunkMatch[1]!, 10),
        oldCount,
        parseInt(hunkMatch[3]!, 10),
        newCount,
      );
      continue;
    }

    tracker.consume(line, currentFile, oldRanges, changedRanges, changedEdits);
  }
  if (currentFile) tracker.flush(currentFile, oldRanges, changedRanges, changedEdits);

  return { changedRanges, oldRanges, newFiles, changedEdits, deletedFiles };
}

// ─── Predicates ───────────────────────────────────────────────────────

interface CyclesResult {
  passed: boolean;
  cycles: Cycle[];
}

export function checkNoNewCycles(
  db: BetterSqlite3Database,
  changedFiles: Set<string>,
  noTests: boolean,
  excludeSpeculative: boolean,
): CyclesResult {
  const cycles = findCycles(db, { fileLevel: true, noTests, excludeSpeculative });
  const involved = cycles.filter((cycle) => cycle.nodes.some((f) => changedFiles.has(f)));
  return { passed: involved.length === 0, cycles: involved };
}

interface BlastRadiusViolation {
  name: string;
  kind: string;
  file: string;
  line: number;
  transitiveCallers: number;
}

interface BlastRadiusResult {
  passed: boolean;
  maxFound: number;
  threshold: number;
  violations: BlastRadiusViolation[];
  /** Count of touched functions whose call graph shape didn't change — see issue #1740. */
  exemptedCount: number;
  note?: string;
}

type DefRow = {
  id: number;
  name: string;
  kind: string;
  file: string;
  line: number;
  end_line: number | null;
};

function rangesOverlap(defLine: number, endLine: number, ranges: DiffRange[]): boolean {
  for (const range of ranges) {
    if (range.start <= endLine && range.end >= defLine) return true;
  }
  return false;
}

function defEndLine(def: DefRow, nextDef: DefRow | undefined): number {
  return def.end_line || (nextDef ? nextDef.line - 1 : 999999);
}

// ─── Call-graph shape detection (issue #1740) ──────────────────────────
//
// A function's absolute transitive-caller count is a property of the whole
// codebase's dependency structure, not of what a given diff changed inside
// that function. Gating on the raw count means any touch to a high-fan-in
// "spine" function (e.g. one reachable only through another near-universally
// called function) always fails, even fully behavior-preserving edits like
// replacing an inline literal with a named constant. The functions below
// let `checkMaxBlastRadius` tell "pre-existing fan-in" (already accepted by
// the codebase) apart from "risk introduced by this diff": only a def whose
// diff touches its own declaration line or changes the set of call targets
// referenced in its body counts its absolute caller count toward the gate.

/**
 * Matches a quoted string/template literal (double, single, or backtick
 * delimited, with `\`-escaping honored). Stripped from a line before token
 * extraction so that call-shaped text living inside string content (e.g. a
 * log message mentioning `bar(x)`) doesn't masquerade as an actual call
 * target — see `parenTokens`.
 */
const STRING_LITERAL_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/**
 * Matches an identifier immediately followed by `(`. Used only to compare
 * the SET of such tokens between an edit's removed and added text — not to
 * classify any single line as "a call" — which sidesteps having to tell a
 * real call apart from `if (...)`/`while (...)`/a declaration's own `(...)`
 * on syntax alone: if a token (call, keyword, or otherwise) appears on both
 * sides, it nets out and isn't treated as a change; only a token gained or
 * lost between the two sides counts.
 *
 * Known limitations, both deliberate, documented trade-offs for a
 * mechanical, non-parsing check — see issue #1740:
 * - Paren-less call syntax (e.g. Ruby's `foo x, y`, Lua's `foo "arg"`) is
 *   invisible to this heuristic, so a newly introduced paren-less call could
 *   be missed and its function wrongly exempted.
 * - Only quoted string/template literals are stripped before matching, not
 *   comments — comment syntax varies too widely across the 34 supported
 *   languages to strip safely with a single regex. An `identifier(` pattern
 *   inside a comment can still affect the token-set comparison.
 */
const PAREN_TOKEN_RE = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

function parenTokens(lines: string[]): Set<string> {
  const tokens = new Set<string>();
  for (const line of lines) {
    for (const m of line.replace(STRING_LITERAL_RE, '').matchAll(PAREN_TOKEN_RE)) {
      tokens.add(m[1]!);
    }
  }
  return tokens;
}

function sameTokenSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/**
 * Returns the highest line number among `defId`'s own `parameter` children
 * (or `defLine` if it has none — e.g. a zero-arg function, or a `class` def,
 * whose parameters if any belong to its methods, not the class itself).
 * Lets `callGraphShapeChanged` treat the declaration as spanning the whole
 * parameter list, not just `def.line` — otherwise an edit to a parameter on
 * line 2+ of a multi-line TypeScript signature is invisible to the
 * declaration-line guard, and since a parameter list contains no
 * `identifier(` patterns, `parenTokens` sees equal (empty) sets on both
 * sides too, silently exempting a genuine signature change. See issue #1740.
 */
function signatureEndLine(db: BetterSqlite3Database, defId: number, defLine: number): number {
  const row = db
    .prepare(
      `SELECT MAX(n.line) AS maxLine FROM nodes n
       JOIN edges e ON e.source_id = n.id
       WHERE e.kind = 'parameter_of' AND e.target_id = ?`,
    )
    .get(defId) as { maxLine: number | null };
  return Math.max(defLine, row.maxLine ?? defLine);
}

/**
 * Returns true if the diff altered `def`'s call graph shape: an overlapping
 * edit touches the declaration — anywhere from its own line through the end
 * of its parameter list, per `sigEndLine` (signature/name risk — existing
 * callers may need to change) — or changes the set of paren-preceded tokens
 * referenced in its body (call-target risk — a callee was added, removed, or
 * swapped). A range that overlaps the def but has no matching entry in
 * `edits` (e.g. hand-built ranges in tests, or any future caller that only
 * has range data) is conservatively treated as shape-changed — missing data
 * must never silently exempt a def.
 */
function callGraphShapeChanged(
  defLine: number,
  sigEndLine: number,
  endLine: number,
  ranges: DiffRange[],
  edits: DiffTextEdit[],
): boolean {
  for (const range of ranges) {
    if (range.start > endLine || range.end < defLine) continue;
    if (range.start <= sigEndLine && range.end >= defLine) return true;
    const edit = edits.find((e) => e.start === range.start && e.end === range.end);
    if (!edit) return true;
    if (!sameTokenSet(parenTokens(edit.removedText), parenTokens(edit.addedText))) return true;
  }
  return false;
}

export function checkMaxBlastRadius(
  db: BetterSqlite3Database,
  changedRanges: Map<string, DiffRange[]>,
  changedEdits: Map<string, DiffTextEdit[]>,
  threshold: number,
  noTests: boolean,
  maxDepth: number,
): BlastRadiusResult {
  const violations: BlastRadiusViolation[] = [];
  let maxFound = 0;
  let exemptedCount = 0;
  const defsStmt = db.prepare(
    `SELECT * FROM nodes WHERE file = ? AND kind IN ('function', 'method', 'class') ORDER BY line`,
  );

  for (const [file, ranges] of changedRanges) {
    if (noTests && isTestFile(file)) continue;
    const defs = defsStmt.all(file) as DefRow[];
    const edits = changedEdits.get(file) ?? [];

    for (let i = 0; i < defs.length; i++) {
      const def = defs[i]!;
      const endLine = defEndLine(def, defs[i + 1]);
      if (!rangesOverlap(def.line, endLine, ranges)) continue;

      // The diff touched this def, but not its call graph shape — its
      // absolute caller count is pre-existing risk, not risk this diff
      // introduced. Skip the (potentially expensive) BFS entirely.
      const sigEndLine = signatureEndLine(db, def.id, def.line);
      if (!callGraphShapeChanged(def.line, sigEndLine, endLine, ranges, edits)) {
        exemptedCount++;
        continue;
      }

      const { totalDependents: totalCallers } = bfsTransitiveCallers(db, def.id, {
        noTests,
        maxDepth,
      });

      if (totalCallers > maxFound) maxFound = totalCallers;
      if (totalCallers > threshold) {
        violations.push({
          name: def.name,
          kind: def.kind,
          file: def.file,
          line: def.line,
          transitiveCallers: totalCallers,
        });
      }
    }
  }

  const result: BlastRadiusResult = {
    passed: violations.length === 0,
    maxFound,
    threshold,
    violations,
    exemptedCount,
  };
  if (exemptedCount > 0) {
    result.note = `${exemptedCount} touched function(s) exempted — no call graph shape change detected (pre-existing fan-in, not new risk introduced by this diff)`;
  }
  return result;
}

interface ConsumerRef {
  name: string;
  file: string;
  line: number;
}

interface SignatureViolation {
  name: string;
  kind: string;
  file: string;
  line: number;
  /** Present only for violations from `checkNoDeletedExportsInUse` — see #1806. */
  reason?: 'file-deleted';
  /** External (cross-file) consumers found for a deleted export — only set when `reason === 'file-deleted'`. */
  consumers?: ConsumerRef[];
}

interface SignatureResult {
  passed: boolean;
  violations: SignatureViolation[];
}

/**
 * `db` reflects the current working-tree (post-change) file content, so
 * `nodes.line` values are in new-file coordinates. `changedRanges` must be
 * in the same coordinate space — i.e. `diff.changedRanges`, not
 * `diff.oldRanges` (which is pre-change/old-file and would only line up
 * with `db` by coincidence once a hunk changes the file's total line
 * count). See issues #1732 and #1737.
 */
export function checkNoSignatureChanges(
  db: BetterSqlite3Database,
  changedRanges: Map<string, DiffRange[]>,
  noTests: boolean,
): SignatureResult {
  const violations: SignatureViolation[] = [];

  for (const [file, ranges] of changedRanges) {
    if (ranges.length === 0) continue;
    if (noTests && isTestFile(file)) continue;

    // Scoped to `exported = 1`: only a symbol reachable from outside its own
    // file can have callers this diff doesn't already account for. A
    // private, file-local helper's declaration can be freely deleted,
    // renamed, or reshaped — every call site lives in the same file and is
    // necessarily part of the same diff. Without this filter, any adoption
    // of a shared helper that removes a file-local duplicate (the exact
    // pattern the grind workflow performs) would always trip this check.
    const defs = db
      .prepare(
        `SELECT name, kind, file, line FROM nodes WHERE file = ? AND kind IN ('function', 'method', 'class') AND exported = 1 ORDER BY line`,
      )
      .all(file) as SignatureViolation[];

    for (const def of defs) {
      for (const range of ranges) {
        if (def.line >= range.start && def.line <= range.end) {
          violations.push({
            name: def.name,
            kind: def.kind,
            file: def.file,
            line: def.line,
          });
          break;
        }
      }
    }
  }

  return { passed: violations.length === 0, violations };
}

/**
 * Detects exported functions/methods/classes lost when a file is deleted in
 * its entirety, for deletions whose exports still have consumers elsewhere
 * in the codebase.
 *
 * `checkNoSignatureChanges` can never see this case: a fully deleted file
 * never gets a `changedRanges` entry (there is no new-side content to track
 * — see `parseDiffOutput`'s `+++ /dev/null` handling), and its `nodes` rows
 * are purged by the very next `codegraph build`/incremental rebuild
 * (`DELETE FROM nodes WHERE file = ?`, run unconditionally for any file
 * `detectChanges` no longer finds on disk — see
 * `domain/graph/builder/stages/detect-changes.ts`). `checkData` itself never
 * triggers a rebuild — it only opens the DB read-only — so whether this
 * predicate can see a deleted file's exports depends entirely on whether
 * some *other*, separate `codegraph build` invocation has already purged it
 * by the time `check` runs.
 *
 * For a file whose `nodes` rows are still live (no rebuild has purged it
 * yet), this queries them directly. Once a rebuild purges them, it falls
 * back to `deleted_export_advisories` — a durable snapshot the build
 * pipeline captures at the exact point it computes the removed-file set,
 * BEFORE purging (see `recordDeletedExportAdvisories` /
 * `db/repository/deleted-export-advisories.ts`) — so the violation stays
 * visible regardless of build/check invocation order (#1938).
 *
 * Unlike `checkNoSignatureChanges` (which flags any touched exported
 * declaration regardless of caller count, since editing an exported line is
 * inherently risky), this predicate only flags a deleted export when it has
 * a real consumer OUTSIDE the deleted file — reusing the same
 * cross-file-consumer shape as `domain/analysis/exports.ts` /
 * `features/structure.ts` (`calls`/`imports-type` edges whose source file
 * differs from the target's file). Deleting a file whose exports are never
 * imported elsewhere is a legitimate, safe cleanup and must not be flagged.
 *
 * Known limitation: a same-commit rename (delete `old.js` + add `new.js`
 * with equivalent exports, with callers updated to import from `new.js` in
 * the same diff) can false-positive here, because `db` only reflects
 * pre-change edges — it has no visibility into the staged content of the
 * files that will import from the new location. This mirrors an existing,
 * accepted trade-off in this predicate family (e.g. `checkMaxBlastRadius`'s
 * paren-less-call blind spot) rather than a new class of problem.
 */
export function checkNoDeletedExportsInUse(
  db: BetterSqlite3Database,
  deletedFiles: Set<string>,
  noTests: boolean,
): SignatureResult {
  const violations: SignatureViolation[] = [];
  if (deletedFiles.size === 0) return { passed: true, violations };

  for (const file of deletedFiles) {
    if (noTests && isTestFile(file)) continue;

    const defs = findExportedDefinitions(db, file);
    if (defs.length > 0) {
      for (const def of defs) {
        let consumers: ConsumerRef[] = findExternalConsumers(db, def.id, file);
        // A caller that is itself among the files this same diff deletes isn't
        // an external caller left dangling by the diff — it's being removed
        // too. Mirrors checkNoSignatureChanges's exported-only filter: only a
        // caller reachable from outside the set of files this diff removes can
        // be a caller the diff doesn't already account for.
        consumers = consumers.filter((c) => !deletedFiles.has(c.file));
        if (noTests) consumers = consumers.filter((c) => !isTestFile(c.file));
        if (consumers.length === 0) continue;

        violations.push({
          name: def.name,
          kind: def.kind,
          file,
          line: def.line,
          reason: 'file-deleted',
          consumers,
        });
      }
      continue;
    }

    // `nodes` rows for `file` are already gone — some rebuild purged them
    // before this check ran. Fall back to the pre-purge advisory snapshot.
    const advisories = getDeletedExportAdvisories(db, [file], deletedFiles);
    for (const advisory of advisories) {
      let consumers = advisory.consumers;
      if (noTests) consumers = consumers.filter((c) => !isTestFile(c.file));
      if (consumers.length === 0) continue;

      violations.push({
        name: advisory.name,
        kind: advisory.kind,
        file: advisory.file,
        line: advisory.line,
        reason: 'file-deleted',
        consumers,
      });
    }
  }

  return { passed: violations.length === 0, violations };
}

interface BoundaryViolation {
  from: string;
  to: string;
  edgeKind: string;
}

interface BoundaryResult {
  passed: boolean;
  violations: BoundaryViolation[];
  note?: string;
}

export function checkNoBoundaryViolations(
  db: BetterSqlite3Database,
  changedFiles: Set<string> | string[],
  repoRoot: string,
  noTests: boolean,
): BoundaryResult {
  const parsed = parseCodeowners(repoRoot);
  if (!parsed) {
    return { passed: true, violations: [], note: 'No CODEOWNERS file found — skipped' };
  }

  const changedSet = changedFiles instanceof Set ? changedFiles : new Set(changedFiles);
  const edges = db
    .prepare(
      `SELECT e.kind AS edgeKind,
              s.file AS srcFile, t.file AS tgtFile
       FROM edges e
       JOIN nodes s ON e.source_id = s.id
       JOIN nodes t ON e.target_id = t.id
       WHERE e.kind = 'calls'`,
    )
    .all() as Array<{ edgeKind: string; srcFile: string; tgtFile: string }>;

  const violations: BoundaryViolation[] = [];
  for (const e of edges) {
    if (noTests && (isTestFile(e.srcFile) || isTestFile(e.tgtFile))) continue;
    if (!changedSet.has(e.srcFile) && !changedSet.has(e.tgtFile)) continue;

    const srcOwners = matchOwners(e.srcFile, parsed.rules).sort().join(',');
    const tgtOwners = matchOwners(e.tgtFile, parsed.rules).sort().join(',');
    if (srcOwners !== tgtOwners) {
      violations.push({
        from: e.srcFile,
        to: e.tgtFile,
        edgeKind: e.edgeKind,
      });
    }
  }

  return { passed: violations.length === 0, violations };
}

// ─── Main ─────────────────────────────────────────────────────────────

interface PredicateResult {
  name: string;
  passed: boolean;
  [key: string]: unknown;
}

interface CheckSummary {
  total: number;
  passed: number;
  failed: number;
  changedFiles: number;
  newFiles: number;
  deletedFiles: number;
}

interface CheckResult {
  error?: string;
  predicates?: PredicateResult[];
  summary?: CheckSummary;
  passed?: boolean;
}

interface CheckOpts {
  ref?: string;
  staged?: boolean;
  cycles?: boolean;
  blastRadius?: number | null;
  signatures?: boolean;
  boundaries?: boolean;
  depth?: number;
  noTests?: boolean;
  config?: CodegraphConfig;
}

/** Walk up from repoRoot to find the nearest .git directory. */
function findGitRoot(repoRoot: string): string | null {
  let dir = repoRoot;
  while (dir) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Run git diff and return the raw output string. */
function getGitDiff(
  repoRoot: string,
  opts: { staged?: boolean; ref?: string },
  maxBuffer: number,
): string {
  const args = opts.staged
    ? ['diff', '--cached', '--unified=0', '--no-color']
    : ['diff', opts.ref || 'HEAD', '--unified=0', '--no-color'];
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Resolve which check predicates are enabled from opts + config. */
function resolveCheckFlags(opts: CheckOpts, config: CodegraphConfig) {
  const checkConfig = config.check || ({} as CodegraphConfig['check']);
  return {
    enableCycles: opts.cycles ?? checkConfig.cycles ?? true,
    excludeSpeculativeCycles:
      checkConfig.excludeSpeculativeCycles ?? DEFAULTS.check.excludeSpeculativeCycles,
    enableSignatures: opts.signatures ?? checkConfig.signatures ?? true,
    enableBoundaries: opts.boundaries ?? checkConfig.boundaries ?? true,
    blastRadiusThreshold: opts.blastRadius ?? checkConfig.blastRadius ?? null,
  };
}

/** Run all enabled check predicates and return the results. */
function runPredicates(
  db: BetterSqlite3Database,
  diff: ParsedDiff,
  flags: ReturnType<typeof resolveCheckFlags>,
  repoRoot: string,
  noTests: boolean,
  maxDepth: number,
): PredicateResult[] {
  const changedFiles = new Set(diff.changedRanges.keys());
  const predicates: PredicateResult[] = [];

  if (flags.enableCycles) {
    predicates.push({
      name: 'cycles',
      ...checkNoNewCycles(db, changedFiles, noTests, flags.excludeSpeculativeCycles),
    });
  }
  if (flags.blastRadiusThreshold != null) {
    predicates.push({
      name: 'blast-radius',
      ...checkMaxBlastRadius(
        db,
        diff.changedRanges,
        diff.changedEdits,
        flags.blastRadiusThreshold,
        noTests,
        maxDepth,
      ),
    });
  }
  if (flags.enableSignatures) {
    // Both predicates report under the single 'signatures' name: they are
    // two detection strategies for the same class of risk (an exported
    // declaration this diff makes unreachable to its existing callers) —
    // checkNoSignatureChanges for declarations edited in place,
    // checkNoDeletedExportsInUse for declarations lost via full-file
    // deletion (#1806). Merging keeps both gated by the same --signatures
    // flag/config and lets existing consumers of the 'signatures' predicate
    // (the pre-commit hook, `codegraph check --json`) pick up the new
    // violations with no wiring changes.
    const editedResult = checkNoSignatureChanges(db, diff.changedRanges, noTests);
    const deletedResult = checkNoDeletedExportsInUse(db, diff.deletedFiles, noTests);
    predicates.push({
      name: 'signatures',
      passed: editedResult.passed && deletedResult.passed,
      violations: [...editedResult.violations, ...deletedResult.violations],
    });
  }
  if (flags.enableBoundaries) {
    predicates.push({
      name: 'boundaries',
      ...checkNoBoundaryViolations(db, changedFiles, repoRoot, noTests),
    });
  }

  return predicates;
}

function makeEmptyCheck(): CheckResult {
  return {
    predicates: [],
    summary: { total: 0, passed: 0, failed: 0, changedFiles: 0, newFiles: 0, deletedFiles: 0 },
    passed: true,
  };
}

export function checkData(customDbPath: string | undefined, opts: CheckOpts = {}): CheckResult {
  // Resolve repoRoot + config before opening the DB so config.db.busyTimeoutMs
  // can be threaded through to openReadonlyOrFail() (mirrors resolveDbSettings()'s
  // ordering in db/connection.ts — loadConfig can throw, and an already-open
  // handle at that point would never be closed). repoRoot only depends on
  // findDbPath(), not on the DB actually existing, so this reorder is safe.
  const dbPath = findDbPath(customDbPath);
  const repoRoot = path.resolve(path.dirname(dbPath), '..');
  const config = opts.config || loadConfig(repoRoot);
  const db = openReadonlyOrFail(
    customDbPath,
    config.db?.busyTimeoutMs ?? DEFAULTS.db.busyTimeoutMs,
  );

  try {
    const noTests = opts.noTests || false;
    const maxDepth = opts.depth || 3;

    const flags = resolveCheckFlags(opts, config);

    const gitRoot = findGitRoot(repoRoot);
    if (!gitRoot) {
      return { error: `Not a git repository: ${repoRoot}` };
    }

    let diffOutput: string;
    try {
      diffOutput = getGitDiff(repoRoot, opts, config.check.execMaxBufferBytes);
    } catch (e) {
      return { error: `Failed to run git diff: ${(e as Error).message}` };
    }

    if (!diffOutput.trim()) return makeEmptyCheck();

    const diff = parseDiffOutput(diffOutput);
    // A delete-only diff (e.g. `git rm` with no other staged changes) never
    // populates changedRanges — see parseDiffOutput's `+++ /dev/null`
    // handling — but must still run the predicates below (specifically
    // checkNoDeletedExportsInUse) rather than short-circuiting to "no
    // changes" (#1806).
    if (diff.changedRanges.size === 0 && diff.deletedFiles.size === 0) return makeEmptyCheck();

    const predicates = runPredicates(db, diff, flags, repoRoot, noTests, maxDepth);

    const passedCount = predicates.filter((p) => p.passed).length;
    const failedCount = predicates.length - passedCount;

    return {
      predicates,
      summary: {
        total: predicates.length,
        passed: passedCount,
        failed: failedCount,
        changedFiles: diff.changedRanges.size,
        newFiles: diff.newFiles.size,
        deletedFiles: diff.deletedFiles.size,
      },
      passed: failedCount === 0,
    };
  } finally {
    db.close();
  }
}
