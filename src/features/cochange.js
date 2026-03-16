/**
 * Git co-change analysis — surfaces files that historically change together.
 *
 * Uses git log to find temporal coupling between files, computes Jaccard
 * similarity coefficients, and stores results in the codegraph database.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { closeDb, findDbPath, initSchema, openDb, openReadonlyOrFail } from '../db/index.js';
import { warn } from '../infrastructure/logger.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import { normalizePath } from '../shared/constants.js';
import { paginateResult } from '../shared/paginate.js';

/**
 * Scan git history and return parsed commit data.
 * @param {string} repoRoot - Absolute path to the git repo root
 * @param {object} [opts]
 * @param {string} [opts.since] - Git date expression (e.g. "1 year ago")
 * @param {string} [opts.afterSha] - Only include commits after this SHA
 * @returns {{ commits: Array<{sha: string, epoch: number, files: string[]}> }}
 */
export function scanGitHistory(repoRoot, opts = {}) {
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

  let output;
  try {
    output = execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    warn(`Failed to scan git history: ${e.message}`);
    return { commits: [] };
  }

  if (!output.trim()) return { commits: [] };

  const commits = [];
  // Split on double newlines to get blocks; each block is sha\nepoch\nfile1\nfile2...
  const blocks = output.trim().split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.length > 0);
    if (lines.length < 2) continue;
    const sha = lines[0];
    const epoch = parseInt(lines[1], 10);
    if (Number.isNaN(epoch)) continue;
    const files = lines.slice(2).map((f) => normalizePath(f));
    if (files.length > 0) {
      commits.push({ sha, epoch, files });
    }
  }

  return { commits };
}

/**
 * Compute co-change pairs from parsed commit data.
 * @param {Array<{sha: string, epoch: number, files: string[]}>} commits
 * @param {object} [opts]
 * @param {number} [opts.minSupport=3] - Minimum number of co-occurrences
 * @param {number} [opts.maxFilesPerCommit=50] - Skip commits with too many files
 * @param {Set<string>} [opts.knownFiles] - If provided, only include pairs where both files are in this set
 * @returns {Map<string, {commitCount: number, jaccard: number, lastEpoch: number}>}
 */
export function computeCoChanges(commits, opts = {}) {
  const minSupport = opts.minSupport ?? 3;
  const maxFilesPerCommit = opts.maxFilesPerCommit ?? 50;
  const knownFiles = opts.knownFiles || null;

  const fileCommitCounts = new Map();
  const pairCounts = new Map();
  const pairLastEpoch = new Map();

  for (const commit of commits) {
    let { files } = commit;
    if (files.length > maxFilesPerCommit) continue;

    if (knownFiles) {
      files = files.filter((f) => knownFiles.has(f));
    }

    // Count per-file commits
    for (const f of files) {
      fileCommitCounts.set(f, (fileCommitCounts.get(f) || 0) + 1);
    }

    // Generate all unique pairs (canonical: a < b)
    const sorted = [...new Set(files)].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const key = `${sorted[i]}\0${sorted[j]}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
        const prev = pairLastEpoch.get(key) || 0;
        if (commit.epoch > prev) pairLastEpoch.set(key, commit.epoch);
      }
    }
  }

  // Filter by minSupport and compute Jaccard
  const results = new Map();
  for (const [key, count] of pairCounts) {
    if (count < minSupport) continue;
    const [fileA, fileB] = key.split('\0');
    const countA = fileCommitCounts.get(fileA) || 0;
    const countB = fileCommitCounts.get(fileB) || 0;
    const jaccard = count / (countA + countB - count);
    results.set(key, {
      commitCount: count,
      jaccard,
      lastEpoch: pairLastEpoch.get(key) || 0,
    });
  }

  return { pairs: results, fileCommitCounts };
}

/**
 * Analyze git history and populate co-change data in the database.
 * @param {string} [customDbPath] - Path to graph.db
 * @param {object} [opts]
 * @param {string} [opts.since] - Git date expression
 * @param {number} [opts.minSupport] - Minimum co-occurrence count
 * @param {number} [opts.maxFilesPerCommit] - Max files per commit
 * @param {boolean} [opts.full] - Force full re-scan
 * @returns {{ pairsFound: number, commitsScanned: number, since: string, minSupport: number }}
 */
export function analyzeCoChanges(customDbPath, opts = {}) {
  const dbPath = findDbPath(customDbPath);
  const db = openDb(dbPath);
  initSchema(db);

  const repoRoot = path.resolve(path.dirname(dbPath), '..');

  if (!fs.existsSync(path.join(repoRoot, '.git'))) {
    closeDb(db);
    return { error: `Not a git repository: ${repoRoot}` };
  }

  const since = opts.since || '1 year ago';
  const minSupport = opts.minSupport ?? 3;
  const maxFilesPerCommit = opts.maxFilesPerCommit ?? 50;

  // Check for incremental state
  let afterSha = null;
  if (!opts.full) {
    try {
      const row = db
        .prepare("SELECT value FROM co_change_meta WHERE key = 'last_analyzed_commit'")
        .get();
      if (row) afterSha = row.value;
    } catch {
      /* table may not exist yet */
    }
  }

  // If full re-scan, clear existing data
  if (opts.full) {
    db.exec('DELETE FROM co_changes');
    db.exec('DELETE FROM co_change_meta');
    db.exec('DELETE FROM file_commit_counts');
  }

  // Collect known files from the graph for filtering
  let knownFiles = null;
  try {
    const rows = db.prepare('SELECT DISTINCT file FROM nodes').all();
    knownFiles = new Set(rows.map((r) => r.file));
  } catch {
    /* nodes table may not exist */
  }

  const { commits } = scanGitHistory(repoRoot, { since, afterSha });
  const { pairs: coChanges, fileCommitCounts } = computeCoChanges(commits, {
    minSupport,
    maxFilesPerCommit,
    knownFiles,
  });

  // Upsert per-file commit counts so Jaccard can be recomputed from totals
  const fileCountUpsert = db.prepare(`
    INSERT INTO file_commit_counts (file, commit_count) VALUES (?, ?)
    ON CONFLICT(file) DO UPDATE SET commit_count = commit_count + excluded.commit_count
  `);

  // Upsert pair counts (accumulate commit_count, jaccard placeholder — recomputed below)
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
      const [fileA, fileB] = key.split('\0');
      pairUpsert.run(fileA, fileB, data.commitCount, data.lastEpoch);
    }
  });
  insertMany();

  // Recompute Jaccard for all affected pairs from total file commit counts
  const affectedFiles = [...fileCommitCounts.keys()];
  if (affectedFiles.length > 0) {
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

  // Update metadata
  const metaUpsert = db.prepare(`
    INSERT INTO co_change_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  if (commits.length > 0) {
    metaUpsert.run('last_analyzed_commit', commits[0].sha);
  }
  metaUpsert.run('analyzed_at', new Date().toISOString());
  metaUpsert.run('since', since);
  metaUpsert.run('min_support', String(minSupport));

  const totalPairs = db.prepare('SELECT COUNT(*) as cnt FROM co_changes').get().cnt;

  closeDb(db);

  return {
    pairsFound: totalPairs,
    commitsScanned: commits.length,
    since,
    minSupport,
  };
}

/**
 * Query co-change partners for a specific file.
 * @param {string} file - File path (partial match supported)
 * @param {string} [customDbPath]
 * @param {object} [opts]
 * @param {number} [opts.limit=20]
 * @param {number} [opts.minJaccard=0.3]
 * @param {boolean} [opts.noTests]
 * @returns {{ file: string, partners: Array, meta: object }}
 */
export function coChangeData(file, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const limit = opts.limit || 20;
  const minJaccard = opts.minJaccard ?? 0.3;
  const noTests = opts.noTests || false;

  // Check if co_changes table exists
  try {
    db.prepare('SELECT 1 FROM co_changes LIMIT 1').get();
  } catch {
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
    .prepare(
      `SELECT file_a, file_b, commit_count, jaccard, last_commit_epoch
       FROM co_changes
       WHERE (file_a = ? OR file_b = ?) AND jaccard >= ?
       ORDER BY jaccard DESC`,
    )
    .all(resolvedFile, resolvedFile, minJaccard);

  const partners = [];
  for (const row of rows) {
    const partner = row.file_a === resolvedFile ? row.file_b : row.file_a;
    if (noTests && isTestFile(partner)) continue;
    partners.push({
      file: partner,
      commitCount: row.commit_count,
      jaccard: row.jaccard,
      lastCommitDate: row.last_commit_epoch
        ? new Date(row.last_commit_epoch * 1000).toISOString().slice(0, 10)
        : null,
    });
    if (partners.length >= limit) break;
  }

  const meta = getCoChangeMeta(db);
  closeDb(db);

  const base = { file: resolvedFile, partners, meta };
  return paginateResult(base, 'partners', { limit: opts.limit, offset: opts.offset });
}

/**
 * Query top global co-change pairs.
 * @param {string} [customDbPath]
 * @param {object} [opts]
 * @param {number} [opts.limit=20]
 * @param {number} [opts.minJaccard=0.3]
 * @param {boolean} [opts.noTests]
 * @returns {{ pairs: Array, meta: object }}
 */
export function coChangeTopData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const limit = opts.limit || 20;
  const minJaccard = opts.minJaccard ?? 0.3;
  const noTests = opts.noTests || false;

  try {
    db.prepare('SELECT 1 FROM co_changes LIMIT 1').get();
  } catch {
    closeDb(db);
    return { error: 'No co-change data found. Run `codegraph co-change --analyze` first.' };
  }

  const rows = db
    .prepare(
      `SELECT file_a, file_b, commit_count, jaccard, last_commit_epoch
       FROM co_changes
       WHERE jaccard >= ?
       ORDER BY jaccard DESC`,
    )
    .all(minJaccard);

  const pairs = [];
  for (const row of rows) {
    if (noTests && (isTestFile(row.file_a) || isTestFile(row.file_b))) continue;
    pairs.push({
      fileA: row.file_a,
      fileB: row.file_b,
      commitCount: row.commit_count,
      jaccard: row.jaccard,
      lastCommitDate: row.last_commit_epoch
        ? new Date(row.last_commit_epoch * 1000).toISOString().slice(0, 10)
        : null,
    });
    if (pairs.length >= limit) break;
  }

  const meta = getCoChangeMeta(db);
  closeDb(db);

  const base = { pairs, meta };
  return paginateResult(base, 'pairs', { limit: opts.limit, offset: opts.offset });
}

/**
 * Batch-query co-change partners for a set of files.
 * Takes an already-open readonly DB handle (for diff-impact integration).
 * @param {string[]} files - File paths to query
 * @param {import('better-sqlite3').Database} db - Already-open DB handle
 * @param {object} [opts]
 * @param {number} [opts.minJaccard=0.3]
 * @param {number} [opts.limit=20]
 * @param {boolean} [opts.noTests]
 * @returns {Array<{file: string, coupledWith: string, commitCount: number, jaccard: number}>}
 */
export function coChangeForFiles(files, db, opts = {}) {
  const minJaccard = opts.minJaccard ?? 0.3;
  const limit = opts.limit ?? 20;
  const noTests = opts.noTests || false;
  const inputSet = new Set(files);

  if (files.length === 0) return [];

  const placeholders = files.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT file_a, file_b, commit_count, jaccard
       FROM co_changes
       WHERE (file_a IN (${placeholders}) OR file_b IN (${placeholders}))
         AND jaccard >= ?
       ORDER BY jaccard DESC
       LIMIT ?`,
    )
    .all(...files, ...files, minJaccard, limit);

  const results = [];
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

// ─── Internal Helpers ────────────────────────────────────────────────────

function resolveCoChangeFile(db, file) {
  // Exact match first
  const exact = db
    .prepare(
      'SELECT file_a FROM co_changes WHERE file_a = ? UNION SELECT file_b FROM co_changes WHERE file_b = ? LIMIT 1',
    )
    .get(file, file);
  if (exact) return exact.file_a;

  // Partial match (ends with)
  const partial = db
    .prepare(
      `SELECT file_a AS file FROM co_changes WHERE file_a LIKE ?
       UNION
       SELECT file_b AS file FROM co_changes WHERE file_b LIKE ?
       LIMIT 1`,
    )
    .get(`%${file}`, `%${file}`);
  if (partial) return partial.file;

  return null;
}

function getCoChangeMeta(db) {
  try {
    const rows = db.prepare('SELECT key, value FROM co_change_meta').all();
    const meta = {};
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
