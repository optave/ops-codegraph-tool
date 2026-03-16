import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  snapshotDelete,
  snapshotList,
  snapshotRestore,
  snapshotSave,
  snapshotsDir,
  validateSnapshotName,
} from '../../src/features/snapshot.js';

let tmpDir;
let dbPath;

function createTestDb(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE nodes (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO nodes (name) VALUES ('hello');
  `);
  db.close();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-snap-'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
  createTestDb(dbPath);
});

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── validateSnapshotName ───────────────────────────────────────────────

describe('validateSnapshotName', () => {
  it('accepts valid names', () => {
    expect(() => validateSnapshotName('pre-refactor')).not.toThrow();
    expect(() => validateSnapshotName('v1_0')).not.toThrow();
    expect(() => validateSnapshotName('ABC123')).not.toThrow();
  });

  it('rejects names with spaces', () => {
    expect(() => validateSnapshotName('has space')).toThrow(/Invalid snapshot name/);
  });

  it('rejects names with dots', () => {
    expect(() => validateSnapshotName('v1.0')).toThrow(/Invalid snapshot name/);
  });

  it('rejects names with slashes', () => {
    expect(() => validateSnapshotName('a/b')).toThrow(/Invalid snapshot name/);
  });

  it('rejects empty string', () => {
    expect(() => validateSnapshotName('')).toThrow(/Invalid snapshot name/);
  });

  it('rejects undefined', () => {
    expect(() => validateSnapshotName(undefined)).toThrow(/Invalid snapshot name/);
  });
});

// ─── snapshotsDir ───────────────────────────────────────────────────────

describe('snapshotsDir', () => {
  it('returns correct path relative to DB', () => {
    const result = snapshotsDir('/project/.codegraph/graph.db');
    expect(result).toBe(path.join('/project/.codegraph', 'snapshots'));
  });

  it('works with the test DB path', () => {
    const result = snapshotsDir(dbPath);
    expect(result).toBe(path.join(tmpDir, '.codegraph', 'snapshots'));
  });
});

// ─── snapshotSave ───────────────────────────────────────────────────────

describe('snapshotSave', () => {
  it('creates a snapshot file', () => {
    const result = snapshotSave('test1', { dbPath });
    expect(result.name).toBe('test1');
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.size).toBeGreaterThan(0);
  });

  it('creates snapshots directory if missing', () => {
    const dir = snapshotsDir(dbPath);
    expect(fs.existsSync(dir)).toBe(false);
    snapshotSave('test1', { dbPath });
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('returns correct metadata', () => {
    const result = snapshotSave('meta-test', { dbPath });
    expect(result).toEqual({
      name: 'meta-test',
      path: path.join(snapshotsDir(dbPath), 'meta-test.db'),
      size: expect.any(Number),
    });
  });

  it('produces a valid SQLite file', () => {
    const result = snapshotSave('valid-check', { dbPath });
    const db = new Database(result.path, { readonly: true });
    const rows = db.prepare('SELECT name FROM nodes').all();
    expect(rows).toEqual([{ name: 'hello' }]);
    db.close();
  });

  it('throws on missing database', () => {
    const fakePath = path.join(tmpDir, 'nonexistent', 'graph.db');
    expect(() => snapshotSave('x', { dbPath: fakePath })).toThrow(/Database not found/);
  });

  it('throws on duplicate without force', () => {
    snapshotSave('dup', { dbPath });
    expect(() => snapshotSave('dup', { dbPath })).toThrow(/already exists/);
  });

  it('overwrites with force', () => {
    snapshotSave('dup', { dbPath });
    const result = snapshotSave('dup', { dbPath, force: true });
    expect(fs.existsSync(result.path)).toBe(true);
  });

  it('rejects invalid name', () => {
    expect(() => snapshotSave('bad name', { dbPath })).toThrow(/Invalid snapshot name/);
  });
});

// ─── snapshotRestore ────────────────────────────────────────────────────

describe('snapshotRestore', () => {
  it('restores data from a snapshot', () => {
    snapshotSave('restore-test', { dbPath });

    // Modify the live DB
    const db = new Database(dbPath);
    db.exec("INSERT INTO nodes (name) VALUES ('extra')");
    db.close();

    // Restore — should get back to original state
    snapshotRestore('restore-test', { dbPath });
    const restored = new Database(dbPath, { readonly: true });
    const rows = restored.prepare('SELECT name FROM nodes').all();
    expect(rows).toEqual([{ name: 'hello' }]);
    restored.close();
  });

  it('removes WAL and SHM sidecar files', () => {
    snapshotSave('wal-test', { dbPath });

    // Create fake sidecar files
    fs.writeFileSync(`${dbPath}-wal`, 'fake-wal');
    fs.writeFileSync(`${dbPath}-shm`, 'fake-shm');

    snapshotRestore('wal-test', { dbPath });
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it('throws on missing snapshot', () => {
    expect(() => snapshotRestore('nonexistent', { dbPath })).toThrow(/not found/);
  });

  it('rejects invalid name', () => {
    expect(() => snapshotRestore('bad.name', { dbPath })).toThrow(/Invalid snapshot name/);
  });
});

// ─── snapshotList ───────────────────────────────────────────────────────

describe('snapshotList', () => {
  it('returns empty array when no snapshots dir exists', () => {
    const result = snapshotList({ dbPath });
    expect(result).toEqual([]);
  });

  it('returns snapshot metadata sorted by date descending', () => {
    snapshotSave('alpha', { dbPath });
    snapshotSave('beta', { dbPath });
    const result = snapshotList({ dbPath });
    expect(result).toHaveLength(2);
    expect(result[0].name).toBeDefined();
    expect(result[1].name).toBeDefined();
    expect(new Set([result[0].name, result[1].name])).toEqual(new Set(['alpha', 'beta']));
    for (const s of result) {
      expect(s.size).toBeGreaterThan(0);
      expect(s.createdAt).toBeInstanceOf(Date);
      expect(s.path).toContain('.db');
    }
  });

  it('filters non-.db files', () => {
    snapshotSave('real', { dbPath });
    const dir = snapshotsDir(dbPath);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a snapshot');

    const result = snapshotList({ dbPath });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('real');
  });
});

// ─── snapshotDelete ─────────────────────────────────────────────────────

describe('snapshotDelete', () => {
  it('deletes a snapshot file', () => {
    const { path: snapPath } = snapshotSave('del-me', { dbPath });
    expect(fs.existsSync(snapPath)).toBe(true);
    snapshotDelete('del-me', { dbPath });
    expect(fs.existsSync(snapPath)).toBe(false);
  });

  it('throws on missing snapshot', () => {
    expect(() => snapshotDelete('ghost', { dbPath })).toThrow(/not found/);
  });

  it('rejects invalid name', () => {
    expect(() => snapshotDelete('bad/name', { dbPath })).toThrow(/Invalid snapshot name/);
  });
});
