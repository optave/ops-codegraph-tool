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

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

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

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

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
