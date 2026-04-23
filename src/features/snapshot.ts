import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDatabase } from '../db/better-sqlite3.js';
import { findDbPath } from '../db/index.js';
import { debug } from '../infrastructure/logger.js';
import { ConfigError, DbError } from '../shared/errors.js';

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

export function validateSnapshotName(name: string): void {
  if (!name || !NAME_RE.test(name)) {
    throw new ConfigError(
      `Invalid snapshot name "${name}". Use only letters, digits, hyphens, and underscores.`,
    );
  }
}

export function snapshotsDir(dbPath: string): string {
  return path.join(path.dirname(dbPath), 'snapshots');
}

interface SnapshotSaveOptions {
  dbPath?: string;
  force?: boolean;
}

export function snapshotSave(
  name: string,
  options: SnapshotSaveOptions = {},
): { name: string; path: string; size: number } {
  validateSnapshotName(name);
  const dbPath = options.dbPath || findDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new DbError(`Database not found: ${dbPath}`, { file: dbPath });
  }

  const dir = snapshotsDir(dbPath);
  const dest = path.join(dir, `${name}.db`);

  // Cheap fail-fast for the common non-force case; the authoritative check
  // below uses an atomic linkSync that closes the TOCTOU window.
  if (!options.force && fs.existsSync(dest)) {
    throw new ConfigError(`Snapshot "${name}" already exists. Use --force to overwrite.`);
  }

  fs.mkdirSync(dir, { recursive: true });

  // VACUUM INTO a unique temp path on the same filesystem, then atomically
  // place it at the destination. This closes the TOCTOU window between
  // existsSync/unlinkSync/VACUUM INTO where two concurrent saves could
  // observe a missing file or interleave their VACUUM writes.
  //
  // Unique temp name: process.pid is shared across worker_threads in the
  // same process, so we add random bytes to keep concurrent callers in any
  // thread from colliding on the temp path.
  const tmp = path.join(
    dir,
    `.${name}.db.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`,
  );
  try {
    fs.unlinkSync(tmp);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const Database = getDatabase();
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  try {
    if (options.force) {
      // renameSync overwrites atomically — the correct semantics for --force.
      fs.renameSync(tmp, dest);
    } else {
      // Non-force path: linkSync fails atomically with EEXIST if dest exists,
      // closing the TOCTOU window between existsSync above and the final
      // placement. We then unlink the temp file; on POSIX and NTFS, link
      // creates a second reference so tmp can safely be removed.
      try {
        fs.linkSync(tmp, dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new ConfigError(`Snapshot "${name}" already exists. Use --force to overwrite.`);
        }
        throw err;
      }
      try {
        fs.unlinkSync(tmp);
      } catch (cleanupErr) {
        // Best-effort — dest is already in place, so a leftover tmp file is
        // harmless. Log at debug so repeated failures surface during
        // troubleshooting without noising up normal operation.
        debug(`snapshotSave: failed to remove temp file ${tmp}: ${cleanupErr}`);
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (cleanupErr) {
      if ((cleanupErr as NodeJS.ErrnoException).code !== 'ENOENT') {
        debug(`snapshotSave: failed to remove temp file ${tmp}: ${cleanupErr}`);
      }
    }
    throw err;
  }

  const stat = fs.statSync(dest);
  debug(`Snapshot saved: ${dest} (${stat.size} bytes)`);
  return { name, path: dest, size: stat.size };
}

interface SnapshotDbPathOptions {
  dbPath?: string;
}

export function snapshotRestore(name: string, options: SnapshotDbPathOptions = {}): void {
  validateSnapshotName(name);
  const dbPath = options.dbPath || findDbPath();
  const dir = snapshotsDir(dbPath);
  const src = path.join(dir, `${name}.db`);

  if (!fs.existsSync(src)) {
    throw new DbError(`Snapshot "${name}" not found at ${src}`, { file: src });
  }

  // Remove WAL/SHM sidecars first so the old journal can't be replayed over
  // the restored DB. unlink then check ENOENT — avoids the existsSync/unlinkSync
  // race another process could wedge into.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = dbPath + suffix;
    try {
      fs.unlinkSync(sidecar);
      debug(`Removed sidecar: ${sidecar}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  // Copy to a temp path next to the DB, then rename atomically. Readers that
  // open dbPath during restore see either the pre-restore or post-restore
  // file, never a partially-written one.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.restore-tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dbPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (cleanupErr) {
      if ((cleanupErr as NodeJS.ErrnoException).code !== 'ENOENT') {
        debug(`snapshotRestore: failed to remove temp file ${tmp}: ${cleanupErr}`);
      }
    }
    throw err;
  }

  debug(`Restored snapshot "${name}" → ${dbPath}`);
}

interface SnapshotEntry {
  name: string;
  path: string;
  size: number;
  createdAt: Date;
}

export function snapshotList(options: SnapshotDbPathOptions = {}): SnapshotEntry[] {
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
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export function snapshotDelete(name: string, options: SnapshotDbPathOptions = {}): void {
  validateSnapshotName(name);
  const dbPath = options.dbPath || findDbPath();
  const dir = snapshotsDir(dbPath);
  const target = path.join(dir, `${name}.db`);

  try {
    fs.unlinkSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DbError(`Snapshot "${name}" not found at ${target}`, { file: target });
    }
    throw err;
  }
  debug(`Deleted snapshot: ${target}`);
}
