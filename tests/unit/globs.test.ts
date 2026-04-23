/**
 * Unit tests for src/shared/globs.ts — covers the memoization added so
 * long-running hosts (watch mode, MCP server) don't recompile include/exclude
 * globs on every buildGraph call.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { clearGlobCache, compileGlobs } from '../../src/shared/globs.js';

describe('compileGlobs', () => {
  afterEach(() => {
    clearGlobCache();
  });

  it('returns an empty list for undefined or empty input', () => {
    expect(compileGlobs(undefined)).toHaveLength(0);
    expect(compileGlobs([])).toHaveLength(0);
  });

  it('compiles each pattern to a RegExp anchored with ^…$', () => {
    const [inc, exc] = [compileGlobs(['src/**/*.ts']), compileGlobs(['**/*.test.ts'])];
    expect(inc).toHaveLength(1);
    expect(exc).toHaveLength(1);
    expect(inc[0]!.test('src/foo/bar.ts')).toBe(true);
    expect(inc[0]!.test('tests/foo.ts')).toBe(false);
    expect(exc[0]!.test('src/foo/bar.test.ts')).toBe(true);
    expect(exc[0]!.test('src/foo/bar.ts')).toBe(false);
  });

  it('reuses the same array for identical pattern lists (memoization)', () => {
    const first = compileGlobs(['src/**/*.ts', '**/*.test.ts']);
    const second = compileGlobs(['src/**/*.ts', '**/*.test.ts']);
    // Repeated calls with equivalent content return the exact same array — this is
    // what makes repeated buildGraph invocations in a long-running host cheap.
    expect(second).toBe(first);
  });

  it('treats different pattern lists as distinct cache entries', () => {
    const a = compileGlobs(['src/**/*.ts']);
    const b = compileGlobs(['src/**/*.js']);
    expect(a).not.toBe(b);
    expect(a[0]!.test('src/x.ts')).toBe(true);
    expect(b[0]!.test('src/x.js')).toBe(true);
    expect(a[0]!.test('src/x.js')).toBe(false);
  });

  it('treats different pattern orderings as distinct cache entries', () => {
    // Order matters for glob matching semantics (even if results are the same
    // set here, callers may rely on iteration order elsewhere). Two lists with
    // the same patterns in different orders get independent cache slots.
    const a = compileGlobs(['a/**', 'b/**']);
    const b = compileGlobs(['b/**', 'a/**']);
    expect(a).not.toBe(b);
  });

  it('returns a frozen array to prevent accidental mutation of cached values', () => {
    const patterns = compileGlobs(['src/**/*.ts']);
    expect(Object.isFrozen(patterns)).toBe(true);
  });

  it('clearGlobCache drops memoized entries', () => {
    const before = compileGlobs(['src/**/*.ts']);
    clearGlobCache();
    const after = compileGlobs(['src/**/*.ts']);
    // Same content, but cleared cache forces a fresh compilation → different
    // array identity. Test guards against silent cache leaks across suites.
    expect(after).not.toBe(before);
  });
});
