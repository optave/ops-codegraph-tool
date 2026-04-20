/**
 * Tests for WASM-path error hardening in wasmExtractSymbols.
 *
 * If an extractor throws on a single file (e.g. due to a bug on pathological input
 * or a corrupted tree from a WASM parse trap), the whole build must NOT crash —
 * the file is skipped with a warn() and parsing continues for the remaining files.
 *
 * Related: issue #965 (WASM extractor hardening on Windows + Node 22).
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANGUAGE_REGISTRY, parseFileAuto, parseFilesAuto } from '../../src/domain/parser.js';

describe('WASM extractor hardening (issue #965)', () => {
  const jsEntry = LANGUAGE_REGISTRY.find((e) => e.id === 'javascript');
  if (!jsEntry) throw new Error('JavaScript language entry not found in LANGUAGE_REGISTRY');

  const originalExtractor = jsEntry.extractor;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Capture warn() output (writes to process.stderr.write).
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    // Always restore the original extractor, even if a test fails.
    jsEntry.extractor = originalExtractor;
    stderrSpy.mockRestore();
  });

  it('returns null and emits a warn when the extractor throws (single-file path)', async () => {
    jsEntry.extractor = () => {
      throw new Error('simulated extractor failure');
    };

    const symbols = await parseFileAuto('boom.js', 'function hello() {}', { engine: 'wasm' });

    expect(symbols).toBeNull();

    const warnings = stderrSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes('[codegraph WARN]'));
    expect(warnings.some((w) => w.includes('boom.js'))).toBe(true);
    expect(warnings.some((w) => w.includes('simulated extractor failure'))).toBe(true);
    expect(warnings.some((w) => /skipping/i.test(w))).toBe(true);
  });

  it('skips the failing file but continues parsing the rest of the batch', async () => {
    const fixtureDir = path.resolve('tests/fixtures/sample-project');
    const goodFile1 = path.join(fixtureDir, 'math.js');
    const goodFile2 = path.join(fixtureDir, 'utils.js');
    const poisonedFile = path.join(fixtureDir, 'index.js');

    // Throw only for the poisoned file; run the real extractor otherwise.
    jsEntry.extractor = (tree, filePath, query) => {
      if (filePath === poisonedFile) {
        throw new Error('simulated WASM extractor trap');
      }
      return originalExtractor(tree, filePath, query);
    };

    const result = await parseFilesAuto([goodFile1, goodFile2, poisonedFile], fixtureDir, {
      engine: 'wasm',
    });

    expect(result).toBeInstanceOf(Map);
    // Two good files parsed successfully; the poisoned file was skipped.
    expect(result.size).toBe(2);
    expect(result.has('math.js')).toBe(true);
    expect(result.has('utils.js')).toBe(true);
    expect(result.has('index.js')).toBe(false);

    const warnings = stderrSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes('[codegraph WARN]'));
    expect(warnings.some((w) => w.includes('index.js'))).toBe(true);
    expect(warnings.some((w) => w.includes('simulated WASM extractor trap'))).toBe(true);
  });

  it('still reports parse errors (pre-existing hardening) without killing the build', async () => {
    const fixtureDir = path.resolve('tests/fixtures/sample-project');
    const goodFile = path.join(fixtureDir, 'math.js');
    const poisonedFile = path.join(fixtureDir, 'utils.js');

    // Simulate an error path that surfaces via the extractor (catchable) —
    // confirms parseFilesWasm continues across the batch rather than aborting.
    jsEntry.extractor = (tree, filePath, query) => {
      if (filePath === poisonedFile) {
        throw new TypeError("Cannot read properties of undefined (reading 'toLowerCase')");
      }
      return originalExtractor(tree, filePath, query);
    };

    const result = await parseFilesAuto([poisonedFile, goodFile], fixtureDir, { engine: 'wasm' });

    expect(result.size).toBe(1);
    expect(result.has('math.js')).toBe(true);
  });
});
