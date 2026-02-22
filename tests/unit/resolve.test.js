/**
 * Unit tests for src/resolve.js
 *
 * Tests resolveImportPathJS, computeConfidenceJS, and convertAliasesForNative.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeConfidence,
  computeConfidenceJS,
  convertAliasesForNative,
  resolveImportPathJS,
  resolveImportsBatch,
} from '../../src/resolve.js';

// ─── Temp project setup ──────────────────────────────────────────────

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolve-'));

  // Create file structure:
  //   src/math.js
  //   src/math.ts     (for .js -> .ts remap)
  //   src/utils.tsx
  //   src/lib/index.js (for directory index resolution)
  //   src/lib/helper.ts
  //   shared/core.ts   (for alias resolution)
  fs.mkdirSync(path.join(tmpDir, 'src', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'shared'), { recursive: true });

  fs.writeFileSync(path.join(tmpDir, 'src', 'math.js'), 'export const add = (a, b) => a + b;');
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'math.ts'),
    'export const add = (a: number, b: number) => a + b;',
  );
  fs.writeFileSync(path.join(tmpDir, 'src', 'utils.tsx'), 'export const Comp = () => <div/>;');
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'lib', 'index.js'),
    'export { helper } from "./helper";',
  );
  fs.writeFileSync(path.join(tmpDir, 'src', 'lib', 'helper.ts'), 'export function helper() {}');
  fs.writeFileSync(path.join(tmpDir, 'shared', 'core.ts'), 'export const x = 1;');
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── resolveImportPathJS ────────────────────────────────────────────

describe('resolveImportPathJS', () => {
  it('resolves relative ./math to .js extension', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const result = resolveImportPathJS(fromFile, './math', tmpDir, null);
    expect(result).toContain('src/math');
    expect(result).toMatch(/\.ts$/);
  });

  it('resolves .js import to .ts file when .ts exists', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const result = resolveImportPathJS(fromFile, './math.js', tmpDir, null);
    expect(result).toMatch(/math\.ts$/);
  });

  it('resolves .js import to .tsx when .tsx exists', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const result = resolveImportPathJS(fromFile, './utils', tmpDir, null);
    expect(result).toMatch(/utils\.tsx$/);
  });

  it('resolves directory to index.js', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const result = resolveImportPathJS(fromFile, './lib', tmpDir, null);
    expect(result).toContain('lib/index.js');
  });

  it('passes through bare specifiers', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const result = resolveImportPathJS(fromFile, 'lodash', tmpDir, null);
    expect(result).toBe('lodash');
  });

  it('resolves via baseUrl alias', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const aliases = {
      baseUrl: tmpDir,
      paths: {},
    };
    const result = resolveImportPathJS(fromFile, 'shared/core', tmpDir, aliases);
    expect(result).toContain('shared/core');
    expect(result).toMatch(/\.ts$/);
  });

  it('resolves via path alias pattern', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const aliases = {
      baseUrl: null,
      paths: {
        '@shared/*': [path.join(tmpDir, 'shared', '*')],
      },
    };
    const result = resolveImportPathJS(fromFile, '@shared/core', tmpDir, aliases);
    expect(result).toContain('shared/core');
  });

  it('falls through when alias does not match', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const aliases = {
      baseUrl: null,
      paths: {
        '@other/*': [path.join(tmpDir, 'other', '*')],
      },
    };
    const result = resolveImportPathJS(fromFile, 'lodash', tmpDir, aliases);
    expect(result).toBe('lodash');
  });
});

// ─── computeConfidenceJS ────────────────────────────────────────────

describe('computeConfidenceJS', () => {
  it('returns max confidence for same-file calls', () => {
    expect(computeConfidenceJS('src/a.js', 'src/a.js', undefined)).toBe(1.0);
  });

  it('returns max confidence when importedFrom matches target', () => {
    expect(computeConfidenceJS('src/a.js', 'src/b.js', 'src/b.js')).toBe(1.0);
  });

  it('returns higher confidence for same-directory than distant files', () => {
    const sameDir = computeConfidenceJS('src/a.js', 'src/b.js', undefined);
    const distant = computeConfidenceJS('src/deep/nested/a.js', 'lib/other/b.js', undefined);
    expect(sameDir).toBeGreaterThan(distant);
    expect(sameDir).toBeGreaterThan(0.5);
    expect(sameDir).toBeLessThanOrEqual(1.0);
  });

  it('returns higher confidence for sibling parents than distant files', () => {
    const siblingParent = computeConfidenceJS('src/foo/a.js', 'src/bar/b.js', undefined);
    const distant = computeConfidenceJS('src/deep/nested/a.js', 'lib/other/b.js', undefined);
    expect(siblingParent).toBeGreaterThan(distant);
  });

  it('returns lowest confidence for distant files', () => {
    const distant = computeConfidenceJS('src/deep/nested/a.js', 'lib/other/b.js', undefined);
    expect(distant).toBeGreaterThan(0);
    expect(distant).toBeLessThan(0.5);
  });

  it('returns low confidence when callerFile is null', () => {
    const result = computeConfidenceJS(null, 'src/b.js', undefined);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(0.5);
  });

  it('returns low confidence when targetFile is null', () => {
    const result = computeConfidenceJS('src/a.js', null, undefined);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(0.5);
  });

  it('confidence decreases with distance: same-dir > sibling-parent > distant', () => {
    const sameDir = computeConfidenceJS('src/a.js', 'src/b.js', undefined);
    const siblingParent = computeConfidenceJS('src/foo/a.js', 'src/bar/b.js', undefined);
    const distant = computeConfidenceJS('src/deep/nested/a.js', 'lib/other/b.js', undefined);
    expect(sameDir).toBeGreaterThan(siblingParent);
    expect(siblingParent).toBeGreaterThan(distant);
  });
});

// ─── computeConfidence (public API, dispatches to native or JS) ─────

describe('computeConfidence', () => {
  it('returns numeric confidence for same file', () => {
    const conf = computeConfidence('src/a.js', 'src/a.js', undefined);
    expect(conf).toBe(1.0);
  });
});

// ─── convertAliasesForNative ─────────────────────────────────────────

describe('convertAliasesForNative', () => {
  it('returns null for null input', () => {
    expect(convertAliasesForNative(null)).toBeNull();
  });

  it('converts JS alias format to native format', () => {
    const result = convertAliasesForNative({
      baseUrl: '/root',
      paths: { '@/*': ['src/*'] },
    });
    expect(result).toEqual({
      baseUrl: '/root',
      paths: [{ pattern: '@/*', targets: ['src/*'] }],
    });
  });

  it('handles missing baseUrl and paths', () => {
    const result = convertAliasesForNative({});
    expect(result).toEqual({ baseUrl: null, paths: [] });
  });
});

// ─── resolveImportsBatch ─────────────────────────────────────────────

describe('resolveImportsBatch', () => {
  it('returns null when native is not available (or a Map when it is)', () => {
    const result = resolveImportsBatch(
      [{ fromFile: path.join(tmpDir, 'src', 'index.js'), importSource: './math' }],
      tmpDir,
      null,
    );
    // native may or may not be available
    expect(result === null || result instanceof Map).toBe(true);
  });
});
