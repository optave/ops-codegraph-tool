/**
 * Unit tests for collectFiles pipeline stage.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PipelineContext } from '../../src/domain/graph/builder/context.js';
import { collectFiles } from '../../src/domain/graph/builder/stages/collect-files.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stage-collect-'));
  fs.mkdirSync(path.join(tmpDir, 'src'));
  fs.writeFileSync(path.join(tmpDir, 'src', 'a.js'), 'export const a = 1;');
  fs.writeFileSync(path.join(tmpDir, 'src', 'b.ts'), 'export const b = 2;');
  fs.writeFileSync(path.join(tmpDir, 'src', 'style.css'), 'body {}');
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('collectFiles stage', () => {
  it('populates ctx.allFiles and ctx.discoveredDirs', async () => {
    const ctx = new PipelineContext();
    ctx.rootDir = tmpDir;
    ctx.config = {};
    ctx.opts = {};

    await collectFiles(ctx);

    expect(ctx.allFiles.length).toBe(2); // a.js + b.ts, not style.css
    const basenames = ctx.allFiles.map((f) => path.basename(f));
    expect(basenames).toContain('a.js');
    expect(basenames).toContain('b.ts');
    expect(basenames).not.toContain('style.css');
    expect(ctx.discoveredDirs).toBeInstanceOf(Set);
    expect(ctx.discoveredDirs.size).toBeGreaterThan(0);
  });

  it('handles scoped rebuild', async () => {
    const ctx = new PipelineContext();
    ctx.rootDir = tmpDir;
    ctx.config = {};
    ctx.opts = { scope: ['src/a.js'] };

    await collectFiles(ctx);

    expect(ctx.allFiles).toHaveLength(1);
    expect(ctx.isFullBuild).toBe(false);
    expect(ctx.parseChanges).toHaveLength(1);
    expect(ctx.parseChanges[0].relPath).toBe('src/a.js');
    expect(ctx.removed).toHaveLength(0);
  });

  it('scoped rebuild with missing file marks it as removed', async () => {
    const ctx = new PipelineContext();
    ctx.rootDir = tmpDir;
    ctx.config = {};
    ctx.opts = { scope: ['nonexistent.js'] };

    await collectFiles(ctx);

    expect(ctx.allFiles).toHaveLength(0);
    expect(ctx.parseChanges).toHaveLength(0);
    expect(ctx.removed).toContain('nonexistent.js');
  });
});
