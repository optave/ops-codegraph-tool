/**
 * Unit tests for src/db.js — build_meta helpers included
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeDb,
  findDbPath,
  getBuildMeta,
  initSchema,
  MIGRATIONS,
  openDb,
  openReadonlyOrFail,
  setBuildMeta,
} from '../../src/db.js';

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-db-'));
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('initSchema', () => {
  it('creates nodes, edges, schema_version, and file_hashes tables', () => {
    const db = new Database(':memory:');
    initSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    expect(tables).toContain('nodes');
    expect(tables).toContain('edges');
    expect(tables).toContain('schema_version');
    expect(tables).toContain('file_hashes');
    db.close();
  });

  it('is idempotent (run twice without error)', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();
    db.close();
  });

  it('applies all migrations and updates schema_version', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const row = db.prepare('SELECT version FROM schema_version').get();
    expect(row.version).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
    db.close();
  });
});

describe('MIGRATIONS', () => {
  it('has sequentially increasing version numbers', () => {
    for (let i = 0; i < MIGRATIONS.length; i++) {
      expect(MIGRATIONS[i].version).toBe(i + 1);
    }
  });
});

describe('openDb', () => {
  it('creates parent directory if missing and returns a database', () => {
    const dbDir = path.join(tmpDir, 'nested', 'dir', '.codegraph');
    const dbPath = path.join(dbDir, 'graph.db');
    const db = openDb(dbPath);
    expect(fs.existsSync(dbDir)).toBe(true);
    expect(db).toBeDefined();
    closeDb(db);
  });

  it('returns a functional database', () => {
    const dbPath = path.join(tmpDir, 'functional.db');
    const db = openDb(dbPath);
    initSchema(db);
    db.prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)').run(
      'test',
      'function',
      'test.js',
      1,
    );
    const row = db.prepare('SELECT * FROM nodes WHERE name = ?').get('test');
    expect(row.name).toBe('test');
    closeDb(db);
  });

  it('sets busy_timeout pragma to 5000', () => {
    const dbPath = path.join(tmpDir, 'busy-timeout.db');
    const db = openDb(dbPath);
    const timeout = db.pragma('busy_timeout', { simple: true });
    expect(timeout).toBe(5000);
    closeDb(db);
  });

  it('creates lock file on open and removes on closeDb', () => {
    const dbPath = path.join(tmpDir, 'locktest.db');
    const lockPath = `${dbPath}.lock`;
    const db = openDb(dbPath);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, 'utf-8').trim()).toBe(String(process.pid));
    closeDb(db);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe('findDbPath', () => {
  it('returns resolved custom path when provided', () => {
    const custom = path.join(tmpDir, 'custom.db');
    const result = findDbPath(custom);
    expect(result).toBe(path.resolve(custom));
  });

  it('finds .codegraph/graph.db walking up parent directories', () => {
    const projectDir = path.join(tmpDir, 'project');
    const cgDir = path.join(projectDir, '.codegraph');
    const deepDir = path.join(projectDir, 'src', 'deep');
    fs.mkdirSync(cgDir, { recursive: true });
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(path.join(cgDir, 'graph.db'), '');

    // Mock cwd to be deep inside the project
    const origCwd = process.cwd;
    process.cwd = () => deepDir;
    try {
      const result = findDbPath();
      expect(result).toContain('.codegraph');
      expect(result).toContain('graph.db');
    } finally {
      process.cwd = origCwd;
    }
  });

  it('returns default path when no DB found', () => {
    const emptyDir = fs.mkdtempSync(path.join(tmpDir, 'empty-'));
    const origCwd = process.cwd;
    process.cwd = () => emptyDir;
    try {
      const result = findDbPath();
      expect(result).toContain('.codegraph');
      expect(result).toContain('graph.db');
    } finally {
      process.cwd = origCwd;
    }
  });
});

describe('build_meta', () => {
  it('table is created by migration v7', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    expect(tables).toContain('build_meta');
    db.close();
  });

  it('getBuildMeta returns null for missing table (pre-v7 schema)', () => {
    const db = new Database(':memory:');
    // No initSchema — no build_meta table
    const result = getBuildMeta(db, 'engine');
    expect(result).toBeNull();
    db.close();
  });

  it('setBuildMeta writes and getBuildMeta reads', () => {
    const db = new Database(':memory:');
    initSchema(db);
    setBuildMeta(db, { engine: 'wasm', codegraph_version: '1.0.0' });
    expect(getBuildMeta(db, 'engine')).toBe('wasm');
    expect(getBuildMeta(db, 'codegraph_version')).toBe('1.0.0');
    expect(getBuildMeta(db, 'nonexistent')).toBeNull();
    db.close();
  });

  it('setBuildMeta upserts existing keys', () => {
    const db = new Database(':memory:');
    initSchema(db);
    setBuildMeta(db, { engine: 'wasm' });
    expect(getBuildMeta(db, 'engine')).toBe('wasm');
    setBuildMeta(db, { engine: 'native' });
    expect(getBuildMeta(db, 'engine')).toBe('native');
    db.close();
  });
});

describe('openReadonlyOrFail', () => {
  it('exits with error when DB does not exist', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => openReadonlyOrFail(path.join(tmpDir, 'nonexistent.db'))).toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalled();
    const errorMsg = stderrSpy.mock.calls[0][0];
    expect(errorMsg).toContain('No codegraph database found');

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('returns a readonly database when DB exists', () => {
    const dbPath = path.join(tmpDir, 'readonly-test.db');
    const db = openDb(dbPath);
    initSchema(db);
    closeDb(db);

    const readDb = openReadonlyOrFail(dbPath);
    expect(readDb).toBeDefined();
    const tables = readDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    expect(tables).toContain('nodes');
    readDb.close();
  });
});
