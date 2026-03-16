import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DbError } from '../shared/errors.js';
import { warn } from '../infrastructure/logger.js';

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
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, '.codegraph', 'graph.db');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), '.codegraph', 'graph.db');
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
