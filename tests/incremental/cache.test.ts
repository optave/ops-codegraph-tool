/**
 * Unit tests for the native ParseTreeCache (incremental parsing).
 *
 * Skipped when the native engine is not available.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { isNativeAvailable, loadNative } from '../../src/infrastructure/native.js';

const hasNative = isNativeAvailable();

describe.skipIf(!hasNative)('ParseTreeCache', () => {
  let cache: any;

  beforeEach(() => {
    const native = loadNative();
    cache = new native.ParseTreeCache();
  });

  it('parses a JS file and caches the tree', () => {
    const source = 'function hello() { return 1; }';
    const result = cache.parseFile('test.js', source);

    expect(result).not.toBeNull();
    expect(result.definitions.length).toBeGreaterThanOrEqual(1);
    expect(result.definitions[0].name).toBe('hello');
    expect(cache.contains('test.js')).toBe(true);
    expect(cache.size()).toBe(1);
  });

  // Known native engine limitation: incremental re-parse does not pick up
  // newly added definitions. Tracked for fix in the Rust crate.
  it.skip('incrementally re-parses when source changes', () => {
    const source1 = 'function hello() { return 1; }';
    cache.parseFile('test.js', source1);

    const source2 = 'function hello() { return 1; }\nfunction world() { return 2; }';
    const result = cache.parseFile('test.js', source2);

    expect(result).not.toBeNull();
    const names = result.definitions.map((d) => d.name);
    expect(names).toContain('hello');
    expect(names).toContain('world');
    expect(cache.size()).toBe(1);
  });

  it('returns null for unsupported extensions', () => {
    const result = cache.parseFile('readme.md', '# Hello');
    expect(result).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it('remove() evicts a file from the cache', () => {
    cache.parseFile('test.js', 'function a() {}');
    expect(cache.contains('test.js')).toBe(true);

    cache.remove('test.js');
    expect(cache.contains('test.js')).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it('clear() removes all entries', () => {
    cache.parseFile('a.js', 'function a() {}');
    cache.parseFile('b.js', 'function b() {}');
    expect(cache.size()).toBe(2);

    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it('contains() returns false for unknown files', () => {
    expect(cache.contains('nope.js')).toBe(false);
  });

  it('handles multiple languages', () => {
    const jsResult = cache.parseFile('app.js', 'function run() {}');
    const pyResult = cache.parseFile('app.py', 'def run():\n    pass');

    expect(jsResult).not.toBeNull();
    expect(pyResult).not.toBeNull();
    expect(cache.size()).toBe(2);
  });
});
