/**
 * Unit tests for detectChanges pipeline stage.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  // `Duration::as_millis() as i64`. Reverting to `Math.floor(stat.mtimeMs)`
  // re-introduces #1075: at large epoch values the f64 `mtimeMs` rounds, so a
  // Rust-written `file_hashes.mtime` reads back 1ms ahead in JS and busts the
  // fast-skip path on every native→JS handoff.
  it('fileStat mtime matches Rust Duration::as_millis() truncation (#1075)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fileStat-trunc-'));
    const file = seedFile(dir, 'a.js', 'export const a = 1;');

    const big = fs.statSync(file, { bigint: true });
    const expected = Number(big.mtimeNs / 1_000_000n);
    expect(fileStat(file)?.mtime).toBe(expected);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
