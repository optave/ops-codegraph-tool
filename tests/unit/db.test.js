/**
 * Unit tests for src/db.js — build_meta helpers included
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  _resetRepoRootCache,
  closeDb,
  findDbPath,
  findRepoRoot,
  openDb,
  openReadonlyOrFail,
} from '../../src/db/connection.js';
import { getBuildMeta, initSchema, MIGRATIONS, setBuildMeta } from '../../src/db.js';

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
      _resetRepoRootCache();
      const result = findDbPath();
      expect(result).toContain('.codegraph');
      expect(result).toContain('graph.db');
    } finally {
      process.cwd = origCwd;
      _resetRepoRootCache();
    }
  });

  it('returns default path when no DB found', () => {
    const emptyDir = fs.mkdtempSync(path.join(tmpDir, 'empty-'));
    const origCwd = process.cwd;
    process.cwd = () => emptyDir;
    try {
      _resetRepoRootCache();
      const result = findDbPath();
      expect(result).toContain('.codegraph');
      expect(result).toContain('graph.db');
    } finally {
      process.cwd = origCwd;
      _resetRepoRootCache();
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

describe('findRepoRoot', () => {
  beforeEach(() => {
    _resetRepoRootCache();
  });

  afterEach(() => {
    _resetRepoRootCache();
  });

  it('returns normalized git toplevel for the current repo', () => {
    _resetRepoRootCache();
    const root = findRepoRoot();
    expect(root).toBeTruthy();
    expect(path.isAbsolute(root)).toBe(true);
    // Should contain a .git entry at the root
    expect(fs.existsSync(path.join(root, '.git'))).toBe(true);
  });

  it('returns null when not in a git repo', () => {
    // Create a fresh temp dir that is guaranteed not to be inside a git repo
    const noGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nogit-root-'));
    try {
      const root = findRepoRoot(noGitDir);
      expect(root).toBeNull();
    } finally {
      fs.rmSync(noGitDir, { recursive: true, force: true });
    }
  });

  it('caches results when called without arguments', () => {
    _resetRepoRootCache();
    const first = findRepoRoot();
    const second = findRepoRoot();
    expect(first).toBe(second);
  });

  it('does not use cache when called with explicit dir', () => {
    _resetRepoRootCache();
    const fromCwd = findRepoRoot();
    // Calling with an explicit dir should still work (not use cwd cache)
    const fromExplicit = findRepoRoot(process.cwd());
    expect(fromExplicit).toBe(fromCwd);
  });
});

describe('findDbPath with git ceiling', () => {
  let outerDir;
  let worktreeRoot;
  let innerDir;

  beforeAll(() => {
    // Simulate a worktree-inside-repo layout:
    // outerDir/.codegraph/graph.db  (parent repo DB — should NOT be found)
    // outerDir/worktree/            (git init here — acts as ceiling)
    // outerDir/worktree/sub/        (cwd inside worktree)
    outerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ceiling-'));
    worktreeRoot = path.join(outerDir, 'worktree');
    innerDir = path.join(worktreeRoot, 'sub');
    fs.mkdirSync(path.join(outerDir, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(outerDir, '.codegraph', 'graph.db'), '');
    fs.mkdirSync(innerDir, { recursive: true });
    // Initialize a real git repo at the worktree root so findRepoRoot returns it
    execFileSync('git', ['init'], { cwd: worktreeRoot, stdio: 'pipe' });
  });

  afterAll(() => {
    fs.rmSync(outerDir, { recursive: true, force: true });
  });

  afterEach(() => {
    _resetRepoRootCache();
  });

  it('stops at git ceiling and does not find parent DB', () => {
    // No DB inside the worktree — the only DB is in outerDir (beyond the ceiling).
    // Without the ceiling fix, findDbPath would walk up and find outerDir's DB.
    const origCwd = process.cwd;
    process.cwd = () => innerDir;
    try {
      _resetRepoRootCache();
      const result = findDbPath();
      // Should return default path at the ceiling root, NOT the outer DB
      expect(result).toBe(path.join(worktreeRoot, '.codegraph', 'graph.db'));
      expect(result).not.toContain(path.basename(outerDir) + path.sep + '.codegraph');
    } finally {
      process.cwd = origCwd;
    }
  });

  it('finds DB within the ceiling boundary', () => {
    // Create a DB inside the worktree — should be found normally
    fs.mkdirSync(path.join(worktreeRoot, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(worktreeRoot, '.codegraph', 'graph.db'), '');
    const origCwd = process.cwd;
    process.cwd = () => innerDir;
    try {
      _resetRepoRootCache();
      const result = findDbPath();
      expect(result).toContain('worktree');
      expect(result).toContain('.codegraph');
    } finally {
      process.cwd = origCwd;
      fs.rmSync(path.join(worktreeRoot, '.codegraph'), { recursive: true, force: true });
    }
  });

  it('falls back gracefully when not in a git repo', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nogit-'));
    const origCwd = process.cwd;
    process.cwd = () => emptyDir;
    _resetRepoRootCache();
    try {
      const result = findDbPath();
      // Should return default path at cwd since there's no git ceiling
      expect(result).toBe(path.join(emptyDir, '.codegraph', 'graph.db'));
    } finally {
      process.cwd = origCwd;
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
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
