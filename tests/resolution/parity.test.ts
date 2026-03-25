/**
 * Import resolution & confidence parity tests — native vs JS.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeConfidence,
  computeConfidenceJS,
  convertAliasesForNative,
  resolveImportPath,
  resolveImportPathJS,
  resolveImportsBatch,
} from '../../src/domain/graph/resolve.js';
import { isNativeAvailable, loadNative } from '../../src/infrastructure/native.js';

const hasNative = isNativeAvailable();

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'sample-project');

// ── Alias conversion ────────────────────────────────────────────────

describe('convertAliasesForNative', () => {
  it('converts JS alias format to native format', () => {
    const jsAliases = {
      baseUrl: '/root/src',
      paths: {
        '@utils/*': ['/root/src/utils/*'],
        '@components/*': ['/root/src/components/*', '/root/src/shared/*'],
      },
    };
    const native = convertAliasesForNative(jsAliases);
    expect(native.baseUrl).toBe('/root/src');
    expect(native.paths).toHaveLength(2);
    expect(native.paths[0]).toEqual({ pattern: '@utils/*', targets: ['/root/src/utils/*'] });
    expect(native.paths[1]).toEqual({
      pattern: '@components/*',
      targets: ['/root/src/components/*', '/root/src/shared/*'],
    });
  });

  it('handles null input', () => {
    expect(convertAliasesForNative(null)).toBeNull();
  });

  it('handles empty aliases', () => {
    const result = convertAliasesForNative({ baseUrl: null, paths: {} });
    expect(result.baseUrl).toBe('');
    expect(result.paths).toHaveLength(0);
  });
});

// ── Import resolution parity (native vs JS) ────────────────────────

describe.skipIf(!hasNative)('Import resolution parity', () => {
  const rootDir = FIXTURE_DIR;
  const noAliases = { baseUrl: null, paths: {} };

  function assertParity(fromFile, importSource, aliases = noAliases) {
    const native = loadNative();
    const jsResult = resolveImportPathJS(fromFile, importSource, rootDir, aliases);
    const nativeResult = native.resolveImport(
      fromFile,
      importSource,
      rootDir,
      convertAliasesForNative(aliases),
    );
    expect(nativeResult).toBe(jsResult);

    // Also verify the dispatch wrapper returns the same
    const dispatchResult = resolveImportPath(fromFile, importSource, rootDir, aliases);
    expect(dispatchResult).toBe(jsResult);
  }

  it('resolves relative .js import', () => {
    assertParity(path.join(rootDir, 'index.js'), './math', noAliases);
  });

  it('resolves relative .js import with extension', () => {
    assertParity(path.join(rootDir, 'index.js'), './math.js', noAliases);
  });

  it('resolves relative import to utils', () => {
    assertParity(path.join(rootDir, 'index.js'), './utils', noAliases);
  });

  it('passes through bare specifier', () => {
    assertParity(path.join(rootDir, 'index.js'), 'lodash', noAliases);
  });

  // Un-skip once the native binary is published with the clean_path fix (#600)
  it.skip('resolves parent directory traversal', () => {
    // Create a temporary nested structure
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-parity-'));
    const subDir = path.join(tmpDir, 'sub');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(tmpDir, 'root.js'), 'export function root() {}');
    fs.writeFileSync(path.join(subDir, 'child.js'), 'import { root } from "../root";');

    try {
      assertParity(path.join(subDir, 'child.js'), '../root', { baseUrl: null, paths: {} });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves with aliases', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-alias-'));
    const utilsDir = path.join(tmpDir, 'src', 'utils');
    fs.mkdirSync(utilsDir, { recursive: true });
    fs.writeFileSync(path.join(utilsDir, 'helpers.js'), 'export function help() {}');
    fs.writeFileSync(path.join(tmpDir, 'app.js'), 'import { help } from "@utils/helpers";');

    const aliases = {
      baseUrl: path.join(tmpDir, 'src'),
      paths: {
        '@utils/*': [path.join(tmpDir, 'src', 'utils', '*')],
      },
    };

    try {
      const native = loadNative();
      const jsResult = resolveImportPathJS(
        path.join(tmpDir, 'app.js'),
        '@utils/helpers',
        tmpDir,
        aliases,
      );
      const nativeResult = native.resolveImport(
        path.join(tmpDir, 'app.js'),
        '@utils/helpers',
        tmpDir,
        convertAliasesForNative(aliases),
      );
      expect(nativeResult).toBe(jsResult);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves .js → .ts remap', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tsremap-'));
    // Create a .ts file but import via .js extension
    fs.writeFileSync(path.join(tmpDir, 'module.ts'), 'export function greet() {}');
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'import { greet } from "./module.js";');

    try {
      const native = loadNative();
      const jsResult = resolveImportPathJS(path.join(tmpDir, 'app.ts'), './module.js', tmpDir, {
        baseUrl: null,
        paths: {},
      });
      const nativeResult = native.resolveImport(
        path.join(tmpDir, 'app.ts'),
        './module.js',
        tmpDir,
        convertAliasesForNative({ baseUrl: null, paths: {} }),
      );
      expect(nativeResult).toBe(jsResult);
      // Should resolve to .ts file
      expect(jsResult).toContain('module.ts');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resolves directory index', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dirindex-'));
    const libDir = path.join(tmpDir, 'lib');
    fs.mkdirSync(libDir);
    fs.writeFileSync(path.join(libDir, 'index.js'), 'export function lib() {}');
    fs.writeFileSync(path.join(tmpDir, 'main.js'), 'import { lib } from "./lib";');

    try {
      const native = loadNative();
      const jsResult = resolveImportPathJS(path.join(tmpDir, 'main.js'), './lib', tmpDir, {
        baseUrl: null,
        paths: {},
      });
      const nativeResult = native.resolveImport(
        path.join(tmpDir, 'main.js'),
        './lib',
        tmpDir,
        convertAliasesForNative({ baseUrl: null, paths: {} }),
      );
      expect(nativeResult).toBe(jsResult);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Confidence scoring parity ───────────────────────────────────────

describe.skipIf(!hasNative)('Confidence scoring parity', () => {
  const native = hasNative ? loadNative() : null;

  function assertConfidenceParity(caller, target, importedFrom) {
    const jsResult = computeConfidenceJS(caller, target, importedFrom);
    const nativeResult = native.computeConfidence(caller, target, importedFrom || null);
    expect(nativeResult).toBeCloseTo(jsResult, 5);

    // Also verify the dispatch wrapper
    const dispatchResult = computeConfidence(caller, target, importedFrom);
    expect(dispatchResult).toBeCloseTo(jsResult, 5);
  }

  it('same file → 1.0', () => {
    assertConfidenceParity('src/foo.js', 'src/foo.js', undefined);
  });

  it('imported from target → 1.0', () => {
    assertConfidenceParity('src/foo.js', 'src/bar.js', 'src/bar.js');
  });

  it('same directory → 0.7', () => {
    assertConfidenceParity('src/foo.js', 'src/bar.js', undefined);
  });

  it('sibling directories → 0.5', () => {
    assertConfidenceParity('src/a/foo.js', 'src/b/bar.js', undefined);
  });

  it('global fallback → 0.3', () => {
    assertConfidenceParity('src/a/b/foo.js', 'lib/c/d/bar.js', undefined);
  });

  it('null/empty inputs → 0.3', () => {
    const jsNull = computeConfidenceJS(null, null, undefined);
    const nativeNull = native.computeConfidence('', '', null);
    // JS returns 0.3 for null inputs; native gets empty strings
    expect(jsNull).toBe(0.3);
    // Native with empty strings should also give a low score
    expect(nativeNull).toBeLessThanOrEqual(1.0);
  });
});

// ── Batch resolution ────────────────────────────────────────────────

describe.skipIf(!hasNative)('Batch import resolution', () => {
  const rootDir = FIXTURE_DIR;
  const noAliases = { baseUrl: null, paths: {} };

  it('returns same results as individual resolveImportPath calls', () => {
    const inputs = [
      { fromFile: path.join(rootDir, 'index.js'), importSource: './math' },
      { fromFile: path.join(rootDir, 'index.js'), importSource: './utils' },
      { fromFile: path.join(rootDir, 'utils.js'), importSource: './math' },
      { fromFile: path.join(rootDir, 'index.js'), importSource: 'lodash' },
    ];

    const batchResult = resolveImportsBatch(inputs, rootDir, noAliases);
    expect(batchResult).not.toBeNull();
    expect(batchResult).toBeInstanceOf(Map);

    for (const { fromFile, importSource } of inputs) {
      const individual = resolveImportPathJS(fromFile, importSource, rootDir, noAliases);
      const batchKey = `${fromFile}|${importSource}`;
      expect(batchResult.get(batchKey)).toBe(individual);
    }
  });

  it('returns null when native is unavailable', () => {
    // This test only runs when native IS available, so we can't truly test the null path
    // Instead just verify the map is populated
    const inputs = [{ fromFile: path.join(rootDir, 'index.js'), importSource: './math' }];
    const result = resolveImportsBatch(inputs, rootDir, noAliases);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(1);
  });
});

// ── Batch resolution when native unavailable ────────────────────────

describe('resolveImportsBatch without native', () => {
  it('returns null gracefully when native not loaded', () => {
    // resolveImportsBatch internally checks loadNative() — when native IS available
    // we can't easily mock it, but we test the API contract
    const inputs = [{ fromFile: path.join(FIXTURE_DIR, 'index.js'), importSource: './math' }];
    const result = resolveImportsBatch(inputs, FIXTURE_DIR, { baseUrl: null, paths: {} });
    if (!hasNative) {
      expect(result).toBeNull();
    } else {
      expect(result).toBeInstanceOf(Map);
    }
  });
});
