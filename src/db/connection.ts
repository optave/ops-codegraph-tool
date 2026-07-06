import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, loadConfig } from '../infrastructure/config.js';
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

export function acquireAdvisoryLock(dbPath: string): void {
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

export function releaseAdvisoryLock(lockPath: string): void {
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

export function openDb(
  dbPath: string,
  busyTimeoutMs: number = DEFAULTS.db.busyTimeoutMs,
): LockedDatabase {
  // Flush any deferred DB close from a previous build (avoids WAL contention)
  flushDeferredClose();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  acquireAdvisoryLock(dbPath);
  const Database = getDatabase();
  const db = new Database(dbPath) as unknown as LockedDatabase;
  db.pragma('journal_mode = WAL');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
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

/**
 * Resolve an explicit `--db` path: when it points at a directory, locate the
 * DB inside it — matching the layout that `build` creates.
 */
function resolveCustomDbPath(customPath: string): string {
  const resolved = path.resolve(customPath);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      // If the caller passed the .codegraph directory itself (e.g. --db /repo/.codegraph),
      // use it directly to avoid double-appending .codegraph/.codegraph/graph.db.
      if (path.basename(resolved) === '.codegraph') {
        return path.join(resolved, 'graph.db');
      }
      return path.join(resolved, '.codegraph', 'graph.db');
    }
  } catch (e) {
    // Path doesn't exist yet — return as-is (e.g. a future custom DB path).
    debug(
      `findDbPath: statSync failed for ${resolved}, treating as non-existent: ${toErrorMessage(e)}`,
    );
  }
  return resolved;
}

/**
 * Normalize the git ceiling with realpathSync to resolve 8.3 short names
 * (Windows RUNNER~1 → runneradmin) and symlinks (macOS /var → /private/var).
 * findRepoRoot already applies realpathSync internally, but the git output
 * may still contain short names on some Windows CI environments.
 */
function resolveDbSearchCeiling(rawCeiling: string | null): string | null {
  if (!rawCeiling) return null;
  try {
    return fs.realpathSync(rawCeiling);
  } catch (e) {
    debug(`realpathSync failed for ceiling "${rawCeiling}": ${toErrorMessage(e)}`);
    return rawCeiling;
  }
}

/** Resolve symlinks in cwd (e.g. macOS /var → /private/var) so dir matches ceiling from git. */
function resolveDbSearchStartDir(): string {
  try {
    return fs.realpathSync(process.cwd());
  } catch (e) {
    debug(`realpathSync failed for cwd: ${toErrorMessage(e)}`);
    return process.cwd();
  }
}

/**
 * Walk up from `startDir` toward `ceiling` looking for an existing
 * .codegraph/graph.db. Returns the found path, or null if the walk reaches
 * the ceiling (or, when there's no ceiling, after checking only `startDir`)
 * without finding one.
 */
function walkUpForDbPath(startDir: string, ceiling: string | null): string | null {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, '.codegraph', 'graph.db');
    if (fs.existsSync(candidate)) return candidate;
    if (ceiling && isSameDirectory(dir, ceiling)) {
      debug(`findDbPath: stopped at git ceiling ${ceiling}`);
      return null;
    }
    // Outside a git repo, cwd is the first (and only) directory we'll check.
    // Walking past it risks attaching to a stale .codegraph/ in an unrelated
    // parent — e.g. /private/tmp/.codegraph/ leaking into every /tmp/foo/ run,
    // or $HOME/.codegraph/ leaking into every scratch dir under $HOME.
    if (!ceiling) {
      debug(`findDbPath: no git ceiling, stopping at ${dir}`);
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function findDbPath(customPath?: string): string {
  if (customPath) {
    return resolveCustomDbPath(customPath);
  }
  const ceiling = resolveDbSearchCeiling(findRepoRoot());
  const startDir = resolveDbSearchStartDir();
  const found = walkUpForDbPath(startDir, ceiling);
  if (found) return found;
  const base = ceiling || process.cwd();
  return path.join(base, '.codegraph', 'graph.db');
}

/** Open a database in readonly mode, with a user-friendly error if the DB doesn't exist. */
export function openReadonlyOrFail(
  customPath?: string,
  busyTimeoutMs: number = DEFAULTS.db.busyTimeoutMs,
): BetterSqlite3Database {
  const dbPath = findDbPath(customPath);
  if (!fs.existsSync(dbPath)) {
    throw new DbError(
      `No codegraph database found at ${dbPath}.\nRun "codegraph build" first to analyze your codebase.`,
      { file: dbPath },
    );
  }
  const Database = getDatabase();
  const db = new Database(dbPath, { readonly: true }) as unknown as BetterSqlite3Database;
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);

  warnOnVersionMismatch(() => {
    const row = db
      .prepare<{ value: string }>('SELECT value FROM build_meta WHERE key = ?')
      .get('codegraph_version');
    return row?.value;
  });

  return db;
}

/** Effective engine plus config-derived DB settings shared by openRepo() and openReadonlyWithNative(). */
interface ResolvedDbSettings {
  engine: 'native' | 'wasm' | 'auto';
  busyTimeoutMs: number;
}

/**
 * Derive the project rootDir from a possibly-custom DB path, for loadConfig().
 * Using findDbPath (not path.resolve(customDbPath)) ensures directory inputs like
 * --db /path/to/repo are normalised to .codegraph/graph.db before we strip two levels.
 * Convention: resolvedDbPath = <rootDir>/.codegraph/graph.db
 * Shared by resolveDbSettings() and resolveBusyTimeoutMs() so rootDir derivation can't drift.
 */
function deriveRootDirFromDbPath(customDbPath: string | undefined): string | undefined {
  const resolvedDbPath = customDbPath ? findDbPath(customDbPath) : undefined;
  return resolvedDbPath ? path.dirname(path.dirname(resolvedDbPath)) : undefined;
}

/**
 * Resolve the effective engine for DB access (explicit opts.engine > config.build.engine >
 * 'auto') alongside config.db.busyTimeoutMs, in a single loadConfig() call.
 * Derives rootDir from the resolved DB path so loadConfig reads the right project config.
 * Shared by openRepo() and openReadonlyWithNative() so the two call sites can't drift.
 *
 * MUST be called before opening any DB handle: loadConfig can throw (e.g. ConfigError
 * via resolveSecrets on a malformed llm.apiKeyCommand config), and an already-open
 * handle at that point would never be closed.
 */
function resolveDbSettings(
  customDbPath: string | undefined,
  engineOpt: 'native' | 'wasm' | 'auto' | undefined,
): ResolvedDbSettings {
  const config = loadConfig(deriveRootDirFromDbPath(customDbPath));
  // config.build.engine is already populated from CODEGRAPH_ENGINE env by applyEnvOverrides,
  // so this covers both the env-var path and the .codegraphrc.json config-file path.
  return {
    engine: engineOpt ?? config.build.engine ?? 'auto',
    busyTimeoutMs: config.db.busyTimeoutMs ?? DEFAULTS.db.busyTimeoutMs,
  };
}

/**
 * Resolve config.db.busyTimeoutMs alone, for the ad-hoc read-only query call
 * sites (features/*, domain/analysis/*, domain/search/*) that call
 * openReadonlyOrFail() directly and don't need engine selection. Shares
 * rootDir derivation with resolveDbSettings() so the two can't drift.
 *
 * MUST be called before opening any DB handle, for the same reason as
 * resolveDbSettings(): loadConfig can throw (e.g. ConfigError via
 * resolveSecrets on a malformed llm.apiKeyCommand config), and an
 * already-open handle at that point would never be closed.
 */
export function resolveBusyTimeoutMs(customDbPath?: string): number {
  const config = loadConfig(deriveRootDirFromDbPath(customDbPath));
  return config.db?.busyTimeoutMs ?? DEFAULTS.db.busyTimeoutMs;
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
 * True when an error message indicates the SQLite database is busy or locked
 * (SQLITE_BUSY/SQLITE_LOCKED). Shared by openRepo()'s and
 * openReadonlyWithNative()'s native-path catch blocks so the two call sites
 * can't drift.
 */
function isBusyOrLockedError(msg: string): boolean {
  return /\b(busy|locked|SQLITE_BUSY|SQLITE_LOCKED)\b/i.test(msg);
}

/** Validate and wrap an injected `opts.repo` Repository instance (no DB opened). */
function wrapInjectedRepo(repo: Repository): { repo: Repository; close(): void } {
  if (!(repo instanceof Repository)) {
    throw new TypeError(
      `openRepo: opts.repo must be a Repository instance, got ${Object.prototype.toString.call(repo)}`,
    );
  }
  return { repo, close() {} };
}

/**
 * Attempt the native rusqlite path (Phase 6.14) when the resolved engine
 * allows it. Re-throws user-visible errors (DB not found, busy/locked) since
 * falling back to better-sqlite3 wouldn't help; returns undefined for other
 * native failures so the caller falls back to better-sqlite3.
 */
function tryOpenRepoNative(
  customDbPath: string | undefined,
  engine: 'native' | 'wasm' | 'auto',
): { repo: Repository; close(): void } | undefined {
  if (engine === 'wasm' || !isNativeAvailable()) return undefined;
  try {
    return openRepoNative(customDbPath);
  } catch (e) {
    // Re-throw user-visible errors (e.g. DB not found) — only silently
    // fall back for native-engine failures (e.g. incompatible native binary).
    if (e instanceof DbError) throw e;
    // Re-throw locking/busy errors — falling back to better-sqlite3 would
    // hit the same contention (and potentially hang without busy_timeout).
    const msg = toErrorMessage(e);
    if (isBusyOrLockedError(msg)) {
      throw new DbError(`Database is busy (another process may be writing): ${msg}`, {});
    }
    debug(`openRepo: native path failed, falling back to better-sqlite3: ${msg}`);
    return undefined;
  }
}

/** Open the better-sqlite3 fallback repo used when the native path is unavailable or opted out. */
function openRepoSqliteFallback(
  customDbPath: string | undefined,
  busyTimeoutMs: number,
): { repo: Repository; close(): void } {
  const db = openReadonlyOrFail(customDbPath, busyTimeoutMs);
  return {
    repo: new SqliteRepository(db),
    close() {
      db.close();
    },
  };
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
  opts: { repo?: Repository; engine?: 'native' | 'wasm' | 'auto' } = {},
): { repo: Repository; close(): void } {
  if (opts.repo != null) {
    return wrapInjectedRepo(opts.repo);
  }

  // Respect explicit engine selection: opts.engine > config.build.engine > auto.
  // This ensures --engine wasm and benchmark workers bypass the native path.
  const { engine, busyTimeoutMs } = resolveDbSettings(customDbPath, opts.engine);

  const native = tryOpenRepoNative(customDbPath, engine);
  if (native) return native;

  return openRepoSqliteFallback(customDbPath, busyTimeoutMs);
}

/**
 * Open a readonly DB with an optional NativeDatabase alongside it.
 *
 * Returns the better-sqlite3 handle (for backwards compat) plus an optional
 * NativeDatabase for modules that can use batched Rust query methods.
 * Callers should use nativeDb when available and fall back to db.prepare().
 *
 * @param opts.engine - Per-call engine override: 'native' | 'wasm' | 'auto'.
 *   When omitted, falls back to config.build.engine then 'auto', mirroring
 *   the priority chain used by openRepo().
 */
export function openReadonlyWithNative(
  customPath?: string,
  opts: { engine?: 'native' | 'wasm' | 'auto' } = {},
): {
  db: BetterSqlite3Database;
  nativeDb: NativeDatabase | undefined;
  close(): void;
} {
  // Resolve engine (which may call loadConfig — and loadConfig can throw, e.g.
  // ConfigError via resolveSecrets on a malformed llm.apiKeyCommand config) BEFORE
  // opening the DB handle, mirroring openRepo()'s ordering. If this throws, no DB
  // handle has been opened yet, so nothing is left leaked. (Previously this ran
  // AFTER openReadonlyOrFail(), so a config error here leaked the already-open
  // better-sqlite3 handle — see the phase-15 gauntlet finding.)
  const { engine, busyTimeoutMs } = resolveDbSettings(customPath, opts.engine);

  const db = openReadonlyOrFail(customPath, busyTimeoutMs);

  let nativeDb: NativeDatabase | undefined;
  if (engine !== 'wasm' && isNativeAvailable()) {
    try {
      const dbPath = findDbPath(customPath);
      const native = getNative();
      nativeDb = native.NativeDatabase.openReadonly(dbPath);
    } catch (e) {
      const msg = toErrorMessage(e);
      if (isBusyOrLockedError(msg)) {
        debug(`openReadonlyWithNative: native path busy, skipping native DB: ${msg}`);
      } else {
        debug(`openReadonlyWithNative: native path failed: ${msg}`);
      }
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
