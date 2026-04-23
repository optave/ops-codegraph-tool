import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { debug, warn } from '../../infrastructure/logger.js';

export const JOURNAL_FILENAME = 'changes.journal';
const HEADER_PREFIX = '# codegraph-journal v1 ';
const LOCK_SUFFIX = '.lock';
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;

// Busy-spin sleep avoids blocking the Node.js event loop (unlike Atomics.wait,
// which freezes all I/O and timer callbacks). The retry interval is short
// (25ms), so the CPU cost is negligible while keeping unrelated callbacks
// responsive in watcher processes.
function sleepSync(ms: number): void {
  const end = process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
  while (process.hrtime.bigint() < end) {
    /* spin */
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we lack permission — still alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface AcquiredLock {
  fd: number;
  nonce: string;
}

/**
 * Steal a stale lockfile atomically via write-tmp + rename.
 *
 * Using rename (which is atomic on POSIX and Windows) avoids the TOCTOU race
 * inherent to the unlink + openSync('wx') pattern: if two stealers both
 * observed the same stale holder, one's unlink could cross the other's fresh
 * acquisition, admitting two writers into the critical section.
 *
 * After rename, we re-read the lockfile to confirm our nonce — if another
 * stealer's rename landed after ours, they own the lock and we retry.
 */
function trySteal(lockPath: string): AcquiredLock | null {
  const nonce = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const tmpPath = `${lockPath}.${nonce}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${process.pid}\n${nonce}\n`, { flag: 'w' });
  } catch {
    return null;
  }

  try {
    // Atomic replace: overwrites the stale lockfile.
    fs.renameSync(tmpPath, lockPath);
  } catch {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    return null;
  }

  // Verify the nonce — another stealer's rename may have landed after ours.
  let content: string;
  try {
    content = fs.readFileSync(lockPath, 'utf-8');
  } catch {
    return null;
  }
  if (!content.includes(nonce)) {
    // Lost the race to another stealer; do NOT unlink their live lockfile.
    return null;
  }

  let fd: number;
  try {
    // Re-open r+ so we have a persistent fd the caller can close on release.
    fd = fs.openSync(lockPath, 'r+');
  } catch {
    return null;
  }
  return { fd, nonce };
}

function acquireJournalLock(lockPath: string): AcquiredLock {
  const start = Date.now();
  for (;;) {
    const nonce = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, `${process.pid}\n${nonce}\n`);
      } catch {
        // Stamp write failed (ENOSPC, I/O error). An empty lockfile would
        // look stale to concurrent waiters (Number('') === 0, isPidAlive(0)
        // returns false), so they'd steal our live lock. Release and retry.
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
        if (Date.now() - start > LOCK_TIMEOUT_MS) {
          throw new Error(
            `Failed to acquire journal lock at ${lockPath} within ${LOCK_TIMEOUT_MS}ms`,
          );
        }
        sleepSync(LOCK_RETRY_MS);
        continue;
      }
      return { fd, nonce };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    let holderAlive = true;
    try {
      const pidContent = fs.readFileSync(lockPath, 'utf-8').split('\n')[0]!.trim();
      holderAlive = isPidAlive(Number(pidContent));
    } catch {
      /* unreadable — fall through to age check */
    }

    let shouldSteal = !holderAlive;
    if (holderAlive) {
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          shouldSteal = true;
        }
      } catch {
        /* stat failed — keep retrying */
      }
    }

    if (shouldSteal) {
      const stolen = trySteal(lockPath);
      if (stolen) return stolen;
      // Steal failed or lost the race — fall through to timeout check & retry.
    }

    if (Date.now() - start > LOCK_TIMEOUT_MS) {
      throw new Error(`Failed to acquire journal lock at ${lockPath} within ${LOCK_TIMEOUT_MS}ms`);
    }
    sleepSync(LOCK_RETRY_MS);
  }
}

function releaseJournalLock(lockPath: string, lock: AcquiredLock): void {
  try {
    fs.closeSync(lock.fd);
  } catch {
    /* ignore */
  }
  // Only unlink if the lockfile still carries our nonce — if another stealer
  // decided we were stale and replaced it, we must not unlink their live lock.
  try {
    const content = fs.readFileSync(lockPath, 'utf-8');
    if (content.includes(lock.nonce)) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    /* lockfile gone or unreadable — nothing to unlink */
  }
}

function withJournalLock<T>(rootDir: string, fn: () => T): T {
  const dir = path.join(rootDir, '.codegraph');
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, `${JOURNAL_FILENAME}${LOCK_SUFFIX}`);
  const lock = acquireJournalLock(lockPath);
  try {
    return fn();
  } finally {
    releaseJournalLock(lockPath, lock);
  }
}

interface JournalResult {
  valid: boolean;
  timestamp?: number;
  changed?: string[];
  removed?: string[];
}

export function readJournal(rootDir: string): JournalResult {
  const journalPath = path.join(rootDir, '.codegraph', JOURNAL_FILENAME);
  let content: string;
  try {
    content = fs.readFileSync(journalPath, 'utf-8');
  } catch {
    return { valid: false };
  }

  const lines = content.split('\n');
  if (lines.length === 0 || !lines[0]!.startsWith(HEADER_PREFIX)) {
    debug('Journal has malformed or missing header');
    return { valid: false };
  }

  const timestamp = Number(lines[0]!.slice(HEADER_PREFIX.length).trim());
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    debug('Journal has invalid timestamp');
    return { valid: false };
  }

  const changed: string[] = [];
  const removed: string[] = [];
  const seenChanged = new Set<string>();
  const seenRemoved = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('DELETED ')) {
      const filePath = line.slice(8);
      if (filePath && !seenRemoved.has(filePath)) {
        seenRemoved.add(filePath);
        removed.push(filePath);
      }
    } else {
      if (!seenChanged.has(line)) {
        seenChanged.add(line);
        changed.push(line);
      }
    }
  }

  return { valid: true, timestamp, changed, removed };
}

export function appendJournalEntries(
  rootDir: string,
  entries: Array<{ file: string; deleted?: boolean }>,
): void {
  withJournalLock(rootDir, () => {
    const journalPath = path.join(rootDir, '.codegraph', JOURNAL_FILENAME);

    if (!fs.existsSync(journalPath)) {
      fs.writeFileSync(journalPath, `${HEADER_PREFIX}0\n`);
    }

    const lines = entries.map((e) => {
      if (e.deleted) return `DELETED ${e.file}`;
      return e.file;
    });

    fs.appendFileSync(journalPath, `${lines.join('\n')}\n`);
  });
}

export function writeJournalHeader(rootDir: string, timestamp: number): void {
  withJournalLock(rootDir, () => {
    const journalPath = path.join(rootDir, '.codegraph', JOURNAL_FILENAME);
    const tmpPath = `${journalPath}.tmp`;

    try {
      fs.writeFileSync(tmpPath, `${HEADER_PREFIX}${timestamp}\n`);
      fs.renameSync(tmpPath, journalPath);
    } catch (err) {
      warn(`Failed to write journal header: ${(err as Error).message}`);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  });
}

/**
 * Atomically append entries while advancing the header timestamp.
 *
 * Used by the watcher: without this, the header timestamp stays frozen at the
 * last build's finalize time while entries accumulate, so the next build's
 * Tier 0 check sees `journal.timestamp < MAX(file_hashes.mtime)`, rejects the
 * journal, and falls through to the expensive mtime+size / hash scan.
 *
 * Writes a tmp file then renames — a crash mid-rename leaves the previous
 * journal state intact.
 */
export function appendJournalEntriesAndStampHeader(
  rootDir: string,
  entries: Array<{ file: string; deleted?: boolean }>,
  timestamp: number,
): void {
  withJournalLock(rootDir, () => {
    const journalPath = path.join(rootDir, '.codegraph', JOURNAL_FILENAME);
    const tmpPath = `${journalPath}.tmp`;

    let existingBody = '';
    try {
      const content = fs.readFileSync(journalPath, 'utf-8');
      const newlineIdx = content.indexOf('\n');
      if (newlineIdx >= 0) existingBody = content.slice(newlineIdx + 1);
    } catch {
      /* no existing journal — fall through to write header + new entries */
    }
    if (existingBody && !existingBody.endsWith('\n')) existingBody = `${existingBody}\n`;

    const newLines = entries.map((e) => (e.deleted ? `DELETED ${e.file}` : e.file));
    const appended = newLines.length > 0 ? `${newLines.join('\n')}\n` : '';
    const content = `${HEADER_PREFIX}${timestamp}\n${existingBody}${appended}`;

    try {
      fs.writeFileSync(tmpPath, content);
      fs.renameSync(tmpPath, journalPath);
    } catch (err) {
      warn(`Failed to update journal: ${(err as Error).message}`);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  });
}
