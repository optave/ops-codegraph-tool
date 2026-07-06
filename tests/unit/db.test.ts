/**
 * Unit tests for src/db.js — build_meta helpers included
 */

// Note: due to vi.mock hoisting, this resolves to the spy (which delegates
// to the real impl by default). Safe for setup calls before mockImplementationOnce.
import { execFileSync as execFileSyncForSetup } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const execFileSyncSpy = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const mod = await importOriginal();
  execFileSyncSpy.mockImplementation(mod.execFileSync);
  return { ...mod, execFileSync: execFileSyncSpy };
});

import { _resetRepoRootCache } from '../../src/db/connection.js';
import type { LockedDatabase } from '../../src/db/index.js';
import {
  acquireAdvisoryLock,
  closeDb,
  closeDbDeferred,
  closeDbPair,
  closeDbPairDeferred,
  findDbPath,
  findRepoRoot,
  flushDeferredClose,
  getBuildMeta,
  initSchema,
  MIGRATIONS,
  openDb,
  openReadonlyOrFail,
  setBuildMeta,
} from '../../src/db/index.js';
import type { NativeDatabase } from '../../src/types.js';

let tmpDir: string;

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

// ── closeDbPair / closeDbPairDeferred / closeDbDeferred (#1751) ────────────
// These pair-close helpers only ever call `.close()` on whatever db/nativeDb
// handles they're given — they never open a DB themselves — so lightweight
// mock handles are enough to exercise close ordering and deferral timing.
// (Contrast with openReadonlyWithNative-leak.test.ts, which needs a real
// handle because that regression is about *opening*, not closing.)

/** Resolves once the event loop has drained the `setImmediate` queue, i.e.
 * after any close scheduled via `closeDbDeferred`'s own `setImmediate`. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeFakeDb(lockPath?: string): {
  db: LockedDatabase;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  const db = { close, __lockPath: lockPath } as unknown as LockedDatabase;
  return { db, close };
}

function makeFakeNativeDb(): { nativeDb: NativeDatabase; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  const nativeDb = { close } as unknown as NativeDatabase;
  return { nativeDb, close };
}

describe('closeDbPair', () => {
  it('closes the native handle before the better-sqlite3 handle', () => {
    const order: string[] = [];
    const { db, close: dbClose } = makeFakeDb();
    const { nativeDb, close: nativeClose } = makeFakeNativeDb();
    dbClose.mockImplementation(() => order.push('db'));
    nativeClose.mockImplementation(() => order.push('native'));

    closeDbPair({ db, nativeDb });

    expect(order).toEqual(['native', 'db']);
  });

  it('still closes the better-sqlite3 handle when the native close throws', () => {
    const { db, close: dbClose } = makeFakeDb();
    const { nativeDb, close: nativeClose } = makeFakeNativeDb();
    nativeClose.mockImplementation(() => {
      throw new Error('native close boom');
    });

    expect(() => closeDbPair({ db, nativeDb })).not.toThrow();

    expect(nativeClose).toHaveBeenCalledTimes(1);
    expect(dbClose).toHaveBeenCalledTimes(1);
  });

  it('closes the better-sqlite3 handle when there is no native handle', () => {
    const { db, close: dbClose } = makeFakeDb();

    closeDbPair({ db });

    expect(dbClose).toHaveBeenCalledTimes(1);
  });
});

describe('closeDbPairDeferred', () => {
  // Drain anything left in connection.ts's module-private deferred-close
  // queue so state can't leak into a later test.
  afterEach(async () => {
    flushDeferredClose();
    await tick();
  });

  it('closes the native handle immediately, synchronously within the call', () => {
    const { db } = makeFakeDb();
    const { nativeDb, close: nativeClose } = makeFakeNativeDb();

    closeDbPairDeferred({ db, nativeDb });

    expect(nativeClose).toHaveBeenCalledTimes(1);
  });

  it('defers the better-sqlite3 close to the next tick instead of closing synchronously', async () => {
    const { db, close: dbClose } = makeFakeDb();
    const { nativeDb } = makeFakeNativeDb();

    closeDbPairDeferred({ db, nativeDb });
    expect(dbClose).not.toHaveBeenCalled();

    await tick();

    expect(dbClose).toHaveBeenCalledTimes(1);
  });

  it('still defers the better-sqlite3 close when the native close throws', async () => {
    const { db, close: dbClose } = makeFakeDb();
    const { nativeDb, close: nativeClose } = makeFakeNativeDb();
    nativeClose.mockImplementation(() => {
      throw new Error('native close boom');
    });

    expect(() => closeDbPairDeferred({ db, nativeDb })).not.toThrow();
    expect(dbClose).not.toHaveBeenCalled();

    await tick();

    expect(dbClose).toHaveBeenCalledTimes(1);
  });
});

describe('closeDbDeferred', () => {
  afterEach(async () => {
    flushDeferredClose();
    await tick();
  });

  it('releases the advisory lock synchronously while deferring the actual handle close', async () => {
    const dbPath = path.join(tmpDir, 'deferred-close-lock.db');
    acquireAdvisoryLock(dbPath);
    const lockPath = `${dbPath}.lock`;
    expect(fs.existsSync(lockPath)).toBe(true);

    const { db, close } = makeFakeDb(lockPath);

    closeDbDeferred(db);

    // Lock release + clearing __lockPath happen synchronously, within the call.
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(db.__lockPath).toBeUndefined();
    // The handle itself is not closed yet — that's deferred to the next tick.
    expect(close).not.toHaveBeenCalled();

    await tick();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the handle on the next tick when nothing flushes it early', async () => {
    const { db, close } = makeFakeDb();

    closeDbDeferred(db);
    expect(close).not.toHaveBeenCalled();

    await tick();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('flushDeferredClose() closes the handle synchronously when called before the next tick', async () => {
    const { db, close } = makeFakeDb();

    closeDbDeferred(db);
    expect(close).not.toHaveBeenCalled();

    flushDeferredClose();
    expect(close).toHaveBeenCalledTimes(1);

    // The setImmediate callback scheduled by closeDbDeferred must notice the
    // handle was already removed + closed by the flush, and must not close
    // it a second time.
    await tick();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not attempt a lock release when the handle has no advisory lock path', () => {
    const { db } = makeFakeDb();

    expect(() => closeDbDeferred(db)).not.toThrow();
    expect(db.__lockPath).toBeUndefined();
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
    _resetRepoRootCache();
    execFileSyncSpy.mockImplementationOnce(() => {
      throw new Error('not a git repo');
    });
    try {
      const result = findDbPath();
      expect(result).toBe(path.join(emptyDir, '.codegraph', 'graph.db'));
    } finally {
      process.cwd = origCwd;
      _resetRepoRootCache();
    }
  });

  it('resolves repo directory to .codegraph/graph.db without double-appending', () => {
    // When the caller passes the repo root directory (e.g. --db /path/to/repo),
    // findDbPath must append .codegraph/graph.db exactly once.
    const repoDir = fs.mkdtempSync(path.join(tmpDir, 'repo-dir-'));
    const result = findDbPath(repoDir);
    expect(result).toBe(path.join(repoDir, '.codegraph', 'graph.db'));
  });

  it('handles .codegraph directory passed directly without double-appending', () => {
    // When the caller passes the .codegraph directory itself (e.g. --db /repo/.codegraph),
    // findDbPath must resolve to /repo/.codegraph/graph.db, not /repo/.codegraph/.codegraph/graph.db.
    const repoDir = fs.mkdtempSync(path.join(tmpDir, 'repo-cg-'));
    const cgDir = path.join(repoDir, '.codegraph');
    fs.mkdirSync(cgDir);
    const result = findDbPath(cgDir);
    expect(result).toBe(path.join(cgDir, 'graph.db'));
    expect(result).not.toContain(`.codegraph${path.sep}.codegraph`);
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
    execFileSyncSpy.mockImplementationOnce(() => {
      throw new Error('not a git repo');
    });
    const root = findRepoRoot(os.tmpdir());
    expect(root).toBeNull();
  });

  it('caches results when called without arguments', () => {
    _resetRepoRootCache();
    execFileSyncSpy.mockClear();
    const first = findRepoRoot();
    const second = findRepoRoot();
    expect(first).toBe(second);
    expect(execFileSyncSpy).toHaveBeenCalledTimes(1);
  });

  it('bypasses cache when called with explicit dir', () => {
    _resetRepoRootCache();
    execFileSyncSpy.mockClear();
    const fromCwd = findRepoRoot();
    const fromExplicit = findRepoRoot(process.cwd());
    expect(fromExplicit).toBe(fromCwd);
    // First call populates cache, second call with explicit dir must call again
    expect(execFileSyncSpy).toHaveBeenCalledTimes(2);
  });
});

describe('findDbPath with git ceiling', () => {
  let outerDir: string;
  let worktreeRoot: string;
  let innerDir: string;

  beforeAll(() => {
    // Simulate a worktree-inside-repo layout:
    // outerDir/.codegraph/graph.db  (parent repo DB — should NOT be found)
    // outerDir/worktree/            (git init here — acts as ceiling)
    // outerDir/worktree/sub/        (cwd inside worktree)
    outerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ceiling-'));
    worktreeRoot = path.join(outerDir, 'worktree');
    fs.mkdirSync(path.join(outerDir, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(outerDir, '.codegraph', 'graph.db'), '');
    fs.mkdirSync(path.join(worktreeRoot, 'sub'), { recursive: true });
    // Initialize a real git repo at the worktree root so findRepoRoot returns it
    execFileSyncForSetup('git', ['init'], { cwd: worktreeRoot, stdio: 'pipe' });
    // Resolve symlinks (macOS /var → /private/var) and 8.3 short names
    // (Windows RUNNER~1 → runneradmin) so test paths match findRepoRoot output.
    outerDir = fs.realpathSync(outerDir);
    worktreeRoot = fs.realpathSync(worktreeRoot);
    innerDir = path.join(worktreeRoot, 'sub');
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
      // Use findRepoRoot() for the expected ceiling — git may resolve 8.3 short
      // names (Windows RUNNER~1 → runneradmin) or symlinks (macOS /tmp → /private/tmp)
      // differently than fs.realpathSync on the test's worktreeRoot.
      const ceiling = findRepoRoot();
      const result = findDbPath();
      // Should return default path at the ceiling root, NOT the outer DB
      expect(result).toBe(path.join(ceiling, '.codegraph', 'graph.db'));
      expect(result).not.toContain(`${path.basename(outerDir)}${path.sep}.codegraph`);
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
      // Avoid exact path comparison — realpathSync doesn't resolve Windows
      // 8.3 short names (RUNNER~1 vs runneradmin) on CI. Instead verify
      // existence, suffix, and that it's not the outer directory's DB.
      expect(fs.existsSync(result)).toBe(true);
      expect(result).toMatch(/\.codegraph[/\\]graph\.db$/);
      expect(result).not.toContain(`${path.basename(outerDir)}${path.sep}.codegraph`);
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
    execFileSyncSpy.mockImplementationOnce(() => {
      throw new Error('not a git repo');
    });
    try {
      const result = findDbPath();
      // Should return default path at cwd since there's no git ceiling
      expect(result).toBe(path.join(emptyDir, '.codegraph', 'graph.db'));
    } finally {
      process.cwd = origCwd;
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('does not pick up stale parent .codegraph/ when no git repo exists', () => {
    // Regression for the Phase 0 footgun (dogfood report 10.6): when no git
    // repo wraps cwd, findDbPath used to walk all the way to `/`, latching
    // onto stale .codegraph/ from unrelated parents (e.g. /private/tmp/).
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stale-parent-'));
    fs.mkdirSync(path.join(parentDir, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(parentDir, '.codegraph', 'graph.db'), '');
    const innerDir = path.join(parentDir, 'inner');
    fs.mkdirSync(innerDir, { recursive: true });
    const origCwd = process.cwd;
    process.cwd = () => innerDir;
    _resetRepoRootCache();
    execFileSyncSpy.mockImplementationOnce(() => {
      throw new Error('not a git repo');
    });
    try {
      const result = findDbPath();
      // Must NOT return the stale parent's DB.
      expect(result).not.toBe(path.join(parentDir, '.codegraph', 'graph.db'));
      // Falls back to the default path at cwd.
      expect(result).toBe(path.join(innerDir, '.codegraph', 'graph.db'));
    } finally {
      process.cwd = origCwd;
      fs.rmSync(parentDir, { recursive: true, force: true });
    }
  });
});

describe('openReadonlyOrFail', () => {
  it('throws DbError when DB does not exist', () => {
    expect.assertions(4);
    try {
      openReadonlyOrFail(path.join(tmpDir, 'nonexistent.db'));
    } catch (err) {
      expect(err.message).toContain('No codegraph database found');
      expect(err.name).toBe('DbError');
      expect(err.code).toBe('DB_ERROR');
      expect(err.file).toBeDefined();
    }
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

  it('sets busy_timeout pragma to 5000 on readonly connections', () => {
    const dbPath = path.join(tmpDir, 'readonly-busy.db');
    const db = openDb(dbPath);
    initSchema(db);
    closeDb(db);

    const readDb = openReadonlyOrFail(dbPath);
    const timeout = readDb.pragma('busy_timeout', { simple: true });
    expect(timeout).toBe(5000);
    readDb.close();
  });
});
