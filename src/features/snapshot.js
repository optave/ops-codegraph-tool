import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { findDbPath } from '../db/index.js';
import { ConfigError, DbError } from '../errors.js';
import { debug } from '../logger.js';

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate a snapshot name (alphanumeric, hyphens, underscores only).
 * Throws on invalid input.
 */
export function validateSnapshotName(name) {
  if (!name || !NAME_RE.test(name)) {
    throw new ConfigError(
      `Invalid snapshot name "${name}". Use only letters, digits, hyphens, and underscores.`,
    );
  }
}

/**
 * Return the snapshots directory for a given DB path.
 */
export function snapshotsDir(dbPath) {
  return path.join(path.dirname(dbPath), 'snapshots');
}

/**
 * Save a snapshot of the current graph database.
 * Uses VACUUM INTO for an atomic, WAL-free copy.
 *
 * @param {string} name - Snapshot name
 * @param {object} [options]
 * @param {string} [options.dbPath] - Explicit path to graph.db
 * @param {boolean} [options.force] - Overwrite existing snapshot
 * @returns {{ name: string, path: string, size: number }}
 */
export function snapshotSave(name, options = {}) {
  validateSnapshotName(name);
  const dbPath = options.dbPath || findDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new DbError(`Database not found: ${dbPath}`, { file: dbPath });
  }

  const dir = snapshotsDir(dbPath);
  const dest = path.join(dir, `${name}.db`);

  if (fs.existsSync(dest)) {
    if (!options.force) {
      throw new ConfigError(`Snapshot "${name}" already exists. Use --force to overwrite.`);
    }
    fs.unlinkSync(dest);
    debug(`Deleted existing snapshot: ${dest}`);
  }

  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  const stat = fs.statSync(dest);
  debug(`Snapshot saved: ${dest} (${stat.size} bytes)`);
  return { name, path: dest, size: stat.size };
}

/**
 * Restore a snapshot over the current graph database.
 * Removes WAL/SHM sidecar files before overwriting.
 *
 * @param {string} name - Snapshot name
 * @param {object} [options]
 * @param {string} [options.dbPath] - Explicit path to graph.db
 */
export function snapshotRestore(name, options = {}) {
  validateSnapshotName(name);
  const dbPath = options.dbPath || findDbPath();
  const dir = snapshotsDir(dbPath);
  const src = path.join(dir, `${name}.db`);

  if (!fs.existsSync(src)) {
    throw new DbError(`Snapshot "${name}" not found at ${src}`, { file: src });
  }

  // Remove WAL/SHM sidecar files for a clean restore
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = dbPath + suffix;
    if (fs.existsSync(sidecar)) {
      fs.unlinkSync(sidecar);
      debug(`Removed sidecar: ${sidecar}`);
    }
  }

  fs.copyFileSync(src, dbPath);
  debug(`Restored snapshot "${name}" → ${dbPath}`);
}

/**
 * List all saved snapshots.
 *
 * @param {object} [options]
 * @param {string} [options.dbPath] - Explicit path to graph.db
 * @returns {Array<{ name: string, path: string, size: number, createdAt: Date }>}
 */
export function snapshotList(options = {}) {
  const dbPath = options.dbPath || findDbPath();
  const dir = snapshotsDir(dbPath);

  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const filePath = path.join(dir, f);
      const stat = fs.statSync(filePath);
      return {
        name: f.replace(/\.db$/, ''),
        path: filePath,
        size: stat.size,
        createdAt: stat.birthtime,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Delete a named snapshot.
 *
 * @param {string} name - Snapshot name
 * @param {object} [options]
 * @param {string} [options.dbPath] - Explicit path to graph.db
 */
export function snapshotDelete(name, options = {}) {
  validateSnapshotName(name);
  const dbPath = options.dbPath || findDbPath();
  const dir = snapshotsDir(dbPath);
  const target = path.join(dir, `${name}.db`);

  if (!fs.existsSync(target)) {
    throw new DbError(`Snapshot "${name}" not found at ${target}`, { file: target });
  }

  fs.unlinkSync(target);
  debug(`Deleted snapshot: ${target}`);
}
