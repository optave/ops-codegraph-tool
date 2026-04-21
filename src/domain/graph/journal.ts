import fs from 'node:fs';
import path from 'node:path';
import { debug, warn } from '../../infrastructure/logger.js';

export const JOURNAL_FILENAME = 'changes.journal';
const HEADER_PREFIX = '# codegraph-journal v1 ';
const LOCK_SUFFIX = '.lock';
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;

function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
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

function acquireJournalLock(lockPath: string): number {
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, `${process.pid}\n`);
      } catch {
        /* PID stamp is advisory; fd is still exclusive */
      }
      return fd;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    let holderAlive = true;
    try {
      const pidContent = fs.readFileSync(lockPath, 'utf-8').trim();
      holderAlive = isPidAlive(Number(pidContent));
    } catch {
      /* unreadable — fall through to age check */
    }

    if (!holderAlive) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* another writer stole it first */
      }
      continue;
    }

    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* raced */
        }
        continue;
      }
    } catch {
      /* stat failed — keep retrying */
    }

    if (Date.now() - start > LOCK_TIMEOUT_MS) {
      throw new Error(`Failed to acquire journal lock at ${lockPath} within ${LOCK_TIMEOUT_MS}ms`);
    }
    sleepSync(LOCK_RETRY_MS);
  }
}

function releaseJournalLock(lockPath: string, fd: number): void {
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
}

function withJournalLock<T>(rootDir: string, fn: () => T): T {
  const dir = path.join(rootDir, '.codegraph');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const lockPath = path.join(dir, `${JOURNAL_FILENAME}${LOCK_SUFFIX}`);
  const fd = acquireJournalLock(lockPath);
  try {
    return fn();
  } finally {
    releaseJournalLock(lockPath, fd);
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
