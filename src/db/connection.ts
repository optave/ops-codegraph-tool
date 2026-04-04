import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { debug, warn } from '../infrastructure/logger.js';
import { getNative, isNativeAvailable } from '../infrastructure/native.js';
import { DbError, toErrorMessage } from '../shared/errors.js';
import type { BetterSqlite3Database, NativeDatabase } from '../types.js';
import { getDatabase } from './better-sqlite3.js';
import { Repository } from './repository/base.js';
import { NativeRepository } from './repository/native-repository.js';
import { SqliteRepository } from './repository/sqlite-repository.js';

/** Lazy-loaded package version (read once from package.json). */
let _packageVersion: string | undefined;
function getPackageVersion(): string {
  if (_packageVersion !== undefined) return _packageVersion;
  try {
    const connDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(connDir, '..', '..', 'package.json');
    _packageVersion = (JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string })
      .version;
  } catch (e) {
    debug(`Failed to read package version: ${toErrorMessage(e)}`);
    _packageVersion = '';
  }
  return _packageVersion;
}

/** Warn once per process when DB version mismatches the running codegraph version. */
let _versionWarned = false;

/** Check and warn (once) if the running codegraph version differs from the DB build version. */
function warnOnVersionMismatch(getBuildVersion: () => string | undefined | null): void {
  if (_versionWarned) return;
  _versionWarned = true;
  try {
    const buildVersion = getBuildVersion();
    const currentVersion = getPackageVersion();
    if (buildVersion && currentVersion && buildVersion !== currentVersion) {
      warn(
        `DB was built with codegraph v${buildVersion}, running v${currentVersion}. Consider: codegraph build --no-incremental`,
      );
    }
  } catch (e) {
    debug(`Version mismatch check skipped (build_meta may not exist): ${toErrorMessage(e)}`);
  }
}

/** DB instance with optional advisory lock path. */
export type LockedDatabase = BetterSqlite3Database & { __lockPath?: string };

let _cachedRepoRoot: string | null | undefined; // undefined = not computed, null = not a git repo
let _cachedRepoRootCwd: string | undefined; // cwd at the time the cache was populated

/**
 * Return the git worktree/repo root for the given directory (or cwd).
 * Uses `git rev-parse --show-toplevel` which returns the correct root
 * for both regular repos and git worktrees.
 * Results are cached per-process when called without arguments.
 * The cache is keyed on cwd so it invalidates if the working directory changes
 * (e.g. MCP server serving multiple sessions).
 */
export function findRepoRoot(fromDir?: string): string | null {
  const dir = fromDir || process.cwd();
  if (!fromDir && _cachedRepoRoot !== undefined && _cachedRepoRootCwd === dir) {
    return _cachedRepoRoot;
  }
  let root: string | null = null;
  try {
    const raw = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // Use realpathSync to resolve symlinks (macOS /var → /private/var) and
    // 8.3 short names (Windows RUNNER~1 → runneradmin) so the ceiling path
    // matches the realpathSync'd dir in findDbPath.
    try {
      root = fs.realpathSync(raw);
    } catch (e) {
      debug(`realpathSync failed for git root "${raw}", using resolve: ${toErrorMessage(e)}`);
      root = path.resolve(raw);
    }
  } catch (e) {
    debug(`git rev-parse failed for "${dir}": ${toErrorMessage(e)}`);
    root = null;
  }
  if (!fromDir) {
    _cachedRepoRoot = root;
    _cachedRepoRootCwd = dir;
  }
  return root;
}

/** Reset the cached repo root (for testing). */
export function _resetRepoRootCache(): void {
  _cachedRepoRoot = undefined;
  _cachedRepoRootCwd = undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    debug(`PID ${pid} not alive: ${(e as NodeJS.ErrnoException).code || toErrorMessage(e)}`);
    return false;
  }
}

function acquireAdvisoryLock(dbPath: string): void {
  const lockPath = `${dbPath}.lock`;
  try {
    if (fs.existsSync(lockPath)) {
      const content = fs.readFileSync(lockPath, 'utf-8').trim();
      const pid = Number(content);
      if (pid && pid !== process.pid && isProcessAlive(pid)) {
        warn(`Another process (PID ${pid}) may be using this database. Proceeding with caution.`);
      }
    }
  } catch (e) {
    debug(`Advisory lock read failed: ${toErrorMessage(e)}`);
  }
  try {
    fs.writeFileSync(lockPath, String(process.pid), 'utf-8');
  } catch (e) {
    debug(`Advisory lock write failed: ${toErrorMessage(e)}`);
  }
}

function releaseAdvisoryLock(lockPath: string): void {
  try {
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    if (Number(content) === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch (e) {
    debug(`Advisory lock release failed for ${lockPath}: ${toErrorMessage(e)}`);
  }
}

/**
 * Check if two paths refer to the same directory.
 * Handles Windows 8.3 short names (RUNNER~1 vs runneradmin) and macOS
 * symlinks (/tmp vs /private/tmp) where string comparison fails.
 */
function isSameDirectory(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch (e) {
    debug(`isSameDirectory stat failed: ${toErrorMessage(e)}`);
    return false;
  }
}

export function openDb(dbPath: string): LockedDatabase {
  // Flush any deferred DB close from a previous build (avoids WAL contention)
  flushDeferredClose();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  acquireAdvisoryLock(dbPath);
  const Database = getDatabase();
  const db = new Database(dbPath) as unknown as LockedDatabase;
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.__lockPath = `${dbPath}.lock`;
  return db;
}

export function closeDb(db: LockedDatabase): void {
  db.close();
  if (db.__lockPath) releaseAdvisoryLock(db.__lockPath);
}

/** Pending deferred-close DB handles (not yet closed). */
const _deferredDbs: LockedDatabase[] = [];

/**
 * Synchronously close any DB handles queued by `closeDbDeferred()`.
 * Call before deleting DB files or in test teardown to avoid EBUSY on Windows.
 */
export function flushDeferredClose(): void {
  while (_deferredDbs.length > 0) {
    const db = _deferredDbs.pop()!;
    try {
      db.close();
    } catch (e) {
      debug(`Deferred DB close failed (handle may already be closed): ${toErrorMessage(e)}`);
    }
  }
}

/**
 * Schedule DB close on the next event loop tick. Useful for incremental
 * builds where the WAL checkpoint in db.close() is expensive (~250ms on
 * Windows) and doesn't need to block the caller.
 *
 * The advisory lock is released immediately so subsequent opens succeed.
 * The actual handle close (+ WAL checkpoint) happens asynchronously.
 * Call `flushDeferredClose()` before deleting the DB file.
 */
export function closeDbDeferred(db: LockedDatabase): void {
  // Release the advisory lock immediately so the next open can proceed
  if (db.__lockPath) {
    releaseAdvisoryLock(db.__lockPath);
    db.__lockPath = undefined;
  }
  _deferredDbs.push(db);
  // Defer the expensive WAL checkpoint to after the caller returns
  setImmediate(() => {
    const idx = _deferredDbs.indexOf(db);
    if (idx !== -1) {
      _deferredDbs.splice(idx, 1);
      try {
        db.close();
      } catch (e) {
        debug(`Deferred DB close failed (may already be closed by flush): ${toErrorMessage(e)}`);
      }
    }
  });
}

// ── Paired close helpers (Phase 6.16) ──────────────────────────────────
// When both a NativeDatabase and better-sqlite3 handle are open on the same
// DB file, these helpers ensure NativeDatabase is closed first (fast, ~1ms)
// before the better-sqlite3 close (which forces a WAL checkpoint, ~250ms).

/** A better-sqlite3 handle optionally paired with a NativeDatabase. */
export interface LockedDatabasePair {
  db: LockedDatabase;
  nativeDb?: NativeDatabase;
}

/** Close both handles: NativeDatabase first (fast), then better-sqlite3 (releases lock). */
export function closeDbPair(pair: LockedDatabasePair): void {
  if (pair.nativeDb) {
    try {
      pair.nativeDb.close();
    } catch (e) {
      debug(`closeDbPair: native close failed: ${toErrorMessage(e)}`);
    }
  }
  closeDb(pair.db);
}

/** Close NativeDatabase immediately, defer better-sqlite3 WAL checkpoint. */
export function closeDbPairDeferred(pair: LockedDatabasePair): void {
  if (pair.nativeDb) {
    try {
      pair.nativeDb.close();
    } catch (e) {
      debug(`closeDbPairDeferred: native close failed: ${toErrorMessage(e)}`);
    }
  }
  closeDbDeferred(pair.db);
}

export function findDbPath(customPath?: string): string {
  if (customPath) return path.resolve(customPath);
  const rawCeiling = findRepoRoot();
  // Normalize ceiling with realpathSync to resolve 8.3 short names (Windows
  // RUNNER~1 → runneradmin) and symlinks (macOS /var → /private/var).
  // findRepoRoot already applies realpathSync internally, but the git output
  // may still contain short names on some Windows CI environments.
  let ceiling: string | null;
  if (rawCeiling) {
    try {
      ceiling = fs.realpathSync(rawCeiling);
    } catch (e) {
      debug(`realpathSync failed for ceiling "${rawCeiling}": ${toErrorMessage(e)}`);
      ceiling = rawCeiling;
    }
  } else {
    ceiling = null;
  }
  // Resolve symlinks (e.g. macOS /var → /private/var) so dir matches ceiling from git
  let dir: string;
  try {
    dir = fs.realpathSync(process.cwd());
  } catch (e) {
    debug(`realpathSync failed for cwd: ${toErrorMessage(e)}`);
    dir = process.cwd();
  }
  while (true) {
    const candidate = path.join(dir, '.codegraph', 'graph.db');
    if (fs.existsSync(candidate)) return candidate;
    if (ceiling && isSameDirectory(dir, ceiling)) {
      debug(`findDbPath: stopped at git ceiling ${ceiling}`);
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const base = ceiling || process.cwd();
  return path.join(base, '.codegraph', 'graph.db');
}

/** Open a database in readonly mode, with a user-friendly error if the DB doesn't exist. */
export function openReadonlyOrFail(customPath?: string): BetterSqlite3Database {
  const dbPath = findDbPath(customPath);
  if (!fs.existsSync(dbPath)) {
    throw new DbError(
      `No codegraph database found at ${dbPath}.\nRun "codegraph build" first to analyze your codebase.`,
      { file: dbPath },
    );
  }
  const Database = getDatabase();
  const db = new Database(dbPath, { readonly: true }) as unknown as BetterSqlite3Database;
  db.pragma('busy_timeout = 5000');

  warnOnVersionMismatch(() => {
    const row = db
      .prepare<{ value: string }>('SELECT value FROM build_meta WHERE key = ?')
      .get('codegraph_version');
    return row?.value;
  });

  return db;
}

/** Open a NativeRepository via rusqlite, throwing DbError if the DB file is missing. */
function openRepoNative(customDbPath?: string): { repo: Repository; close(): void } {
  const dbPath = findDbPath(customDbPath);
  if (!fs.existsSync(dbPath)) {
    throw new DbError(
      `No codegraph database found at ${dbPath}.\nRun "codegraph build" first to analyze your codebase.`,
      { file: dbPath },
    );
  }
  const native = getNative();
  const ndb = native.NativeDatabase.openReadonly(dbPath);
  try {
    warnOnVersionMismatch(() => ndb.getBuildMeta('codegraph_version'));
    const repo = new NativeRepository(ndb, dbPath);
    return {
      repo,
      close() {
        repo.closeFallback();
        ndb.close();
      },
    };
  } catch (innerErr) {
    ndb.close();
    throw innerErr;
  }
}

/**
 * Open a Repository from either an injected instance or a DB path.
 *
 * When `opts.repo` is a Repository instance, returns it directly (no DB opened).
 * When the native engine is available, opens a NativeDatabase (rusqlite) and
 * wraps it in NativeRepository. Otherwise falls back to better-sqlite3 via
 * SqliteRepository.
 */
export function openRepo(
  customDbPath?: string,
  opts: { repo?: Repository } = {},
): { repo: Repository; close(): void } {
  if (opts.repo != null) {
    if (!(opts.repo instanceof Repository)) {
      throw new TypeError(
        `openRepo: opts.repo must be a Repository instance, got ${Object.prototype.toString.call(opts.repo)}`,
      );
    }
    return { repo: opts.repo, close() {} };
  }

  // Try native rusqlite path first (Phase 6.14)
  if (isNativeAvailable()) {
    try {
      return openRepoNative(customDbPath);
    } catch (e) {
      // Re-throw user-visible errors (e.g. DB not found) — only silently
      // fall back for native-engine failures (e.g. incompatible native binary).
      if (e instanceof DbError) throw e;
      // Re-throw locking/busy errors — falling back to better-sqlite3 would
      // hit the same contention (and potentially hang without busy_timeout).
      const msg = toErrorMessage(e);
      if (/\b(busy|locked|SQLITE_BUSY|SQLITE_LOCKED)\b/i.test(msg)) {
        throw new DbError(`Database is busy (another process may be writing): ${msg}`, {});
      }
      debug(`openRepo: native path failed, falling back to better-sqlite3: ${msg}`);
    }
  }

  const db = openReadonlyOrFail(customDbPath);
  return {
    repo: new SqliteRepository(db),
    close() {
      db.close();
    },
  };
}

/**
 * Open a readonly DB with an optional NativeDatabase alongside it.
 *
 * Returns the better-sqlite3 handle (for backwards compat) plus an optional
 * NativeDatabase for modules that can use batched Rust query methods.
 * Callers should use nativeDb when available and fall back to db.prepare().
 */
export function openReadonlyWithNative(customPath?: string): {
  db: BetterSqlite3Database;
  nativeDb: NativeDatabase | undefined;
  close(): void;
} {
  const db = openReadonlyOrFail(customPath);

  let nativeDb: NativeDatabase | undefined;
  if (isNativeAvailable()) {
    try {
      const dbPath = findDbPath(customPath);
      const native = getNative();
      nativeDb = native.NativeDatabase.openReadonly(dbPath);
    } catch (e) {
      debug(`openReadonlyWithNative: native path failed: ${toErrorMessage(e)}`);
    }
  }

  return {
    db,
    nativeDb,
    close() {
      db.close();
      if (nativeDb) {
        try {
          nativeDb.close();
        } catch (e) {
          debug(`openReadonlyWithNative: native close failed: ${toErrorMessage(e)}`);
        }
      }
    },
  };
}
