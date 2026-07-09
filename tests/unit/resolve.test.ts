/**
 * Unit tests for src/resolve.js
 *
 * Tests resolveImportPathJS, computeConfidenceJS, and convertAliasesForNative.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  clearExportsCache,
  clearJsToTsCache,
  clearWorkspaceCache,
  computeConfidence,
  computeConfidenceJS,
  convertAliasesForNative,
  isSameLanguageFamily,
  isWorkspaceResolved,
  parseBareSpecifier,
  resolveImportPathJS,
  resolveImportsBatch,
  resolveViaExports,
  resolveViaWorkspace,
  setWorkspaces,
} from '../../src/domain/graph/resolve.js';
import { normalizePath } from '../../src/shared/constants.js';

// ─── Temp project setup ──────────────────────────────────────────────

let tmpDir: string;

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

afterEach(() => {
  clearJsToTsCache();
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

  // Regression tests for #1769: a fixed-depth "grandparent equality" check used
  // to compare `dirname(dirname(callerFile))` to `dirname(dirname(targetFile))`,
  // which only matched when both files sat at the *same* depth. A file in a
  // subdirectory calling a method declared in its direct parent directory
  // (e.g. `graph/algorithms/bfs.ts` calling `graph/model.ts`) was scored as
  // maximally distant (0.3) purely because the two files were nested at
  // different depths — well below the 0.5 threshold used by the call-edge
  // resolver's typed-method lookup, silently dropping the call edge.
  describe('directory-nesting distance (#1769)', () => {
    it('scores a direct parent/child directory pair above the 0.5 resolver threshold', () => {
      // caller one level deeper than target — the exact bfs.ts -> model.ts shape.
      const conf = computeConfidenceJS(
        'src/graph/algorithms/bfs.ts',
        'src/graph/model.ts',
        undefined,
      );
      expect(conf).toBeGreaterThanOrEqual(0.5);
    });

    it('is symmetric: target one level deeper than caller scores the same as the reverse', () => {
      const callerDeeper = computeConfidenceJS(
        'src/graph/algorithms/bfs.ts',
        'src/graph/model.ts',
        undefined,
      );
      const targetDeeper = computeConfidenceJS(
        'src/graph/model.ts',
        'src/graph/algorithms/bfs.ts',
        undefined,
      );
      expect(targetDeeper).toBe(callerDeeper);
    });

    it('ranks direct parent/child nesting strictly between same-directory and sibling-directory', () => {
      const sameDir = computeConfidenceJS('src/graph/a.ts', 'src/graph/b.ts', undefined);
      const parentChild = computeConfidenceJS(
        'src/graph/algorithms/bfs.ts',
        'src/graph/model.ts',
        undefined,
      );
      // True siblings: both one level below `src`, at equal depth.
      const sibling = computeConfidenceJS('src/graph/a.ts', 'src/features/b.ts', undefined);
      expect(sameDir).toBeGreaterThan(parentChild);
      expect(parentChild).toBeGreaterThan(sibling);
    });

    it('scores a two-level-deep subdirectory calling into its grandparent at or above the sibling tier', () => {
      // the graph/algorithms/leiden/*.ts -> graph/model.ts shape from #1769.
      const conf = computeConfidenceJS(
        'src/graph/algorithms/leiden/cpm.ts',
        'src/graph/model.ts',
        undefined,
      );
      expect(conf).toBeGreaterThanOrEqual(0.5);
    });

    it('still scores unrelated deeply-nested files as distant', () => {
      const conf = computeConfidenceJS(
        'src/graph/algorithms/leiden/cpm.ts',
        'src/mcp/server.ts',
        undefined,
      );
      expect(conf).toBeLessThan(0.5);
    });
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

  it('remaps .js → .ts in batch results when .ts file exists', () => {
    const fromFile = path.join(tmpDir, 'src', 'index.js');
    const result = resolveImportsBatch([{ fromFile, importSource: './math.js' }], tmpDir, null);
    // Skip when native addon is not available
    if (result === null) return;
    const key = `${normalizePath(fromFile)}|./math.js`;
    const resolved = result.get(key);
    expect(resolved).toBeDefined();
    expect(resolved).toMatch(/math\.ts$/);
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
  let pkgRoot: string;

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
  let pkgRoot: string;

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

// ─── resolveViaWorkspace ─────────────────────────────────────────────

describe('resolveViaWorkspace', () => {
  let wsRoot: string;

  beforeAll(() => {
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ws-'));
    // Create a monorepo structure:
    //   packages/core/src/index.js
    //   packages/core/src/helpers.js
    //   packages/core/package.json  { name: "@myorg/core", main: "./src/index.js" }
    //   packages/utils/src/index.ts
    //   packages/utils/package.json { name: "@myorg/utils" }
    fs.mkdirSync(path.join(wsRoot, 'packages', 'core', 'src'), { recursive: true });
    fs.mkdirSync(path.join(wsRoot, 'packages', 'utils', 'src'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'packages', 'core', 'src', 'index.js'), 'export default 1;');
    fs.writeFileSync(
      path.join(wsRoot, 'packages', 'core', 'src', 'helpers.js'),
      'export const h = 1;',
    );
    fs.writeFileSync(
      path.join(wsRoot, 'packages', 'core', 'package.json'),
      JSON.stringify({ name: '@myorg/core', main: './src/index.js' }),
    );
    fs.writeFileSync(
      path.join(wsRoot, 'packages', 'utils', 'src', 'index.ts'),
      'export default 1;',
    );
    fs.writeFileSync(
      path.join(wsRoot, 'packages', 'utils', 'package.json'),
      JSON.stringify({ name: '@myorg/utils' }),
    );

    // Register workspaces
    setWorkspaces(
      wsRoot,
      new Map([
        [
          '@myorg/core',
          {
            dir: path.join(wsRoot, 'packages', 'core'),
            entry: path.join(wsRoot, 'packages', 'core', 'src', 'index.js'),
          },
        ],
        [
          '@myorg/utils',
          {
            dir: path.join(wsRoot, 'packages', 'utils'),
            entry: path.join(wsRoot, 'packages', 'utils', 'src', 'index.ts'),
          },
        ],
      ]),
    );
  });

  afterAll(() => {
    clearWorkspaceCache();
    if (wsRoot) fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    clearExportsCache();
  });

  it('resolves root import to workspace entry point', () => {
    const result = resolveViaWorkspace('@myorg/core', wsRoot);
    expect(result).toBe(path.join(wsRoot, 'packages', 'core', 'src', 'index.js'));
  });

  it('resolves root import for package without main (index fallback)', () => {
    const result = resolveViaWorkspace('@myorg/utils', wsRoot);
    expect(result).toBe(path.join(wsRoot, 'packages', 'utils', 'src', 'index.ts'));
  });

  it('resolves subpath import via filesystem probe', () => {
    const result = resolveViaWorkspace('@myorg/core/src/helpers', wsRoot);
    expect(result).toBe(path.join(wsRoot, 'packages', 'core', 'src', 'helpers.js'));
  });

  it('resolves subpath import via src/ convention', () => {
    const result = resolveViaWorkspace('@myorg/core/helpers', wsRoot);
    expect(result).toBe(path.join(wsRoot, 'packages', 'core', 'src', 'helpers.js'));
  });

  it('returns null for unknown package', () => {
    expect(resolveViaWorkspace('@myorg/unknown', wsRoot)).toBeNull();
  });

  it('returns null for non-existent subpath', () => {
    expect(resolveViaWorkspace('@myorg/core/nonexistent', wsRoot)).toBeNull();
  });
});

// ─── resolveImportPathJS with workspaces ─────────────────────────────

describe('resolveImportPathJS with workspace resolution', () => {
  let wsRoot: string;

  beforeAll(() => {
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ws-resolve-'));
    fs.mkdirSync(path.join(wsRoot, 'packages', 'lib', 'src'), { recursive: true });
    fs.mkdirSync(path.join(wsRoot, 'apps', 'web', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(wsRoot, 'packages', 'lib', 'src', 'index.js'),
      'export const add = (a, b) => a + b;',
    );
    fs.writeFileSync(
      path.join(wsRoot, 'packages', 'lib', 'package.json'),
      JSON.stringify({ name: '@myorg/lib', main: './src/index.js' }),
    );
    fs.writeFileSync(
      path.join(wsRoot, 'apps', 'web', 'src', 'app.js'),
      'import { add } from "@myorg/lib";',
    );

    setWorkspaces(
      wsRoot,
      new Map([
        [
          '@myorg/lib',
          {
            dir: path.join(wsRoot, 'packages', 'lib'),
            entry: path.join(wsRoot, 'packages', 'lib', 'src', 'index.js'),
          },
        ],
      ]),
    );
  });

  afterAll(() => {
    clearWorkspaceCache();
    if (wsRoot) fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  it('resolves workspace package import to source file', () => {
    const fromFile = path.join(wsRoot, 'apps', 'web', 'src', 'app.js');
    const result = resolveImportPathJS(fromFile, '@myorg/lib', wsRoot, null);
    expect(result).toBe('packages/lib/src/index.js');
  });

  it('marks workspace-resolved paths for confidence boost', () => {
    const fromFile = path.join(wsRoot, 'apps', 'web', 'src', 'app.js');
    clearWorkspaceCache();
    setWorkspaces(
      wsRoot,
      new Map([
        [
          '@myorg/lib',
          {
            dir: path.join(wsRoot, 'packages', 'lib'),
            entry: path.join(wsRoot, 'packages', 'lib', 'src', 'index.js'),
          },
        ],
      ]),
    );
    resolveImportPathJS(fromFile, '@myorg/lib', wsRoot, null);
    expect(isWorkspaceResolved('packages/lib/src/index.js')).toBe(true);
  });
});

// ─── computeConfidenceJS with workspace boost ────────────────────────

describe('computeConfidenceJS workspace confidence', () => {
  let wsRoot: string;

  beforeAll(() => {
    wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ws-conf-'));
    fs.mkdirSync(path.join(wsRoot, 'packages', 'lib', 'src'), { recursive: true });
    fs.mkdirSync(path.join(wsRoot, 'apps', 'web', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(wsRoot, 'packages', 'lib', 'src', 'index.js'),
      'export const x = 1;',
    );
    fs.writeFileSync(
      path.join(wsRoot, 'packages', 'lib', 'package.json'),
      JSON.stringify({ name: '@myorg/lib', main: './src/index.js' }),
    );
    fs.writeFileSync(path.join(wsRoot, 'apps', 'web', 'src', 'app.js'), 'import "@myorg/lib";');

    setWorkspaces(
      wsRoot,
      new Map([
        [
          '@myorg/lib',
          {
            dir: path.join(wsRoot, 'packages', 'lib'),
            entry: path.join(wsRoot, 'packages', 'lib', 'src', 'index.js'),
          },
        ],
      ]),
    );

    // Trigger resolution to populate _workspaceResolvedPaths
    const fromFile = path.join(wsRoot, 'apps', 'web', 'src', 'app.js');
    resolveImportPathJS(fromFile, '@myorg/lib', wsRoot, null);
  });

  afterAll(() => {
    clearWorkspaceCache();
    if (wsRoot) fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  it('returns 0.95 confidence for workspace-resolved imports', () => {
    const conf = computeConfidenceJS(
      'apps/web/src/app.js',
      'packages/lib/src/utils.js',
      'packages/lib/src/index.js',
    );
    expect(conf).toBe(0.95);
  });

  it('returns normal confidence for non-workspace imports', () => {
    const conf = computeConfidenceJS(
      'apps/web/src/app.js',
      'some/distant/file.js',
      'some/other/import.js',
    );
    expect(conf).toBeLessThan(0.95);
  });
});

// ─── Cross-language fallback rejection (#1783) ───────────────────────

// Regression tests for #1783: the global-by-name call-resolution fallback
// had no language-consistency check at all, so a bare-name call with no
// import/receiver match could resolve against a same-named symbol in a
// completely unrelated language — e.g. a Ruby file's builtin `Kernel#load`
// call matched a JS ESM loader hook's unrelated `load` export purely because
// both files sat in the same directory (confidence 0.7 from proximity alone).
describe('isSameLanguageFamily (#1783)', () => {
  it('returns false for a Ruby file and a JS file', () => {
    expect(isSameLanguageFamily('tracer/ruby-tracer.rb', 'tracer/loader-hooks.mjs')).toBe(false);
  });

  it('returns false for a Python file and a Go file', () => {
    expect(isSameLanguageFamily('src/main.py', 'src/main.go')).toBe(false);
  });

  it('returns true for two files with the same extension', () => {
    expect(isSameLanguageFamily('src/a.rb', 'lib/b.rb')).toBe(true);
  });

  it('treats JavaScript and TypeScript as the same family', () => {
    expect(isSameLanguageFamily('src/a.ts', 'src/b.js')).toBe(true);
    expect(isSameLanguageFamily('src/a.tsx', 'src/b.mjs')).toBe(true);
    expect(isSameLanguageFamily('src/a.cjs', 'src/b.jsx')).toBe(true);
  });

  it('treats C and its own header extension as the same family', () => {
    expect(isSameLanguageFamily('src/a.c', 'src/a.h')).toBe(true);
  });

  it('treats .h as ambiguous with C++ (Greptile follow-up)', () => {
    // `.h` is real-world ambiguous between C and C++ (LANGUAGE_REGISTRY
    // assigns it to C alone for grammar-selection purposes), so a `.cpp`
    // file calling into its own project's `.h` header must not be rejected
    // as cross-language.
    expect(isSameLanguageFamily('src/widget.cpp', 'src/widget.h')).toBe(true);
  });

  it('treats C++ source and header extensions as the same family', () => {
    expect(isSameLanguageFamily('src/a.cpp', 'src/a.hpp')).toBe(true);
    expect(isSameLanguageFamily('src/a.cc', 'src/a.cxx')).toBe(true);
  });

  it('does not treat C and C++ as the same family', () => {
    expect(isSameLanguageFamily('src/a.c', 'src/a.cpp')).toBe(false);
  });

  it('returns true (does not reject) when either extension is unrecognised', () => {
    expect(isSameLanguageFamily('README', 'src/b.rb')).toBe(true);
    expect(isSameLanguageFamily('src/a.rb', 'Makefile')).toBe(true);
  });
});

describe('computeConfidenceJS — cross-language rejection (#1783)', () => {
  it('returns 0 for same-directory files in different languages (the #1783 repro shape)', () => {
    // ruby-tracer.rb's bare `load` call must never match loader-hooks.mjs's
    // `load` export just because both files live in the same directory.
    const conf = computeConfidenceJS(
      'tests/benchmarks/resolution/tracer/ruby-tracer.rb',
      'tests/benchmarks/resolution/tracer/loader-hooks.mjs',
      undefined,
    );
    expect(conf).toBe(0);
  });

  it('still returns same-directory confidence for a same-language pair', () => {
    const conf = computeConfidenceJS(
      'tests/benchmarks/resolution/tracer/ruby-tracer.rb',
      'tests/benchmarks/resolution/tracer/other-tracer.rb',
      undefined,
    );
    expect(conf).toBe(0.7);
  });

  it('does not regress same-project JS/TS cross-file resolution', () => {
    // A .ts caller resolving a same-directory .js target must be unaffected —
    // TS/JS are one family despite being different LANGUAGE_REGISTRY entries.
    const conf = computeConfidenceJS('src/graph/a.ts', 'src/graph/b.js', undefined);
    expect(conf).toBe(0.7);
  });

  it('rejects a cross-language match even when same-file/importedFrom shortcuts do not apply', () => {
    const conf = computeConfidenceJS('src/main.py', 'src/main.go', undefined);
    expect(conf).toBeLessThan(0.5);
    expect(conf).toBe(0);
  });

  it('does not reject when the target extension is unrecognised (falls through to distance scoring)', () => {
    const conf = computeConfidenceJS('src/a.rb', 'src/README', undefined);
    expect(conf).toBeGreaterThan(0);
  });
});
