/**
 * Unit tests for src/constants.js
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXTENSIONS,
  IGNORE_DIRS,
  isSupportedFile,
  normalizePath,
  shouldIgnore,
} from '../../src/shared/constants.js';

describe('EXTENSIONS', () => {
  it('contains known supported extensions', () => {
    const expected = [
      '.js',
      '.jsx',
      '.ts',
      '.tsx',
      '.mjs',
      '.cjs',
      '.tf',
      '.hcl',
      '.py',
      '.go',
      '.rs',
      '.java',
      '.cs',
      '.rb',
      '.php',
    ];
    for (const ext of expected) {
      expect(EXTENSIONS.has(ext)).toBe(true);
    }
  });

  it('is a non-empty Set', () => {
    expect(EXTENSIONS).toBeInstanceOf(Set);
    expect(EXTENSIONS.size).toBeGreaterThan(0);
  });
});

describe('IGNORE_DIRS', () => {
  it('contains expected directory names', () => {
    const expected = ['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__', 'vendor'];
    for (const dir of expected) {
      expect(IGNORE_DIRS.has(dir)).toBe(true);
    }
  });
});

describe('shouldIgnore', () => {
  it('returns true for node_modules', () => {
    expect(shouldIgnore('node_modules')).toBe(true);
  });

  it('returns true for .git', () => {
    expect(shouldIgnore('.git')).toBe(true);
  });

  it('returns true for hidden directories (dot prefix)', () => {
    expect(shouldIgnore('.hidden')).toBe(true);
    expect(shouldIgnore('.cache')).toBe(true);
  });

  it('returns false for normal directories', () => {
    expect(shouldIgnore('src')).toBe(false);
    expect(shouldIgnore('lib')).toBe(false);
    expect(shouldIgnore('tests')).toBe(false);
  });
});

describe('isSupportedFile', () => {
  it('returns true for supported extensions', () => {
    expect(isSupportedFile('foo.js')).toBe(true);
    expect(isSupportedFile('bar.ts')).toBe(true);
    expect(isSupportedFile('baz.py')).toBe(true);
    expect(isSupportedFile('main.go')).toBe(true);
    expect(isSupportedFile('lib.rs')).toBe(true);
  });

  it('returns false for unsupported extensions', () => {
    expect(isSupportedFile('foo.txt')).toBe(false);
    expect(isSupportedFile('bar.css')).toBe(false);
    expect(isSupportedFile('baz.md')).toBe(false);
    expect(isSupportedFile('image.png')).toBe(false);
  });
});

describe('normalizePath', () => {
  it('normalizes platform separators to forward slashes', () => {
    // Build a path using the OS-native separator
    const native = ['src', 'lib', 'utils.js'].join(path.sep);
    expect(normalizePath(native)).toBe('src/lib/utils.js');
  });

  it('leaves forward slashes unchanged', () => {
    expect(normalizePath('src/lib/utils.js')).toBe('src/lib/utils.js');
  });

  it('handles empty string', () => {
    expect(normalizePath('')).toBe('');
  });
});
