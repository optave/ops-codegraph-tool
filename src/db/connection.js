import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { debug, warn } from '../infrastructure/logger.js';
import { DbError } from '../shared/errors.js';
import { Repository } from './repository/base.js';
import { SqliteRepository } from './repository/sqlite-repository.js';

let _cachedRepoRoot; // undefined = not computed, null = not a git repo
let _cachedRepoRootCwd; // cwd at the time the cache was populated

/**
 * Return the git worktree/repo root for the given directory (or cwd).
 * Uses `git rev-parse --show-toplevel` which returns the correct root
 * for both regular repos and git worktrees.
 * Results are cached per-process when called without arguments.
 * The cache is keyed on cwd so it invalidates if the working directory changes
 * (e.g. MCP server serving multiple sessions).
 * @param {string} [fromDir] - Directory to resolve from (defaults to cwd)
 * @returns {string | null} Absolute path to repo root, or null if not in a git repo
 */
export function findRepoRoot(fromDir) {
  const dir = fromDir || process.cwd();
  if (!fromDir && _cachedRepoRoot !== undefined && _cachedRepoRootCwd === dir) {
    return _cachedRepoRoot;
  }
  let root = null;
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
      debug(`realpathSync failed for git root "${raw}", using resolve: ${e.message}`);
      root = path.resolve(raw);
    }
  } catch (e) {
    debug(`git rev-parse failed for "${dir}": ${e.message}`);
    root = null;
  }
  if (!fromDir) {
    _cachedRepoRoot = root;
    _cachedRepoRootCwd = dir;
  }
  return root;
}

/** Reset the cached repo root (for testing). */
export function _resetRepoRootCache() {
  _cachedRepoRoot = undefined;
  _cachedRepoRootCwd = undefined;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    debug(`PID ${pid} not alive: ${e.code || e.message}`);
    return false;
  }
}

function acquireAdvisoryLock(dbPath) {
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
    debug(`Advisory lock read failed: ${e.message}`);
  }
  try {
    fs.writeFileSync(lockPath, String(process.pid), 'utf-8');
  } catch (e) {
    debug(`Advisory lock write failed: ${e.message}`);
  }
}

function releaseAdvisoryLock(lockPath) {
  try {
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    if (Number(content) === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch (e) {
    debug(`Advisory lock release failed for ${lockPath}: ${e.message}`);
  }
}

/**
 * Check if two paths refer to the same directory.
 * Handles Windows 8.3 short names (RUNNER~1 vs runneradmin) and macOS
 * symlinks (/tmp vs /private/tmp) where string comparison fails.
 */
function isSameDirectory(a, b) {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch (e) {
    debug(`isSameDirectory stat failed: ${e.message}`);
    return false;
  }
}

export function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  acquireAdvisoryLock(dbPath);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.__lockPath = `${dbPath}.lock`;
  return db;
}

export function closeDb(db) {
  db.close();
  if (db.__lockPath) releaseAdvisoryLock(db.__lockPath);
}

export function findDbPath(customPath) {
  if (customPath) return path.resolve(customPath);
  const rawCeiling = findRepoRoot();
  // Normalize ceiling with realpathSync to resolve 8.3 short names (Windows
  // RUNNER~1 → runneradmin) and symlinks (macOS /var → /private/var).
  // findRepoRoot already applies realpathSync internally, but the git output
  // may still contain short names on some Windows CI environments.
  let ceiling;
  if (rawCeiling) {
    try {
      ceiling = fs.realpathSync(rawCeiling);
    } catch (e) {
      debug(`realpathSync failed for ceiling "${rawCeiling}": ${e.message}`);
      ceiling = rawCeiling;
    }
  } else {
    ceiling = null;
  }
  // Resolve symlinks (e.g. macOS /var → /private/var) so dir matches ceiling from git
  let dir;
  try {
    dir = fs.realpathSync(process.cwd());
  } catch (e) {
    debug(`realpathSync failed for cwd: ${e.message}`);
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

/**
 * Open a database in readonly mode, with a user-friendly error if the DB doesn't exist.
 */
export function openReadonlyOrFail(customPath) {
  const dbPath = findDbPath(customPath);
  if (!fs.existsSync(dbPath)) {
    throw new DbError(
      `No codegraph database found at ${dbPath}.\nRun "codegraph build" first to analyze your codebase.`,
      { file: dbPath },
    );
  }
  return new Database(dbPath, { readonly: true });
}

/**
 * Open a Repository from either an injected instance or a DB path.
 *
 * When `opts.repo` is a Repository instance, returns it directly (no DB opened).
 * Otherwise opens a readonly SQLite DB and wraps it in SqliteRepository.
 *
 * @param {string} [customDbPath] - Path to graph.db (ignored when opts.repo is set)
 * @param {object} [opts]
 * @param {Repository} [opts.repo] - Pre-built Repository to use instead of SQLite
 * @returns {{ repo: Repository, close(): void }}
 */
export function openRepo(customDbPath, opts = {}) {
  if (opts.repo != null) {
    if (!(opts.repo instanceof Repository)) {
      throw new TypeError(
        `openRepo: opts.repo must be a Repository instance, got ${Object.prototype.toString.call(opts.repo)}`,
      );
    }
    return { repo: opts.repo, close() {} };
  }
  const db = openReadonlyOrFail(customDbPath);
  return {
    repo: new SqliteRepository(db),
    close() {
      db.close();
    },
  };
}
