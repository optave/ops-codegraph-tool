import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findDbPath, openReadonlyOrFail } from '../db/index.js';
import { bfsTransitiveCallers } from '../domain/analysis/impact.js';
import { findCycles } from '../domain/graph/cycles.js';
import { loadConfig } from '../infrastructure/config.js';
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
}

/** An added-line run paired with whatever it replaced, for shape comparison. */
interface DiffTextEdit extends DiffRange {
  addedText: string[];
  removedText: string[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NEW_FILE_RE = /^\+\+\+ b\/(.+)/;

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

  startHunk(oldStart: number, newStart: number): void {
    this.oldLineCursor = oldStart;
    this.newLineCursor = newStart;
    this.pendingRemovedText = [];
  }

  /**
   * Consumes one hunk body line, advancing the old- and new-side cursors as
   * needed. Lines beginning with `--- `/`+++ ` (source-file headers) are
   * already filtered out by the caller before a line ever reaches here, so a
   * leading `-`/`+` unambiguously marks a removed/added line — even one
   * whose own content starts with dashes or pluses (e.g. removing a line of
   * literal text `-- foo`).
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
  let currentFile: string | null = null;
  let prevIsDevNull = false;
  const tracker = new DiffLineTracker();

  for (const line of diffOutput.split('\n')) {
    if (isDevNullSourceLine(line)) {
      prevIsDevNull = true;
      continue;
    }
    if (isSourceFileHeaderLine(line)) {
      prevIsDevNull = false;
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
      continue;
    }
    if (isDevNullTargetLine(line)) {
      // `+++ /dev/null` (file deletion) is not `b/`-prefixed, so
      // extractNewFileName returned null above and this line would otherwise
      // fall through to tracker.consume and be misread as an added source
      // line under whichever file preceded this one in the diff. Flush and
      // clear the file context instead — the deleted file's hunk body that
      // follows has no corresponding DB entry to check against anyway (its
      // nodes are purged from the graph), so there is nothing to track here.
      if (currentFile) tracker.flush(currentFile, oldRanges, changedRanges, changedEdits);
      currentFile = null;
      prevIsDevNull = false;
      continue;
    }
    if (!currentFile) continue;

    const hunkMatch = line.match(HUNK_RE);
    if (hunkMatch) {
      tracker.flush(currentFile, oldRanges, changedRanges, changedEdits);
      tracker.startHunk(parseInt(hunkMatch[1]!, 10), parseInt(hunkMatch[3]!, 10));
      continue;
    }

    tracker.consume(line, currentFile, oldRanges, changedRanges, changedEdits);
  }
  if (currentFile) tracker.flush(currentFile, oldRanges, changedRanges, changedEdits);

  return { changedRanges, oldRanges, newFiles, changedEdits };
}

// ─── Predicates ───────────────────────────────────────────────────────

interface CyclesResult {
  passed: boolean;
  cycles: string[][];
}

export function checkNoNewCycles(
  db: BetterSqlite3Database,
  changedFiles: Set<string>,
  noTests: boolean,
): CyclesResult {
  const cycles = findCycles(db, { fileLevel: true, noTests });
  const involved = cycles.filter((cycle) => cycle.some((f) => changedFiles.has(f)));
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

interface SignatureViolation {
  name: string;
  kind: string;
  file: string;
  line: number;
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
    predicates.push({ name: 'cycles', ...checkNoNewCycles(db, changedFiles, noTests) });
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
    predicates.push({
      name: 'signatures',
      ...checkNoSignatureChanges(db, diff.changedRanges, noTests),
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
    summary: { total: 0, passed: 0, failed: 0, changedFiles: 0, newFiles: 0 },
    passed: true,
  };
}

export function checkData(customDbPath: string | undefined, opts: CheckOpts = {}): CheckResult {
  const db = openReadonlyOrFail(customDbPath);

  try {
    const dbPath = findDbPath(customDbPath);
    const repoRoot = path.resolve(path.dirname(dbPath), '..');
    const noTests = opts.noTests || false;
    const maxDepth = opts.depth || 3;

    const config = opts.config || loadConfig(repoRoot);
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
    if (diff.changedRanges.size === 0) return makeEmptyCheck();

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
      },
      passed: failedCount === 0,
    };
  } finally {
    db.close();
  }
}
