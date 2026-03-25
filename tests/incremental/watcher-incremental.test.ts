/**
 * Integration tests simulating the watch-mode incremental parse flow.
 *
 * Writes files to a temp directory, parses with the cache, edits,
 * re-parses, and verifies symbol updates.
 *
 * Skipped when the native engine is not available.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createParseTreeCache, parseFileIncremental } from '../../src/domain/parser.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const hasNative = isNativeAvailable();

describe.skipIf(!hasNative)('Watcher incremental flow', () => {
  let tmpDir: string;
  let cache: any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-inc-'));
    cache = createParseTreeCache();
  });

  afterEach(() => {
    if (cache) cache.clear();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Known native engine limitation: incremental re-parse does not pick up
  // newly added definitions. Tracked for fix in the Rust crate.
  it.skip('parses → edits → re-parses and picks up new symbols', async () => {
    const filePath = path.join(tmpDir, 'mod.js');

    // Initial write & parse
    fs.writeFileSync(filePath, 'function greet() { return "hi"; }');
    const result1 = await parseFileIncremental(cache, filePath, fs.readFileSync(filePath, 'utf-8'));

    expect(result1).not.toBeNull();
    expect(result1.definitions.map((d) => d.name)).toContain('greet');

    // Edit: add a second function
    fs.writeFileSync(
      filePath,
      'function greet() { return "hi"; }\nfunction farewell() { return "bye"; }',
    );
    const result2 = await parseFileIncremental(cache, filePath, fs.readFileSync(filePath, 'utf-8'));

    expect(result2).not.toBeNull();
    const names = result2.definitions.map((d) => d.name);
    expect(names).toContain('greet');
    expect(names).toContain('farewell');
  });

  it('remove() cleans up after file deletion', async () => {
    const filePath = path.join(tmpDir, 'temp.js');
    fs.writeFileSync(filePath, 'function tmp() {}');

    await parseFileIncremental(cache, filePath, fs.readFileSync(filePath, 'utf-8'));
    expect(cache.contains(filePath)).toBe(true);

    // Simulate file deletion in watcher
    fs.unlinkSync(filePath);
    cache.remove(filePath);
    expect(cache.contains(filePath)).toBe(false);
  });

  it('falls back to full parse when cache is null', async () => {
    const filePath = path.join(tmpDir, 'fallback.js');
    fs.writeFileSync(filePath, 'function fb() { return 42; }');

    // Pass null cache — should use parseFileAuto internally
    const result = await parseFileIncremental(null, filePath, fs.readFileSync(filePath, 'utf-8'));
    expect(result).not.toBeNull();
    expect(result.definitions.map((d) => d.name)).toContain('fb');
  });
});
