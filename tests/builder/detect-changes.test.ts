/**
 * Unit tests for detectChanges pipeline stage.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initSchema, openDb } from '../../src/db/index.js';
import { PipelineContext } from '../../src/domain/graph/builder/context.js';
import { detectChanges } from '../../src/domain/graph/builder/stages/detect-changes.js';
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
    const stat = fs.statSync(path.join(dir, 'a.js'));
    db.prepare('INSERT INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)').run(
      'a.js',
      hash,
      Math.floor(stat.mtimeMs),
      stat.size,
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
