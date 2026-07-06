/**
 * Git co-change analysis — surfaces files that historically change together.
 *
 * Uses git log to find temporal coupling between files, computes Jaccard
 * similarity coefficients, and stores results in the codegraph database.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  closeDb,
  findDbPath,
  initSchema,
  openDb,
  openReadonlyOrFail,
  resolveBusyTimeoutMs,
} from '../db/index.js';
import { DEFAULTS } from '../infrastructure/config.js';
import { debug, warn } from '../infrastructure/logger.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import { normalizePath } from '../shared/constants.js';
import { paginateResult } from '../shared/paginate.js';
import type { BetterSqlite3Database } from '../types.js';

interface CommitEntry {
  sha: string;
  epoch: number;
  files: string[];
}

interface CoChangePair {
  commitCount: number;
  jaccard: number;
  lastEpoch: number;
}

interface CoChangeMeta {
  analyzedAt: string | null;
  since: string | null;
  minSupport: number | null;
  lastCommit: string | null;
}

/** Build the `git log` argv for scanning co-change history. */
function buildGitLogArgs(opts: { since?: string; afterSha?: string | null }): string[] {
  const args = [
    'log',
    '--name-only',
    '--pretty=format:%H%n%at',
    '--no-merges',
    '--diff-filter=AMRC',
  ];
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.afterSha) args.push(`${opts.afterSha}..HEAD`);
  args.push('--', '.');
  return args;
}

/** Parse `git log --name-only --pretty=format:%H%n%at` output into commit entries. */
function parseGitLogOutput(output: string): CommitEntry[] {
  const commits: CommitEntry[] = [];
  // Split on double newlines to get blocks; each block is sha\nepoch\nfile1\nfile2...
  const blocks = output.trim().split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.length > 0);
    if (lines.length < 2) continue;
    const sha = lines[0]!;
    const epoch = parseInt(lines[1]!, 10);
    if (Number.isNaN(epoch)) continue;
    const files = lines.slice(2).map((f) => normalizePath(f));
    if (files.length > 0) {
      commits.push({ sha, epoch, files });
    }
  }
  return commits;
}

export function scanGitHistory(
  repoRoot: string,
  opts: { since?: string; afterSha?: string | null } = {},
): { commits: CommitEntry[] } {
  let output: string;
  try {
    output = execFileSync('git', buildGitLogArgs(opts), {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: DEFAULTS.coChange.execMaxBufferBytes,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: unknown) {
    warn(`Failed to scan git history: ${(e as Error).message}`);
    return { commits: [] };
  }

  if (!output.trim()) return { commits: [] };

  return { commits: parseGitLogOutput(output) };
}

/** Pass 1: bump the per-file commit count for every file in a (filtered) commit. */
function updateFileCommitCounts(files: string[], fileCommitCounts: Map<string, number>): void {
  for (const f of files) {
    fileCommitCounts.set(f, (fileCommitCounts.get(f) || 0) + 1);
  }
}

/** Pass 2: generate all unique file pairs for a commit (canonical: a < b) and tally them. */
function updatePairCounts(
  files: string[],
  epoch: number,
  pairCounts: Map<string, number>,
  pairLastEpoch: Map<string, number>,
): void {
  const sorted = [...new Set(files)].sort();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const key = `${sorted[i]}\0${sorted[j]}`;
      pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      const prev = pairLastEpoch.get(key) || 0;
      if (epoch > prev) pairLastEpoch.set(key, epoch);
    }
  }
}

/** Pass 3: filter pairs by minSupport and compute their Jaccard similarity. */
function buildCoChangeResults(
  pairCounts: Map<string, number>,
  pairLastEpoch: Map<string, number>,
  fileCommitCounts: Map<string, number>,
  minSupport: number,
): Map<string, CoChangePair> {
  const results = new Map<string, CoChangePair>();
  for (const [key, count] of pairCounts) {
    if (count < minSupport) continue;
    const [fileA, fileB] = key.split('\0') as [string, string];
    const countA = fileCommitCounts.get(fileA) || 0;
    const countB = fileCommitCounts.get(fileB) || 0;
    const jaccard = count / (countA + countB - count);
    results.set(key, {
      commitCount: count,
      jaccard,
      lastEpoch: pairLastEpoch.get(key) || 0,
    });
  }
  return results;
}

export function computeCoChanges(
  commits: CommitEntry[],
  opts: { minSupport?: number; maxFilesPerCommit?: number; knownFiles?: Set<string> | null } = {},
): { pairs: Map<string, CoChangePair>; fileCommitCounts: Map<string, number> } {
  const minSupport = opts.minSupport ?? DEFAULTS.coChange.minSupport;
  const maxFilesPerCommit = opts.maxFilesPerCommit ?? DEFAULTS.coChange.maxFilesPerCommit;
  const knownFiles = opts.knownFiles || null;

  const fileCommitCounts = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  const pairLastEpoch = new Map<string, number>();

  for (const commit of commits) {
    let { files } = commit;
    if (files.length > maxFilesPerCommit) continue;

    if (knownFiles) {
      files = files.filter((f) => knownFiles.has(f));
    }

    updateFileCommitCounts(files, fileCommitCounts);
    updatePairCounts(files, commit.epoch, pairCounts, pairLastEpoch);
  }

  return {
    pairs: buildCoChangeResults(pairCounts, pairLastEpoch, fileCommitCounts, minSupport),
    fileCommitCounts,
  };
}

/** Read the SHA of the most recently analyzed commit (incremental state). */
function loadLastAnalyzedSha(db: BetterSqlite3Database): string | null {
  try {
    const row = db
      .prepare<{ value: string }>(
        "SELECT value FROM co_change_meta WHERE key = 'last_analyzed_commit'",
      )
      .get();
    return row ? row.value : null;
  } catch (e: unknown) {
    debug(`loadLastAnalyzedSha: co_change_meta table may not exist yet: ${(e as Error).message}`);
    return null;
  }
}

/** Wipe all co-change tables for a full re-scan. */
function clearCoChangeTables(db: BetterSqlite3Database): void {
  db.exec('DELETE FROM co_changes');
  db.exec('DELETE FROM co_change_meta');
  db.exec('DELETE FROM file_commit_counts');
}

/** Collect the set of files currently tracked by the graph for filtering. */
function loadKnownFiles(db: BetterSqlite3Database): Set<string> | null {
  try {
    const rows = db.prepare<{ file: string }>('SELECT DISTINCT file FROM nodes').all();
    return new Set(rows.map((r) => r.file));
  } catch (e: unknown) {
    debug(`loadKnownFiles: nodes table may not exist: ${(e as Error).message}`);
    return null;
  }
}

/** Upsert per-file commit counts and pair counts (Jaccard recomputed later). */
function persistCoChangeResults(
  db: BetterSqlite3Database,
  fileCommitCounts: Map<string, number>,
  coChanges: Map<string, CoChangePair>,
): void {
  const fileCountUpsert = db.prepare(`
    INSERT INTO file_commit_counts (file, commit_count) VALUES (?, ?)
    ON CONFLICT(file) DO UPDATE SET commit_count = commit_count + excluded.commit_count
  `);

  const pairUpsert = db.prepare(`
    INSERT INTO co_changes (file_a, file_b, commit_count, jaccard, last_commit_epoch)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(file_a, file_b) DO UPDATE SET
      commit_count = commit_count + excluded.commit_count,
      last_commit_epoch = MAX(co_changes.last_commit_epoch, excluded.last_commit_epoch)
  `);

  const insertMany = db.transaction(() => {
    for (const [file, count] of fileCommitCounts) {
      fileCountUpsert.run(file, count);
    }
    for (const [key, data] of coChanges) {
      const [fileA, fileB] = key.split('\0') as [string, string];
      pairUpsert.run(fileA, fileB, data.commitCount, data.lastEpoch);
    }
  });
  insertMany();
}

/** Recompute Jaccard for every pair touching any file in `affectedFiles`. */
function recomputeJaccardForAffected(db: BetterSqlite3Database, affectedFiles: string[]): void {
  if (affectedFiles.length === 0) return;
  const ph = affectedFiles.map(() => '?').join(',');
  db.prepare(`
    UPDATE co_changes SET jaccard = (
      SELECT CAST(co_changes.commit_count AS REAL) / (
        COALESCE(fa.commit_count, 0) + COALESCE(fb.commit_count, 0) - co_changes.commit_count
      )
      FROM file_commit_counts fa, file_commit_counts fb
      WHERE fa.file = co_changes.file_a AND fb.file = co_changes.file_b
    )
    WHERE file_a IN (${ph}) OR file_b IN (${ph})
  `).run(...affectedFiles, ...affectedFiles);
}

/** Update co_change_meta with the latest analyzer run parameters. */
function updateCoChangeMeta(
  db: BetterSqlite3Database,
  commits: CommitEntry[],
  since: string,
  minSupport: number,
): void {
  const metaUpsert = db.prepare(`
    INSERT INTO co_change_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  if (commits.length > 0) {
    metaUpsert.run('last_analyzed_commit', commits[0]!.sha);
  }
  metaUpsert.run('analyzed_at', new Date().toISOString());
  metaUpsert.run('since', since);
  metaUpsert.run('min_support', String(minSupport));
}

interface CoChangeAnalysisOptions {
  since: string;
  minSupport: number;
  maxFilesPerCommit: number;
}

/** Resolve since/minSupport/maxFilesPerCommit from opts, falling back to DEFAULTS.coChange. */
function resolveCoChangeAnalysisOptions(opts: {
  since?: string;
  minSupport?: number;
  maxFilesPerCommit?: number;
}): CoChangeAnalysisOptions {
  return {
    since: opts.since || DEFAULTS.coChange.since,
    minSupport: opts.minSupport ?? DEFAULTS.coChange.minSupport,
    maxFilesPerCommit: opts.maxFilesPerCommit ?? DEFAULTS.coChange.maxFilesPerCommit,
  };
}

/** Scan git history, compute co-change pairs, and persist them + the run metadata. */
function runCoChangeScanAndPersist(
  db: BetterSqlite3Database,
  repoRoot: string,
  afterSha: string | null,
  resolved: CoChangeAnalysisOptions,
): CommitEntry[] {
  const knownFiles = loadKnownFiles(db);
  const { commits } = scanGitHistory(repoRoot, { since: resolved.since, afterSha });
  const { pairs: coChanges, fileCommitCounts } = computeCoChanges(commits, {
    minSupport: resolved.minSupport,
    maxFilesPerCommit: resolved.maxFilesPerCommit,
    knownFiles,
  });

  persistCoChangeResults(db, fileCommitCounts, coChanges);
  recomputeJaccardForAffected(db, [...fileCommitCounts.keys()]);
  updateCoChangeMeta(db, commits, resolved.since, resolved.minSupport);

  return commits;
}

export function analyzeCoChanges(
  customDbPath?: string,
  opts: {
    since?: string;
    minSupport?: number;
    maxFilesPerCommit?: number;
    full?: boolean;
  } = {},
):
  | { pairsFound: number; commitsScanned: number; since: string; minSupport: number }
  | { error: string } {
  const dbPath = findDbPath(customDbPath);
  const db = openDb(dbPath);
  initSchema(db);

  const repoRoot = path.resolve(path.dirname(dbPath), '..');

  if (!fs.existsSync(path.join(repoRoot, '.git'))) {
    closeDb(db);
    return { error: `Not a git repository: ${repoRoot}` };
  }

  const resolved = resolveCoChangeAnalysisOptions(opts);
  const afterSha = opts.full ? null : loadLastAnalyzedSha(db);
  if (opts.full) clearCoChangeTables(db);

  const commits = runCoChangeScanAndPersist(db, repoRoot, afterSha, resolved);

  const totalPairs = db
    .prepare<{ cnt: number }>('SELECT COUNT(*) as cnt FROM co_changes')
    .get()!.cnt;

  closeDb(db);

  return {
    pairsFound: totalPairs,
    commitsScanned: commits.length,
    since: resolved.since,
    minSupport: resolved.minSupport,
  };
}

interface CoChangeRow {
  file_a: string;
  file_b: string;
  commit_count: number;
  jaccard: number;
  last_commit_epoch: number;
}

/** True if the `co_changes` table exists (i.e. `analyzeCoChanges` has run at least once). */
function hasCoChangeTable(db: BetterSqlite3Database): boolean {
  try {
    db.prepare('SELECT 1 FROM co_changes LIMIT 1').get();
    return true;
  } catch (e: unknown) {
    debug(`hasCoChangeTable: co_changes table missing: ${(e as Error).message}`);
    return false;
  }
}

/** Format a last-commit epoch (seconds) as `YYYY-MM-DD`, or null if absent. */
function epochToDateString(epoch: number): string | null {
  return epoch ? new Date(epoch * 1000).toISOString().slice(0, 10) : null;
}

/** Shape+filter co-change rows into the public per-file "partners" list. */
function buildCoChangePartners(
  rows: CoChangeRow[],
  resolvedFile: string,
  noTests: boolean,
  limit: number,
): Array<{ file: string; commitCount: number; jaccard: number; lastCommitDate: string | null }> {
  const partners: Array<{
    file: string;
    commitCount: number;
    jaccard: number;
    lastCommitDate: string | null;
  }> = [];
  for (const row of rows) {
    const partner = row.file_a === resolvedFile ? row.file_b : row.file_a;
    if (noTests && isTestFile(partner)) continue;
    partners.push({
      file: partner,
      commitCount: row.commit_count,
      jaccard: row.jaccard,
      lastCommitDate: epochToDateString(row.last_commit_epoch),
    });
    if (partners.length >= limit) break;
  }
  return partners;
}

export function coChangeData(
  file: string,
  customDbPath?: string,
  opts: { limit?: number; minJaccard?: number; noTests?: boolean; offset?: number } = {},
): Record<string, unknown> {
  const db = openReadonlyOrFail(customDbPath, resolveBusyTimeoutMs(customDbPath));
  const limit = opts.limit || 20;
  const minJaccard = opts.minJaccard ?? DEFAULTS.coChange.minJaccard;
  const noTests = opts.noTests || false;

  if (!hasCoChangeTable(db)) {
    closeDb(db);
    return { error: 'No co-change data found. Run `codegraph co-change --analyze` first.' };
  }

  // Resolve file via partial match
  const resolvedFile = resolveCoChangeFile(db, file);
  if (!resolvedFile) {
    closeDb(db);
    return { error: `No co-change data found for file matching "${file}"` };
  }

  const rows = db
    .prepare<CoChangeRow>(
      `SELECT file_a, file_b, commit_count, jaccard, last_commit_epoch
       FROM co_changes
       WHERE (file_a = ? OR file_b = ?) AND jaccard >= ?
       ORDER BY jaccard DESC`,
    )
    .all(resolvedFile, resolvedFile, minJaccard);

  const partners = buildCoChangePartners(rows, resolvedFile, noTests, limit);

  const meta = getCoChangeMeta(db);
  closeDb(db);

  const base = { file: resolvedFile, partners, meta };
  return paginateResult(base, 'partners', { limit: opts.limit, offset: opts.offset });
}

/** Shape+filter co-change rows into the public global "top pairs" list. */
function buildCoChangeTopPairs(
  rows: CoChangeRow[],
  noTests: boolean,
  limit: number,
): Array<{
  fileA: string;
  fileB: string;
  commitCount: number;
  jaccard: number;
  lastCommitDate: string | null;
}> {
  const pairs: Array<{
    fileA: string;
    fileB: string;
    commitCount: number;
    jaccard: number;
    lastCommitDate: string | null;
  }> = [];
  for (const row of rows) {
    if (noTests && (isTestFile(row.file_a) || isTestFile(row.file_b))) continue;
    pairs.push({
      fileA: row.file_a,
      fileB: row.file_b,
      commitCount: row.commit_count,
      jaccard: row.jaccard,
      lastCommitDate: epochToDateString(row.last_commit_epoch),
    });
    if (pairs.length >= limit) break;
  }
  return pairs;
}

export function coChangeTopData(
  customDbPath?: string,
  opts: { limit?: number; minJaccard?: number; noTests?: boolean; offset?: number } = {},
): Record<string, unknown> {
  const db = openReadonlyOrFail(customDbPath, resolveBusyTimeoutMs(customDbPath));
  const limit = opts.limit || 20;
  const minJaccard = opts.minJaccard ?? DEFAULTS.coChange.minJaccard;
  const noTests = opts.noTests || false;

  if (!hasCoChangeTable(db)) {
    closeDb(db);
    return { error: 'No co-change data found. Run `codegraph co-change --analyze` first.' };
  }

  const rows = db
    .prepare<CoChangeRow>(
      `SELECT file_a, file_b, commit_count, jaccard, last_commit_epoch
       FROM co_changes
       WHERE jaccard >= ?
       ORDER BY jaccard DESC`,
    )
    .all(minJaccard);

  const pairs = buildCoChangeTopPairs(rows, noTests, limit);

  const meta = getCoChangeMeta(db);
  closeDb(db);

  const base = { pairs, meta };
  return paginateResult(base, 'pairs', { limit: opts.limit, offset: opts.offset });
}

/** Shape+filter co-change rows into the public "coupled with an input file" list. */
function buildCoChangeForFilesResults(
  rows: Array<{ file_a: string; file_b: string; commit_count: number; jaccard: number }>,
  inputSet: Set<string>,
  noTests: boolean,
): Array<{ file: string; coupledWith: string; commitCount: number; jaccard: number }> {
  const results: Array<{
    file: string;
    coupledWith: string;
    commitCount: number;
    jaccard: number;
  }> = [];
  for (const row of rows) {
    const partner = inputSet.has(row.file_a) ? row.file_b : row.file_a;
    const source = inputSet.has(row.file_a) ? row.file_a : row.file_b;
    if (inputSet.has(partner)) continue;
    if (noTests && isTestFile(partner)) continue;
    results.push({
      file: partner,
      coupledWith: source,
      commitCount: row.commit_count,
      jaccard: row.jaccard,
    });
  }
  return results;
}

export function coChangeForFiles(
  files: string[],
  db: BetterSqlite3Database,
  opts: { minJaccard?: number; limit?: number; noTests?: boolean } = {},
): Array<{ file: string; coupledWith: string; commitCount: number; jaccard: number }> {
  const minJaccard = opts.minJaccard ?? DEFAULTS.coChange.minJaccard;
  const limit = opts.limit ?? 20;
  const noTests = opts.noTests || false;
  const inputSet = new Set(files);

  if (files.length === 0) return [];

  const placeholders = files.map(() => '?').join(',');
  const rows = db
    .prepare<{ file_a: string; file_b: string; commit_count: number; jaccard: number }>(
      `SELECT file_a, file_b, commit_count, jaccard
       FROM co_changes
       WHERE (file_a IN (${placeholders}) OR file_b IN (${placeholders}))
         AND jaccard >= ?
       ORDER BY jaccard DESC
       LIMIT ?`,
    )
    .all(...files, ...files, minJaccard, limit);

  return buildCoChangeForFilesResults(rows, inputSet, noTests);
}

// ─── Internal Helpers ────────────────────────────────────────────────────

function resolveCoChangeFile(db: BetterSqlite3Database, file: string): string | null {
  // Exact match first
  const exact = db
    .prepare<{ file_a: string }>(
      'SELECT file_a FROM co_changes WHERE file_a = ? UNION SELECT file_b FROM co_changes WHERE file_b = ? LIMIT 1',
    )
    .get(file, file);
  if (exact) return exact.file_a;

  // Partial match (ends with)
  const partial = db
    .prepare<{ file: string }>(
      `SELECT file_a AS file FROM co_changes WHERE file_a LIKE ?
       UNION
       SELECT file_b AS file FROM co_changes WHERE file_b LIKE ?
       LIMIT 1`,
    )
    .get(`%${file}`, `%${file}`);
  if (partial) return partial.file;

  return null;
}

function getCoChangeMeta(db: BetterSqlite3Database): CoChangeMeta | null {
  try {
    const rows = db
      .prepare<{ key: string; value: string }>('SELECT key, value FROM co_change_meta')
      .all();
    const meta: Record<string, string> = {};
    for (const row of rows) {
      meta[row.key] = row.value;
    }
    return {
      analyzedAt: meta.analyzed_at || null,
      since: meta.since || null,
      minSupport: meta.min_support ? parseInt(meta.min_support, 10) : null,
      lastCommit: meta.last_analyzed_commit || null,
    };
  } catch {
    return null;
  }
}
