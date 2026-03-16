import { describe, expect, test, vi } from 'vitest';
import { normalizeSymbol } from '../../src/domain/queries.js';

describe('normalizeSymbol', () => {
  test('full row with all fields', () => {
    const row = {
      name: 'foo',
      kind: 'function',
      file: 'src/bar.js',
      line: 10,
      end_line: 20,
      role: 'core',
    };
    const db = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({ hash: 'abc123' }),
      }),
    };
    const result = normalizeSymbol(row, db);
    expect(result).toEqual({
      name: 'foo',
      kind: 'function',
      file: 'src/bar.js',
      line: 10,
      endLine: 20,
      role: 'core',
      fileHash: 'abc123',
    });
  });

  test('minimal row defaults endLine, role, fileHash to null', () => {
    const row = { name: 'bar', kind: 'method', file: 'a.js', line: 1 };
    const result = normalizeSymbol(row, null);
    expect(result).toEqual({
      name: 'bar',
      kind: 'method',
      file: 'a.js',
      line: 1,
      endLine: null,
      role: null,
      fileHash: null,
    });
  });

  test('prefers end_line over endLine (raw SQLite column)', () => {
    const row = {
      name: 'baz',
      kind: 'class',
      file: 'b.js',
      line: 5,
      end_line: 50,
      endLine: 99,
    };
    const result = normalizeSymbol(row, null);
    expect(result.endLine).toBe(50);
  });

  test('falls back to endLine when end_line is undefined', () => {
    const row = {
      name: 'baz',
      kind: 'class',
      file: 'b.js',
      line: 5,
      endLine: 99,
    };
    const result = normalizeSymbol(row, null);
    expect(result.endLine).toBe(99);
  });

  test('db = null yields fileHash = null', () => {
    const row = { name: 'x', kind: 'function', file: 'c.js', line: 1, end_line: 10, role: 'leaf' };
    const result = normalizeSymbol(row, null);
    expect(result.fileHash).toBeNull();
  });

  test('hashCache reuses result for same file', () => {
    const getSpy = vi.fn().mockReturnValue({ hash: 'h1' });
    const db = { prepare: vi.fn().mockReturnValue({ get: getSpy }) };
    const hc = new Map();

    const row1 = { name: 'a', kind: 'function', file: 'x.js', line: 1 };
    const row2 = { name: 'b', kind: 'function', file: 'x.js', line: 10 };

    normalizeSymbol(row1, db, hc);
    normalizeSymbol(row2, db, hc);

    // DB was queried only once for x.js
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(hc.get('x.js')).toBe('h1');
  });

  test('hashCache queries once per unique file', () => {
    const getSpy = vi.fn((file) => (file === 'a.js' ? { hash: 'ha' } : { hash: 'hb' }));
    const db = { prepare: vi.fn().mockReturnValue({ get: getSpy }) };
    const hc = new Map();

    normalizeSymbol({ name: 'x', kind: 'function', file: 'a.js', line: 1 }, db, hc);
    normalizeSymbol({ name: 'y', kind: 'function', file: 'b.js', line: 1 }, db, hc);
    normalizeSymbol({ name: 'z', kind: 'function', file: 'a.js', line: 5 }, db, hc);

    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  test('file with no hash returns fileHash null', () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue(undefined),
      }),
    };
    const row = { name: 'x', kind: 'function', file: 'missing.js', line: 1 };
    const result = normalizeSymbol(row, db);
    expect(result.fileHash).toBeNull();
  });
});
