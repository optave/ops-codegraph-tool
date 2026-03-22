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
  clearExportsCache,
  computeConfidence,
  computeConfidenceJS,
  convertAliasesForNative,
  parseBareSpecifier,
  resolveImportPathJS,
  resolveImportsBatch,
  resolveViaExports,
} from '../../src/domain/graph/resolve.js';

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
    expect(result).toEqual({ baseUrl: '', paths: [] });
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

// ─── parseBareSpecifier ──────────────────────────────────────────────

describe('parseBareSpecifier', () => {
  it('parses plain package with no subpath', () => {
    expect(parseBareSpecifier('lodash')).toEqual({ packageName: 'lodash', subpath: '.' });
  });

  it('parses plain package with subpath', () => {
    expect(parseBareSpecifier('lodash/fp')).toEqual({ packageName: 'lodash', subpath: './fp' });
  });

  it('parses scoped package with no subpath', () => {
    expect(parseBareSpecifier('@scope/pkg')).toEqual({ packageName: '@scope/pkg', subpath: '.' });
  });

  it('parses scoped package with subpath', () => {
    expect(parseBareSpecifier('@scope/pkg/utils/deep')).toEqual({
      packageName: '@scope/pkg',
      subpath: './utils/deep',
    });
  });

  it('returns null for bare @ with no slash', () => {
    expect(parseBareSpecifier('@scope')).toBeNull();
  });
});

// ─── resolveViaExports ───────────────────────────────────────────────

describe('resolveViaExports', () => {
  let pkgRoot;

  beforeAll(() => {
    clearExportsCache();
    // Create a fake node_modules structure inside tmpDir
    pkgRoot = path.join(tmpDir, 'node_modules', 'test-pkg');
    fs.mkdirSync(path.join(pkgRoot, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(pkgRoot, 'lib', 'utils'), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'dist', 'index.mjs'), 'export default 1;');
    fs.writeFileSync(path.join(pkgRoot, 'dist', 'index.cjs'), 'module.exports = 1;');
    fs.writeFileSync(path.join(pkgRoot, 'dist', 'helpers.mjs'), 'export const h = 1;');
    fs.writeFileSync(path.join(pkgRoot, 'lib', 'utils', 'deep.js'), 'export const d = 1;');
  });

  afterEach(() => {
    clearExportsCache();
  });

  it('resolves string exports (shorthand)', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({ name: 'test-pkg', exports: './dist/index.mjs' }),
    );
    const result = resolveViaExports('test-pkg', tmpDir);
    expect(result).toBe(path.join(pkgRoot, 'dist', 'index.mjs'));
  });

  it('returns null for subpath when exports is a string', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({ name: 'test-pkg', exports: './dist/index.mjs' }),
    );
    expect(resolveViaExports('test-pkg/helpers', tmpDir)).toBeNull();
  });

  it('resolves conditional exports (import/require/default)', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({
        name: 'test-pkg',
        exports: {
          '.': { import: './dist/index.mjs', require: './dist/index.cjs' },
        },
      }),
    );
    const result = resolveViaExports('test-pkg', tmpDir);
    expect(result).toBe(path.join(pkgRoot, 'dist', 'index.mjs'));
  });

  it('falls back to require when import is absent', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({
        name: 'test-pkg',
        exports: {
          '.': { require: './dist/index.cjs' },
        },
      }),
    );
    const result = resolveViaExports('test-pkg', tmpDir);
    expect(result).toBe(path.join(pkgRoot, 'dist', 'index.cjs'));
  });

  it('resolves subpath exports', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({
        name: 'test-pkg',
        exports: {
          '.': './dist/index.mjs',
          './helpers': './dist/helpers.mjs',
        },
      }),
    );
    const result = resolveViaExports('test-pkg/helpers', tmpDir);
    expect(result).toBe(path.join(pkgRoot, 'dist', 'helpers.mjs'));
  });

  it('resolves subpath patterns with wildcard', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({
        name: 'test-pkg',
        exports: {
          '.': './dist/index.mjs',
          './lib/*': './lib/*.js',
        },
      }),
    );
    const result = resolveViaExports('test-pkg/lib/utils/deep', tmpDir);
    expect(result).toBe(path.join(pkgRoot, 'lib', 'utils', 'deep.js'));
  });

  it('resolves conditional subpath exports', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({
        name: 'test-pkg',
        exports: {
          './helpers': { import: './dist/helpers.mjs', default: './dist/helpers.mjs' },
        },
      }),
    );
    const result = resolveViaExports('test-pkg/helpers', tmpDir);
    expect(result).toBe(path.join(pkgRoot, 'dist', 'helpers.mjs'));
  });

  it('resolves top-level conditions object (no . keys)', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({
        name: 'test-pkg',
        exports: { import: './dist/index.mjs', require: './dist/index.cjs' },
      }),
    );
    const result = resolveViaExports('test-pkg', tmpDir);
    expect(result).toBe(path.join(pkgRoot, 'dist', 'index.mjs'));
  });

  it('returns null when exports field is absent', () => {
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({ name: 'test-pkg', main: './dist/index.mjs' }),
    );
    expect(resolveViaExports('test-pkg', tmpDir)).toBeNull();
  });

  it('returns null when package is not in node_modules', () => {
    expect(resolveViaExports('nonexistent-pkg', tmpDir)).toBeNull();
  });
});

// ─── resolveImportPathJS with exports ────────────────────────────────

describe('resolveImportPathJS with package.json exports', () => {
  let pkgRoot;

  beforeAll(() => {
    clearExportsCache();
    pkgRoot = path.join(tmpDir, 'node_modules', 'exports-pkg');
    fs.mkdirSync(path.join(pkgRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'dist', 'main.mjs'), 'export default 1;');
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({
        name: 'exports-pkg',
        exports: { '.': './dist/main.mjs' },
      }),
    );
  });

  afterEach(() => {
    clearExportsCache();
  });

  it('resolves bare specifier through exports field', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const result = resolveImportPathJS(fromFile, 'exports-pkg', tmpDir, null);
    expect(result).toContain('node_modules/exports-pkg/dist/main.mjs');
  });

  it('still passes through bare specifiers without exports', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const result = resolveImportPathJS(fromFile, 'lodash', tmpDir, null);
    expect(result).toBe('lodash');
  });
});
