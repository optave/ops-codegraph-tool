import fs from 'node:fs';
import path from 'node:path';
import { debug, warn } from '../../infrastructure/logger.js';

export const JOURNAL_FILENAME = 'changes.journal';
const HEADER_PREFIX = '# codegraph-journal v1 ';

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
  const dir = path.join(rootDir, '.codegraph');
  const journalPath = path.join(dir, JOURNAL_FILENAME);

  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(journalPath)) {
    fs.writeFileSync(journalPath, `${HEADER_PREFIX}0\n`);
  }

  const lines = entries.map((e) => {
    if (e.deleted) return `DELETED ${e.file}`;
    return e.file;
  });

  fs.appendFileSync(journalPath, `${lines.join('\n')}\n`);
}

export function writeJournalHeader(rootDir: string, timestamp: number): void {
  const dir = path.join(rootDir, '.codegraph');
  const journalPath = path.join(dir, JOURNAL_FILENAME);
  const tmpPath = `${journalPath}.tmp`;

  fs.mkdirSync(dir, { recursive: true });

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
  const dir = path.join(rootDir, '.codegraph');
  const journalPath = path.join(dir, JOURNAL_FILENAME);
  const tmpPath = `${journalPath}.tmp`;

  fs.mkdirSync(dir, { recursive: true });

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
}
