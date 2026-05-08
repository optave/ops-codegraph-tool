/**
 * Unit tests for detectChanges pipeline stage.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, initSchema, openDb } from '../../src/db/index.js';
import { PipelineContext } from '../../src/domain/graph/builder/context.js';
import { fileStat } from '../../src/domain/graph/builder/helpers.js';
import {
  detectChanges,
  detectNoChanges,
} from '../../src/domain/graph/builder/stages/detect-changes.js';
import { writeJournalHeader } from '../../src/domain/graph/journal.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stage-detect-'));
  fs.writeFileSync(path.join(tmpDir, 'a.js'), 'export const a = 1;');
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('detectChanges stage', () => {
  it('treats all files as changed when file_hashes is empty', async () => {
    const dbDir = path.join(tmpDir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);

    const ctx = new PipelineContext();
    ctx.rootDir = tmpDir;
    ctx.db = db;
    ctx.allFiles = [path.join(tmpDir, 'a.js')];
    ctx.opts = {};
    ctx.incremental = true;
    ctx.forceFullRebuild = false;
    ctx.config = {};

    await detectChanges(ctx);

    // Empty file_hashes = all files are new (incremental, not full build)
    expect(ctx.isFullBuild).toBe(false);
    expect(ctx.earlyExit).toBe(false);
    expect(ctx.parseChanges.length).toBe(1);
    closeDb(db);
  });

  it('detects early exit when no changes after initial build', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stage-nochange-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;');

    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);

    // Seed file_hashes so incremental thinks file is unchanged
    const content = fs.readFileSync(path.join(dir, 'a.js'), 'utf-8');
    const { createHash } = await import('node:crypto');
    const hash = createHash('md5').update(content).digest('hex');
    const stat = fs.statSync(path.join(dir, 'a.js'), { bigint: true });
    db.prepare('INSERT INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)').run(
      'a.js',
      hash,
      Number(stat.mtimeNs / 1_000_000n),
      Number(stat.size),
    );

    // Write journal header so journal check doesn't confuse things
    writeJournalHeader(dir, Date.now());

    const ctx = new PipelineContext();
    ctx.rootDir = dir;
    ctx.db = db;
    ctx.allFiles = [path.join(dir, 'a.js')];
    ctx.opts = {};
    ctx.incremental = true;
    ctx.forceFullRebuild = false;
    ctx.config = {};

    await detectChanges(ctx);

    expect(ctx.earlyExit).toBe(true);
    // DB should be closed by detectChanges on early exit
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips change detection for scoped builds', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stage-scope-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;');

    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);

    const ctx = new PipelineContext();
    ctx.rootDir = dir;
    ctx.db = db;
    ctx.allFiles = [path.join(dir, 'a.js')];
    ctx.opts = { scope: ['a.js'] };
    ctx.incremental = true;
    ctx.forceFullRebuild = false;
    ctx.config = {};
    ctx.parseChanges = [{ file: path.join(dir, 'a.js'), relPath: 'a.js' }];
    ctx.removed = [];
    ctx.isFullBuild = false;

    await detectChanges(ctx);

    // Should return without modifying isFullBuild
    expect(ctx.isFullBuild).toBe(false);
    expect(ctx.earlyExit).toBe(false);
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('forces full rebuild when forceFullRebuild is set', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stage-force-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;');

    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);

    const ctx = new PipelineContext();
    ctx.rootDir = dir;
    ctx.db = db;
    ctx.allFiles = [path.join(dir, 'a.js')];
    ctx.opts = {};
    ctx.incremental = true;
    ctx.forceFullRebuild = true;
    ctx.config = {};

    await detectChanges(ctx);

    expect(ctx.isFullBuild).toBe(true);
    expect(ctx.parseChanges.length).toBe(1);
    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('detectNoChanges fast-skip', () => {
  function seedFile(dir: string, name: string, content: string): string {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function seedHashRow(
    db: ReturnType<typeof openDb>,
    relPath: string,
    filePath: string,
  ): { mtime: number; size: number } {
    const stat = fs.statSync(filePath, { bigint: true });
    const mtime = Number(stat.mtimeNs / 1_000_000n);
    const size = Number(stat.size);
    db.prepare('INSERT INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)').run(
      relPath,
      'deadbeef',
      mtime,
      size,
    );
    return { mtime, size };
  }

  it('returns false when file_hashes is empty (first build)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noChange-empty-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);
    const file = seedFile(dir, 'a.js', 'export const a = 1;');

    expect(detectNoChanges(db, [file], dir)).toBe(false);

    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns true when mtime+size match seeded file_hashes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noChange-match-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);
    const file = seedFile(dir, 'a.js', 'export const a = 1;');
    seedHashRow(db, 'a.js', file);

    expect(detectNoChanges(db, [file], dir)).toBe(true);

    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when a tracked file has been deleted', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noChange-deleted-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);
    const file = seedFile(dir, 'a.js', 'export const a = 1;');
    seedHashRow(db, 'a.js', file);
    seedHashRow(db, 'gone.js', file); // tracked but no longer on disk

    expect(detectNoChanges(db, [file], dir)).toBe(false);

    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when mtime differs from seeded value', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noChange-mtime-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);
    const file = seedFile(dir, 'a.js', 'export const a = 1;');
    const stat = fs.statSync(file, { bigint: true });
    db.prepare('INSERT INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)').run(
      'a.js',
      'deadbeef',
      Number(stat.mtimeNs / 1_000_000n) + 1000, // skewed mtime
      Number(stat.size),
    );

    expect(detectNoChanges(db, [file], dir)).toBe(false);

    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when CFG analysis is enabled but cfg_blocks is empty (#1064)', () => {
    // Pending-analysis guard: even though mtime+size match, if cfg_blocks
    // is empty (analysis newly enabled), the caller must fall through so
    // runPendingAnalysis can populate the table.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noChange-pendingCfg-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);
    const file = seedFile(dir, 'a.js', 'export const a = 1;');
    seedHashRow(db, 'a.js', file);
    // cfg_blocks table is created empty by initSchema — that's the trigger.

    // Without opts: legacy behaviour — fast-skip returns true.
    expect(detectNoChanges(db, [file], dir)).toBe(true);
    // With cfg enabled (cfg !== false) and cfg_blocks empty: must return false.
    expect(detectNoChanges(db, [file], dir, { cfg: true, dataflow: false })).toBe(false);
    // When cfg explicitly disabled (and dataflow disabled too so its guard
    // doesn't fire), the empty cfg table is irrelevant.
    expect(detectNoChanges(db, [file], dir, { cfg: false, dataflow: false })).toBe(true);

    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when dataflow is enabled but dataflow table is empty (#1064)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noChange-pendingDf-'));
    const dbDir = path.join(dir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = openDb(path.join(dbDir, 'graph.db'));
    initSchema(db);
    const file = seedFile(dir, 'a.js', 'export const a = 1;');
    seedHashRow(db, 'a.js', file);

    // Disable cfg so only the dataflow guard is exercised.
    expect(detectNoChanges(db, [file], dir, { cfg: false, dataflow: true })).toBe(false);
    expect(detectNoChanges(db, [file], dir, { cfg: false, dataflow: false })).toBe(true);

    closeDb(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Pins down the BigInt-nanosecond truncation the helper uses to match Rust's
  // `Duration::as_millis() as i64`. We can't trigger the f64 ULP rounding bug
  // with a freshly-created file (the failure window is ~256 ns out of every ms,
  // ~0.026% of values), so instead we stub `fs.statSync` to return a hand-picked
  // BigInt `mtimeNs` whose f64-mtimeMs path diverges from the BigInt path:
  //   ns = 1748400000000999808n  (≈ 2025-05-28 epoch ns)
  //   BigInt:        Number(ns / 1_000_000n)         === 1748400000000
  //   f64 (broken):  Math.floor(Number(ns) / 1e6)    === 1748400000001
  // Reverting `fileStat` to `Math.floor(stat.mtimeMs)` would flip the result to
  // N+1 and fail the assertion deterministically — re-introducing #1075 (the
  // Rust-written `file_hashes.mtime` of N reading back as N+1 in JS, busting
  // the fast-skip path on every native→JS handoff).
  describe('fileStat #1075 mtime truncation', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('matches Rust Duration::as_millis() truncation at f64-rounding boundary', () => {
      // Hand-picked epoch ns where Number(ns)/1e6 rounds up across a ms boundary.
      const badMtimeNs = 1748400000000999808n;
      const truncatedMs = 1748400000000;
      const roundedMs = 1748400000001;

      // Sanity: confirm the chosen value actually triggers the divergence; if a
      // future Node.js release changes f64 rounding, this baseline assertion
      // catches it before we trust the spy-based test below.
      expect(Number(badMtimeNs / 1_000_000n)).toBe(truncatedMs);
      expect(Math.floor(Number(badMtimeNs) / 1e6)).toBe(roundedMs);

      const stubStats = {
        mtimeNs: badMtimeNs,
        mtimeMs: Number(badMtimeNs) / 1e6,
        size: 42n,
      } as unknown as fs.BigIntStats;
      vi.spyOn(fs, 'statSync').mockReturnValue(stubStats);

      // BigInt path must win: N, not N+1.
      expect(fileStat('/fake/path.js')?.mtime).toBe(truncatedMs);
    });

    it('returns the BigInt-truncated mtime for a real file on disk', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fileStat-trunc-'));
      const file = seedFile(dir, 'a.js', 'export const a = 1;');

      const big = fs.statSync(file, { bigint: true });
      const expected = Number(big.mtimeNs / 1_000_000n);
      expect(fileStat(file)?.mtime).toBe(expected);

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
