import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getNative, isNativeAvailable } from '../../src/infrastructure/native.js';
import type { NativeDatabase } from '../../src/types.js';

const hasNativeDb =
  isNativeAvailable() && typeof getNative().NativeDatabase?.prototype?.queryAll === 'function';

describe.skipIf(!hasNativeDb)('NativeDatabase.queryAll / queryGet', () => {
  let nativeDb: NativeDatabase;
  let dbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-query-'));
    dbPath = path.join(tmpDir, 'test.db');
    const NativeDB = getNative().NativeDatabase;
    nativeDb = NativeDB.openReadWrite(dbPath);
    nativeDb.initSchema();

    // Seed test data
    nativeDb.exec(`
      INSERT INTO nodes (name, kind, file, line, role) VALUES ('foo', 'function', 'src/foo.js', 1, 'core');
      INSERT INTO nodes (name, kind, file, line, role) VALUES ('bar', 'method', 'src/bar.js', 10, 'utility');
      INSERT INTO nodes (name, kind, file, line, role) VALUES ('Baz', 'class', 'src/baz.js', 20, 'entry');
    `);
  });

  afterEach(() => {
    nativeDb.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('returns all rows with correct column names', () => {
    const rows = nativeDb.queryAll('SELECT name, kind FROM nodes ORDER BY name', []);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ name: 'Baz', kind: 'class' });
    expect(rows[1]).toEqual({ name: 'bar', kind: 'method' });
    expect(rows[2]).toEqual({ name: 'foo', kind: 'function' });
  });

  it('returns empty array for no matches', () => {
    const rows = nativeDb.queryAll("SELECT * FROM nodes WHERE name = 'nope'", []);
    expect(rows).toEqual([]);
  });

  it('handles string parameters', () => {
    const rows = nativeDb.queryAll('SELECT name FROM nodes WHERE kind = ?', ['function']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ name: 'foo' });
  });

  it('handles number parameters', () => {
    const rows = nativeDb.queryAll('SELECT name FROM nodes WHERE line > ?', [5]);
    expect(rows).toHaveLength(2);
  });

  it('handles null parameters', () => {
    nativeDb.exec(
      "INSERT INTO nodes (name, kind, file, line, role) VALUES ('orphan', 'function', 'x.js', 1, NULL)",
    );
    const rows = nativeDb.queryAll('SELECT name FROM nodes WHERE role IS NULL', []);
    expect(rows.some((r) => r.name === 'orphan')).toBe(true);
  });

  it('handles multiple parameters', () => {
    const rows = nativeDb.queryAll('SELECT name FROM nodes WHERE kind = ? AND line >= ?', [
      'method',
      10,
    ]);
    expect(rows).toEqual([{ name: 'bar' }]);
  });

  it('returns null columns as null', () => {
    nativeDb.exec(
      "INSERT INTO nodes (name, kind, file, line, role) VALUES ('nul', 'function', 'x.js', 1, NULL)",
    );
    const rows = nativeDb.queryAll("SELECT role FROM nodes WHERE name = 'nul'", []);
    expect(rows[0]!.role).toBeNull();
  });

  it('handles integer and real column types', () => {
    const row = nativeDb.queryGet('SELECT 42 AS int_val, 3.14 AS real_val', []);
    expect(row).toBeDefined();
    expect(row!.int_val).toBe(42);
    expect(row!.real_val).toBeCloseTo(3.14);
  });

  // -- queryGet --

  it('queryGet returns first row', () => {
    const row = nativeDb.queryGet('SELECT name FROM nodes ORDER BY name LIMIT 1', []);
    expect(row).toEqual({ name: 'Baz' });
  });

  it('queryGet returns null for no matches', () => {
    const row = nativeDb.queryGet("SELECT * FROM nodes WHERE name = 'nope'", []);
    expect(row).toBeNull();
  });

  it('queryGet with parameters', () => {
    const row = nativeDb.queryGet('SELECT name, line FROM nodes WHERE kind = ?', ['class']);
    expect(row).toEqual({ name: 'Baz', line: 20 });
  });

  // -- Error handling --

  it('throws on invalid SQL', () => {
    expect(() => nativeDb.queryAll('SELECT * FROM nonexistent_table', [])).toThrow();
  });

  it('throws on closed database', () => {
    nativeDb.close();
    expect(() => nativeDb.queryAll('SELECT 1', [])).toThrow(/closed/i);
  });
});
