/**
 * Integration tests for `config.include` / `config.exclude` (issue #981).
 *
 * Verifies that top-level `include` / `exclude` globs in `.codegraphrc.json`
 * actually filter the files included in the build — and that both the native
 * Rust engine and the WASM/JS engine honor the filters identically.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { clearConfigCache } from '../../src/infrastructure/config.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE_FILES: Record<string, string> = {
  'src/math.js': `
export function add(a, b) { return a + b; }
export function multiply(a, b) { return a * b; }
`.trimStart(),
  'src/util.js': `
import { add } from './math.js';
export function doubleSum(a, b) { return add(a, b) + add(a, b); }
`.trimStart(),
  'src/math.test.js': `
import { add } from './math.js';
if (add(1, 2) !== 3) throw new Error('math broken');
`.trimStart(),
  'src/util.spec.js': `
import { doubleSum } from './util.js';
if (doubleSum(1, 2) !== 6) throw new Error('util broken');
`.trimStart(),
  'scratch/notes.js': `
export const scratch = 42;
`.trimStart(),
};

function writeFixture(root: string): void {
  for (const [relPath, content] of Object.entries(FIXTURE_FILES)) {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function readFileRows(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    // `file_hashes` is the authoritative list of files that actually passed
    // collection. `nodes.file` also contains synthetic directory/module rows.
    const rows = db.prepare('SELECT file FROM file_hashes ORDER BY file').all() as Array<{
      file: string;
    }>;
    return rows.map((r) => r.file).sort();
  } finally {
    db.close();
  }
}

type EngineName = 'native' | 'wasm';

async function buildWithEngine(
  root: string,
  engine: EngineName,
  config: { include?: string[]; exclude?: string[] },
): Promise<string[]> {
  fs.writeFileSync(path.join(root, '.codegraphrc.json'), JSON.stringify(config));
  // `loadConfig` caches per cwd — blow the cache so each test's config is
  // actually re-read from disk.
  clearConfigCache();
  // Wipe DB between runs so file list is authoritative.
  const dbDir = path.join(root, '.codegraph');
  if (fs.existsSync(dbDir)) fs.rmSync(dbDir, { recursive: true, force: true });
  await buildGraph(root, { engine, skipRegistry: true });
  const files = readFileRows(path.join(dbDir, 'graph.db'));
  // `file_hashes` stores relative paths; normalize slashes so assertions are
  // cross-platform.
  return files.map((f) => f.replace(/\\/g, '/')).sort();
}

describe('config.include / config.exclude (issue #981)', () => {
  let tmpDir: string;
  let wasmRoot: string;
  let nativeRoot: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cfg-inc-exc-'));
    wasmRoot = fs.mkdtempSync(path.join(tmpDir, 'wasm-'));
    nativeRoot = fs.mkdtempSync(path.join(tmpDir, 'native-'));
    writeFixture(wasmRoot);
    writeFixture(nativeRoot);
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── wasm engine ───────────────────────────────────────────────────

  it('wasm: exclude glob rejects matching files', async () => {
    const files = await buildWithEngine(wasmRoot, 'wasm', {
      exclude: ['**/*.test.js', '**/*.spec.js'],
    });
    expect(files).toContain('src/math.js');
    expect(files).toContain('src/util.js');
    expect(files).not.toContain('src/math.test.js');
    expect(files).not.toContain('src/util.spec.js');
  });

  it('wasm: include glob limits collection to matching files', async () => {
    const files = await buildWithEngine(wasmRoot, 'wasm', {
      include: ['src/**'],
    });
    // scratch/ is outside src/, so nothing from it should be included
    expect(files.some((f) => f.startsWith('scratch/'))).toBe(false);
    expect(files).toContain('src/math.js');
  });

  it('wasm: include + exclude combine (include first, exclude trims)', async () => {
    const files = await buildWithEngine(wasmRoot, 'wasm', {
      include: ['src/**'],
      exclude: ['**/*.test.js', '**/*.spec.js'],
    });
    expect(files).toContain('src/math.js');
    expect(files).toContain('src/util.js');
    expect(files).not.toContain('src/math.test.js');
    expect(files).not.toContain('src/util.spec.js');
    expect(files.some((f) => f.startsWith('scratch/'))).toBe(false);
  });

  it('wasm: empty include/exclude preserves prior behavior (collects everything supported)', async () => {
    const files = await buildWithEngine(wasmRoot, 'wasm', {});
    expect(files).toContain('src/math.js');
    expect(files).toContain('src/math.test.js');
    expect(files).toContain('src/util.spec.js');
    expect(files).toContain('scratch/notes.js');
  });

  // ── native engine (skipped when not installed) ───────────────────

  const nativeAvailable = isNativeAvailable();
  const itNative = nativeAvailable ? it : it.skip;

  itNative('native: exclude glob rejects matching files', async () => {
    const files = await buildWithEngine(nativeRoot, 'native', {
      exclude: ['**/*.test.js', '**/*.spec.js'],
    });
    expect(files).toContain('src/math.js');
    expect(files).toContain('src/util.js');
    expect(files).not.toContain('src/math.test.js');
    expect(files).not.toContain('src/util.spec.js');
  });

  itNative('native: include glob limits collection to matching files', async () => {
    const files = await buildWithEngine(nativeRoot, 'native', {
      include: ['src/**'],
    });
    expect(files.some((f) => f.startsWith('scratch/'))).toBe(false);
    expect(files).toContain('src/math.js');
  });

  // ── engine parity ────────────────────────────────────────────────

  itNative('native + wasm produce identical file sets under include/exclude', async () => {
    const parityWasm = fs.mkdtempSync(path.join(tmpDir, 'parity-wasm-'));
    const parityNative = fs.mkdtempSync(path.join(tmpDir, 'parity-native-'));
    writeFixture(parityWasm);
    writeFixture(parityNative);

    const cfg = {
      include: ['src/**'],
      exclude: ['**/*.test.js', '**/*.spec.js'],
    };
    const wasmFiles = await buildWithEngine(parityWasm, 'wasm', cfg);
    const nativeFiles = await buildWithEngine(parityNative, 'native', cfg);
    // Paths are already relative to each run's own tmpDir so they compare directly.
    expect(nativeFiles).toEqual(wasmFiles);
  });

  // ── opts.exclude (programmatic, no on-disk config) ───────────────

  async function buildWithOptsExclude(
    root: string,
    engine: EngineName,
    optsExclude: string[],
  ): Promise<string[]> {
    clearConfigCache();
    const dbDir = path.join(root, '.codegraph');
    if (fs.existsSync(dbDir)) fs.rmSync(dbDir, { recursive: true, force: true });
    await buildGraph(root, { engine, exclude: optsExclude, skipRegistry: true });
    const files = readFileRows(path.join(dbDir, 'graph.db'));
    return files.map((f) => f.replace(/\\/g, '/')).sort();
  }

  it('wasm: opts.exclude rejects matching files without writing config', async () => {
    const root = fs.mkdtempSync(path.join(tmpDir, 'opts-wasm-'));
    writeFixture(root);
    const files = await buildWithOptsExclude(root, 'wasm', ['**/*.test.js', '**/*.spec.js']);
    expect(files).toContain('src/math.js');
    expect(files).not.toContain('src/math.test.js');
    expect(files).not.toContain('src/util.spec.js');
  });

  itNative('native: opts.exclude rejects matching files without writing config', async () => {
    const root = fs.mkdtempSync(path.join(tmpDir, 'opts-native-'));
    writeFixture(root);
    const files = await buildWithOptsExclude(root, 'native', ['**/*.test.js', '**/*.spec.js']);
    expect(files).toContain('src/math.js');
    expect(files).not.toContain('src/math.test.js');
    expect(files).not.toContain('src/util.spec.js');
  });

  // ── opts.exclude incremental round trip ──────────────────────────
  //
  // Greptile feedback on PR #1134: the opts.exclude tests above always wipe
  // the DB before building, so they only exercise the fresh-build path. The
  // scenario where files that were previously indexed become excluded on a
  // subsequent incremental run (i.e. opts.exclude changes between builds
  // against the same DB) was untested. This round trip locks in the
  // collect → detect behaviour: the second build must observe the newly
  // excluded files as removals and drop them from file_hashes.

  async function buildSameDb(
    root: string,
    engine: EngineName,
    optsExclude: string[] | undefined,
  ): Promise<string[]> {
    clearConfigCache();
    await buildGraph(root, {
      engine,
      ...(optsExclude !== undefined ? { exclude: optsExclude } : {}),
      skipRegistry: true,
    });
    const files = readFileRows(path.join(root, '.codegraph', 'graph.db'));
    return files.map((f) => f.replace(/\\/g, '/')).sort();
  }

  it('wasm: opts.exclude introduced on second incremental build drops previously-indexed files', async () => {
    const root = fs.mkdtempSync(path.join(tmpDir, 'opts-inc-wasm-'));
    writeFixture(root);
    // Wipe DB so the first build is a clean baseline that indexes everything.
    const dbDir = path.join(root, '.codegraph');
    if (fs.existsSync(dbDir)) fs.rmSync(dbDir, { recursive: true, force: true });

    // First build: no exclude — every supported file is indexed.
    const firstFiles = await buildSameDb(root, 'wasm', undefined);
    expect(firstFiles).toContain('src/math.test.js');
    expect(firstFiles).toContain('src/util.spec.js');

    // Second build against the same DB with exclude — previously-indexed
    // test files must be detected as removals and disappear from file_hashes.
    const secondFiles = await buildSameDb(root, 'wasm', ['**/*.test.js', '**/*.spec.js']);
    expect(secondFiles).toContain('src/math.js');
    expect(secondFiles).toContain('src/util.js');
    expect(secondFiles).not.toContain('src/math.test.js');
    expect(secondFiles).not.toContain('src/util.spec.js');
  });

  itNative(
    'native: opts.exclude introduced on second incremental build drops previously-indexed files',
    async () => {
      const root = fs.mkdtempSync(path.join(tmpDir, 'opts-inc-native-'));
      writeFixture(root);
      const dbDir = path.join(root, '.codegraph');
      if (fs.existsSync(dbDir)) fs.rmSync(dbDir, { recursive: true, force: true });

      const firstFiles = await buildSameDb(root, 'native', undefined);
      expect(firstFiles).toContain('src/math.test.js');
      expect(firstFiles).toContain('src/util.spec.js');

      const secondFiles = await buildSameDb(root, 'native', ['**/*.test.js', '**/*.spec.js']);
      expect(secondFiles).toContain('src/math.js');
      expect(secondFiles).toContain('src/util.js');
      expect(secondFiles).not.toContain('src/math.test.js');
      expect(secondFiles).not.toContain('src/util.spec.js');
    },
  );
});
