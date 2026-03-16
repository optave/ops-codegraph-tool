import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { debug, warn } from '../infrastructure/logger.js';
import { DbError } from '../shared/errors.js';

let _cachedRepoRoot; // undefined = not computed, null = not a git repo

/**
 * Return the git worktree/repo root for the given directory (or cwd).
 * Uses `git rev-parse --show-toplevel` which returns the correct root
 * for both regular repos and git worktrees.
 * Results are cached per-process when called without arguments.
 * @param {string} [fromDir] - Directory to resolve from (defaults to cwd)
 * @returns {string | null} Absolute path to repo root, or null if not in a git repo
 */
export function findRepoRoot(fromDir) {
  const dir = fromDir || process.cwd();
  if (!fromDir && _cachedRepoRoot !== undefined) return _cachedRepoRoot;
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
    } catch {
      root = path.resolve(raw);
    }
  } catch {
    root = null;
  }
  if (!fromDir) _cachedRepoRoot = root;
  return root;
}

/** Reset the cached repo root (for testing). */
export function _resetRepoRootCache() {
  _cachedRepoRoot = undefined;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
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
  } catch {
    /* ignore read errors */
  }
  try {
    fs.writeFileSync(lockPath, String(process.pid), 'utf-8');
  } catch {
    /* best-effort */
  }
}

function releaseAdvisoryLock(lockPath) {
  try {
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    if (Number(content) === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    /* ignore */
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
  const ceiling = findRepoRoot();
  // Resolve symlinks (e.g. macOS /var → /private/var) so dir matches ceiling from git
  let dir;
  try {
    dir = fs.realpathSync(process.cwd());
  } catch {
    dir = process.cwd();
  }
  while (true) {
    const candidate = path.join(dir, '.codegraph', 'graph.db');
    if (fs.existsSync(candidate)) return candidate;
    if (ceiling && path.resolve(dir) === ceiling) {
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
