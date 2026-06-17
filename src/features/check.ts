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

function pushHunkRanges(
  line: string,
  currentFile: string,
  changedRanges: Map<string, DiffRange[]>,
  oldRanges: Map<string, DiffRange[]>,
): void {
  const hunkMatch = line.match(HUNK_RE);
  if (!hunkMatch) return;
  const oldStart = parseInt(hunkMatch[1]!, 10);
  const oldCount = parseInt(hunkMatch[2] || '1', 10);
  if (oldCount > 0) {
    oldRanges.get(currentFile)!.push({ start: oldStart, end: oldStart + oldCount - 1 });
  }
  const newStart = parseInt(hunkMatch[3]!, 10);
  const newCount = parseInt(hunkMatch[4] || '1', 10);
  if (newCount > 0) {
    changedRanges.get(currentFile)!.push({ start: newStart, end: newStart + newCount - 1 });
  }
}

export function parseDiffOutput(diffOutput: string): ParsedDiff {
  const changedRanges = new Map<string, DiffRange[]>();
  const oldRanges = new Map<string, DiffRange[]>();
  const newFiles = new Set<string>();
  let currentFile: string | null = null;
  let prevIsDevNull = false;

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
      currentFile = newFile;
      if (!changedRanges.has(currentFile)) changedRanges.set(currentFile, []);
      if (!oldRanges.has(currentFile)) oldRanges.set(currentFile, []);
      if (prevIsDevNull) newFiles.add(currentFile);
      prevIsDevNull = false;
      continue;
    }
    if (currentFile) pushHunkRanges(line, currentFile, changedRanges, oldRanges);
  }
  return { changedRanges, oldRanges, newFiles };
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

export function checkMaxBlastRadius(
  db: BetterSqlite3Database,
  changedRanges: Map<string, DiffRange[]>,
  threshold: number,
  noTests: boolean,
  maxDepth: number,
): BlastRadiusResult {
  const violations: BlastRadiusViolation[] = [];
  let maxFound = 0;
  const defsStmt = db.prepare(
    `SELECT * FROM nodes WHERE file = ? AND kind IN ('function', 'method', 'class') ORDER BY line`,
  );

  for (const [file, ranges] of changedRanges) {
    if (noTests && isTestFile(file)) continue;
    const defs = defsStmt.all(file) as DefRow[];

    for (let i = 0; i < defs.length; i++) {
      const def = defs[i]!;
      const endLine = defEndLine(def, defs[i + 1]);
      if (!rangesOverlap(def.line, endLine, ranges)) continue;

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

  return { passed: violations.length === 0, maxFound, threshold, violations };
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

export function checkNoSignatureChanges(
  db: BetterSqlite3Database,
  oldRanges: Map<string, DiffRange[]>,
  noTests: boolean,
): SignatureResult {
  const violations: SignatureViolation[] = [];

  for (const [file, ranges] of oldRanges) {
    if (ranges.length === 0) continue;
    if (noTests && isTestFile(file)) continue;

    const defs = db
      .prepare(
        `SELECT name, kind, file, line FROM nodes WHERE file = ? AND kind IN ('function', 'method', 'class') ORDER BY line`,
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
function getGitDiff(repoRoot: string, opts: { staged?: boolean; ref?: string }): string {
  const args = opts.staged
    ? ['diff', '--cached', '--unified=0', '--no-color']
    : ['diff', opts.ref || 'HEAD', '--unified=0', '--no-color'];
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
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
      ...checkMaxBlastRadius(db, diff.changedRanges, flags.blastRadiusThreshold, noTests, maxDepth),
    });
  }
  if (flags.enableSignatures) {
    predicates.push({
      name: 'signatures',
      ...checkNoSignatureChanges(db, diff.oldRanges, noTests),
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
      diffOutput = getGitDiff(repoRoot, opts);
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
