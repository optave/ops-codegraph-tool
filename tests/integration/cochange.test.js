/**
 * Integration tests for git co-change analysis.
 *
 * A. computeCoChanges — pure logic, no git/DB
 * B. analyzeCoChanges + query — DB integration
 * C. scanGitHistory — real git repo
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  coChangeData,
  coChangeTopData,
  computeCoChanges,
  scanGitHistory,
} from '../../src/cochange.js';
import { initSchema } from '../../src/db.js';

// ─── A. computeCoChanges (pure logic) ────────────────────────────────

describe('computeCoChanges', () => {
  test('computes correct Jaccard for known commit sets', () => {
    const commits = [
      { sha: 'a1', epoch: 1000, files: ['a.js', 'b.js'] },
      { sha: 'a2', epoch: 2000, files: ['a.js', 'b.js'] },
      { sha: 'a3', epoch: 3000, files: ['a.js', 'b.js'] },
      { sha: 'a4', epoch: 4000, files: ['a.js', 'c.js'] },
    ];
    // a.js appears in 4 commits, b.js in 3, pair(a,b) = 3
    // jaccard(a,b) = 3 / (4 + 3 - 3) = 3/4 = 0.75
    const { pairs: result } = computeCoChanges(commits, { minSupport: 1 });
    const abKey = 'a.js\0b.js';
    expect(result.has(abKey)).toBe(true);
    expect(result.get(abKey).jaccard).toBeCloseTo(0.75);
    expect(result.get(abKey).commitCount).toBe(3);
  });

  test('filters by minSupport', () => {
    const commits = [
      { sha: 'a1', epoch: 1000, files: ['a.js', 'b.js'] },
      { sha: 'a2', epoch: 2000, files: ['a.js', 'b.js'] },
      { sha: 'a3', epoch: 3000, files: ['a.js', 'c.js'] },
    ];
    const { pairs: result } = computeCoChanges(commits, { minSupport: 3 });
    // pair(a,b) only has 2 co-occurrences, pair(a,c) only 1
    expect(result.size).toBe(0);
  });

  test('skips commits exceeding maxFilesPerCommit', () => {
    const commits = [
      { sha: 'a1', epoch: 1000, files: ['a.js', 'b.js', 'c.js', 'd.js'] },
      { sha: 'a2', epoch: 2000, files: ['a.js', 'b.js'] },
      { sha: 'a3', epoch: 3000, files: ['a.js', 'b.js'] },
      { sha: 'a4', epoch: 4000, files: ['a.js', 'b.js'] },
    ];
    const { pairs: result } = computeCoChanges(commits, { minSupport: 3, maxFilesPerCommit: 3 });
    // First commit skipped (4 files > max 3)
    // pair(a,b) = 3 from commits a2,a3,a4; a appears in 3 commits, b in 3
    // jaccard = 3/(3+3-3) = 1.0
    const abKey = 'a.js\0b.js';
    expect(result.has(abKey)).toBe(true);
    expect(result.get(abKey).jaccard).toBeCloseTo(1.0);
  });

  test('enforces canonical pair ordering (file_a < file_b)', () => {
    const commits = [
      { sha: 'a1', epoch: 1000, files: ['z.js', 'a.js'] },
      { sha: 'a2', epoch: 2000, files: ['z.js', 'a.js'] },
      { sha: 'a3', epoch: 3000, files: ['z.js', 'a.js'] },
    ];
    const { pairs: result } = computeCoChanges(commits, { minSupport: 1 });
    // Should be stored as a.js < z.js
    expect(result.has('a.js\0z.js')).toBe(true);
    expect(result.has('z.js\0a.js')).toBe(false);
  });

  test('empty input returns empty map', () => {
    const { pairs: result } = computeCoChanges([], { minSupport: 1 });
    expect(result.size).toBe(0);
  });

  test('tracks lastEpoch correctly', () => {
    const commits = [
      { sha: 'a1', epoch: 1000, files: ['a.js', 'b.js'] },
      { sha: 'a2', epoch: 5000, files: ['a.js', 'b.js'] },
      { sha: 'a3', epoch: 3000, files: ['a.js', 'b.js'] },
    ];
    const { pairs: result } = computeCoChanges(commits, { minSupport: 1 });
    expect(result.get('a.js\0b.js').lastEpoch).toBe(5000);
  });

  test('filters by knownFiles when provided', () => {
    const commits = [
      { sha: 'a1', epoch: 1000, files: ['a.js', 'b.js', 'c.js'] },
      { sha: 'a2', epoch: 2000, files: ['a.js', 'b.js', 'c.js'] },
      { sha: 'a3', epoch: 3000, files: ['a.js', 'b.js', 'c.js'] },
    ];
    const knownFiles = new Set(['a.js', 'b.js']);
    const { pairs: result } = computeCoChanges(commits, { minSupport: 1, knownFiles });
    expect(result.has('a.js\0b.js')).toBe(true);
    // c.js pairs should not exist
    expect(result.has('a.js\0c.js')).toBe(false);
    expect(result.has('b.js\0c.js')).toBe(false);
  });
});

// ─── B. DB integration (coChangeData / coChangeTopData) ──────────────

describe('coChangeData + coChangeTopData', () => {
  let tmpDir, dbPath;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cochange-'));
    const cgDir = path.join(tmpDir, '.codegraph');
    fs.mkdirSync(cgDir, { recursive: true });
    dbPath = path.join(cgDir, 'graph.db');

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);

    // Insert known co_changes rows
    const insert = db.prepare(
      'INSERT INTO co_changes (file_a, file_b, commit_count, jaccard, last_commit_epoch) VALUES (?, ?, ?, ?, ?)',
    );
    insert.run('src/a.js', 'src/b.js', 10, 0.8, 1700000000);
    insert.run('src/a.js', 'src/c.js', 5, 0.5, 1690000000);
    insert.run('src/b.js', 'src/c.js', 3, 0.35, 1680000000);
    insert.run('src/a.js', 'tests/a.test.js', 8, 0.7, 1700000000);
    insert.run('src/d.js', 'src/e.js', 2, 0.2, 1670000000);

    // Insert meta
    const metaInsert = db.prepare('INSERT INTO co_change_meta (key, value) VALUES (?, ?)');
    metaInsert.run('analyzed_at', '2024-01-01T00:00:00.000Z');
    metaInsert.run('since', '1 year ago');

    db.close();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('coChangeData returns correct partners sorted by jaccard', () => {
    const data = coChangeData('src/a.js', dbPath);
    expect(data.error).toBeUndefined();
    expect(data.file).toBe('src/a.js');
    expect(data.partners.length).toBeGreaterThanOrEqual(2);
    // Sorted by jaccard desc
    for (let i = 1; i < data.partners.length; i++) {
      expect(data.partners[i - 1].jaccard).toBeGreaterThanOrEqual(data.partners[i].jaccard);
    }
  });

  test('coChangeData partial match works', () => {
    const data = coChangeData('a.js', dbPath);
    expect(data.error).toBeUndefined();
    expect(data.file).toBe('src/a.js');
  });

  test('coChangeTopData returns global top pairs', () => {
    const data = coChangeTopData(dbPath, { minJaccard: 0.3 });
    expect(data.error).toBeUndefined();
    expect(data.pairs.length).toBeGreaterThanOrEqual(3);
    // First pair should have highest jaccard
    expect(data.pairs[0].jaccard).toBe(0.8);
  });

  test('noTests filtering works', () => {
    const data = coChangeData('src/a.js', dbPath, { noTests: true });
    const testPartners = data.partners.filter((p) => p.file.includes('.test.'));
    expect(testPartners.length).toBe(0);
  });

  test('limit is respected', () => {
    const data = coChangeData('src/a.js', dbPath, { limit: 1 });
    expect(data.partners.length).toBeLessThanOrEqual(1);
  });

  test('minJaccard filtering works', () => {
    const data = coChangeTopData(dbPath, { minJaccard: 0.6 });
    for (const p of data.pairs) {
      expect(p.jaccard).toBeGreaterThanOrEqual(0.6);
    }
  });

  test('returns error when table is empty and file not found', () => {
    // Query for a nonexistent file
    const data = coChangeData('nonexistent.js', dbPath);
    expect(data.error).toBeDefined();
  });

  test('meta is included in response', () => {
    const data = coChangeTopData(dbPath);
    expect(data.meta).toBeDefined();
    expect(data.meta.analyzedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(data.meta.since).toBe('1 year ago');
  });
});

// ─── C. scanGitHistory (real git repo) ───────────────────────────────

describe('scanGitHistory', () => {
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-git-'));
    execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' });

    // Commit 1: a.js + b.js
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'export const a = 1;');
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'export const b = 2;');
    execFileSync('git', ['add', 'a.js', 'b.js'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'commit1', '--no-gpg-sign'], {
      cwd: tmpDir,
      stdio: 'pipe',
    });

    // Commit 2: a.js + c.js
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'export const a = 2;');
    fs.writeFileSync(path.join(tmpDir, 'c.js'), 'export const c = 1;');
    execFileSync('git', ['add', 'a.js', 'c.js'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'commit2', '--no-gpg-sign'], {
      cwd: tmpDir,
      stdio: 'pipe',
    });

    // Commit 3: a.js + b.js
    fs.writeFileSync(path.join(tmpDir, 'a.js'), 'export const a = 3;');
    fs.writeFileSync(path.join(tmpDir, 'b.js'), 'export const b = 3;');
    execFileSync('git', ['add', 'a.js', 'b.js'], { cwd: tmpDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'commit3', '--no-gpg-sign'], {
      cwd: tmpDir,
      stdio: 'pipe',
    });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns correct number of commits and files', () => {
    const { commits } = scanGitHistory(tmpDir);
    expect(commits.length).toBe(3);
    // Most recent commit first (git log order)
    expect(commits[0].files).toContain('a.js');
    expect(commits[0].files).toContain('b.js');
  });

  test('each commit has sha, epoch, and files', () => {
    const { commits } = scanGitHistory(tmpDir);
    for (const c of commits) {
      expect(c.sha).toMatch(/^[a-f0-9]{40}$/);
      expect(typeof c.epoch).toBe('number');
      expect(c.epoch).toBeGreaterThan(0);
      expect(Array.isArray(c.files)).toBe(true);
      expect(c.files.length).toBeGreaterThan(0);
    }
  });

  test('incremental (afterSha) works', () => {
    const { commits: all } = scanGitHistory(tmpDir);
    // Get the oldest commit sha
    const oldestSha = all[all.length - 1].sha;
    const { commits: incremental } = scanGitHistory(tmpDir, { afterSha: oldestSha });
    // Should exclude the oldest commit
    expect(incremental.length).toBe(all.length - 1);
    for (const c of incremental) {
      expect(c.sha).not.toBe(oldestSha);
    }
  });

  test('returns empty for nonexistent repo', () => {
    const { commits } = scanGitHistory('/nonexistent/path');
    expect(commits).toEqual([]);
  });
});
