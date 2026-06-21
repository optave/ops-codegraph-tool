/**
 * Unit tests for collectFiles pipeline stage.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PipelineContext } from '../../src/domain/graph/builder/context.js';
import { readGitignorePatterns } from '../../src/domain/graph/builder/helpers.js';
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

describe('readGitignorePatterns', () => {
  let gitignoreDir: string;

  afterEach(() => {
    if (gitignoreDir) fs.rmSync(gitignoreDir, { recursive: true, force: true });
  });

  it('returns empty array when no .gitignore exists', () => {
    gitignoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gitignore-'));
    const regexes = readGitignorePatterns(gitignoreDir);
    expect(regexes).toHaveLength(0);
  });

  it('compiles path-specific patterns (e.g. crates/codegraph-core/index.js)', () => {
    gitignoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gitignore-'));
    fs.writeFileSync(
      path.join(gitignoreDir, '.gitignore'),
      'crates/codegraph-core/index.js\ncrates/codegraph-core/index.d.ts\n',
    );
    const regexes = readGitignorePatterns(gitignoreDir);
    expect(regexes.length).toBeGreaterThan(0);
    // These specific paths should be excluded
    expect(regexes.some((r) => r.test('crates/codegraph-core/index.js'))).toBe(true);
    expect(regexes.some((r) => r.test('crates/codegraph-core/index.d.ts'))).toBe(true);
    // But sibling source files should NOT be excluded
    expect(regexes.some((r) => r.test('crates/codegraph-core/src/lib.rs'))).toBe(false);
  });

  it('skips comments, empty lines, and negation patterns', () => {
    gitignoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gitignore-'));
    fs.writeFileSync(
      path.join(gitignoreDir, '.gitignore'),
      '# comment\n\n!negated.js\ngenerated.js\n',
    );
    const regexes = readGitignorePatterns(gitignoreDir);
    // Only generated.js should produce a regex; comments, blank lines, and negations are skipped
    expect(regexes.some((r) => r.test('src/generated.js'))).toBe(true);
  });

  it('expands bare filename patterns to match at any depth', () => {
    gitignoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gitignore-'));
    fs.writeFileSync(path.join(gitignoreDir, '.gitignore'), '*.db\n');
    const regexes = readGitignorePatterns(gitignoreDir);
    expect(regexes.some((r) => r.test('data.db'))).toBe(true);
    expect(regexes.some((r) => r.test('nested/deep/data.db'))).toBe(true);
  });

  it('collectFiles respects .gitignore when walking the filesystem', async () => {
    // Reproduce the original issue: NAPI-RS generated files in crates/ are gitignored
    // and must be excluded from WASM analysis without adding 'crates' to IGNORE_DIRS.
    gitignoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gitignore-crates-'));
    // Create a tracked source file in a 'crates/' subdirectory
    fs.mkdirSync(path.join(gitignoreDir, 'crates', 'my-lib', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(gitignoreDir, 'crates', 'my-lib', 'src', 'index.ts'),
      'export const x = 1;',
    );
    // Create a gitignored generated file (the artifact that caused the false complexity)
    fs.mkdirSync(path.join(gitignoreDir, 'crates', 'codegraph-core'), { recursive: true });
    fs.writeFileSync(
      path.join(gitignoreDir, 'crates', 'codegraph-core', 'index.js'),
      '// generated',
    );
    // Write .gitignore that excludes only the generated file
    fs.writeFileSync(path.join(gitignoreDir, '.gitignore'), 'crates/codegraph-core/index.js\n');

    const ctx = new PipelineContext();
    ctx.rootDir = gitignoreDir;
    ctx.config = {};
    ctx.opts = {};

    await collectFiles(ctx);

    const basenames = ctx.allFiles.map((f) => path.basename(f));
    // Tracked source in crates/ MUST be included
    expect(basenames).toContain('index.ts');
    // Gitignored generated artifact MUST be excluded
    expect(
      ctx.allFiles.some((f) => f.includes('codegraph-core') && path.basename(f) === 'index.js'),
    ).toBe(false);
  });
});
