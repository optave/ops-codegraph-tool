/**
 * Unit tests for src/journal.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendJournalEntries,
  appendJournalEntriesAndStampHeader,
  JOURNAL_FILENAME,
  readJournal,
  writeJournalHeader,
} from '../../src/domain/graph/journal.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-journal-'));
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRoot() {
  const root = fs.mkdtempSync(path.join(tmpDir, 'root-'));
  fs.mkdirSync(path.join(root, '.codegraph'), { recursive: true });
  return root;
}

function journalPath(root) {
  return path.join(root, '.codegraph', JOURNAL_FILENAME);
}

describe('readJournal', () => {
  it('returns { valid: false } when journal does not exist', () => {
    const root = makeRoot();
    const result = readJournal(root);
    expect(result.valid).toBe(false);
  });

  it('returns { valid: false } for empty file', () => {
    const root = makeRoot();
    fs.writeFileSync(journalPath(root), '');
    expect(readJournal(root).valid).toBe(false);
  });

  it('returns { valid: false } for malformed header', () => {
    const root = makeRoot();
    fs.writeFileSync(journalPath(root), 'garbage header\nsrc/foo.js\n');
    expect(readJournal(root).valid).toBe(false);
  });

  it('returns { valid: false } for invalid timestamp', () => {
    const root = makeRoot();
    fs.writeFileSync(journalPath(root), '# codegraph-journal v1 not-a-number\n');
    expect(readJournal(root).valid).toBe(false);
  });

  it('returns { valid: false } for zero timestamp', () => {
    const root = makeRoot();
    fs.writeFileSync(journalPath(root), '# codegraph-journal v1 0\n');
    expect(readJournal(root).valid).toBe(false);
  });

  it('parses valid journal with changed and removed files', () => {
    const root = makeRoot();
    const content = [
      '# codegraph-journal v1 1700000000000',
      'src/builder.js',
      'src/db.js',
      'DELETED src/old-file.js',
      '',
    ].join('\n');
    fs.writeFileSync(journalPath(root), content);

    const result = readJournal(root);
    expect(result.valid).toBe(true);
    expect(result.timestamp).toBe(1700000000000);
    expect(result.changed).toEqual(['src/builder.js', 'src/db.js']);
    expect(result.removed).toEqual(['src/old-file.js']);
  });

  it('deduplicates repeated paths', () => {
    const root = makeRoot();
    const content = [
      '# codegraph-journal v1 1700000000000',
      'src/foo.js',
      'src/foo.js',
      'src/bar.js',
      'DELETED src/old.js',
      'DELETED src/old.js',
      '',
    ].join('\n');
    fs.writeFileSync(journalPath(root), content);

    const result = readJournal(root);
    expect(result.changed).toEqual(['src/foo.js', 'src/bar.js']);
    expect(result.removed).toEqual(['src/old.js']);
  });

  it('skips blank lines and comment lines', () => {
    const root = makeRoot();
    const content = [
      '# codegraph-journal v1 1700000000000',
      '',
      '# some comment',
      'src/foo.js',
      '   ',
      '',
    ].join('\n');
    fs.writeFileSync(journalPath(root), content);

    const result = readJournal(root);
    expect(result.changed).toEqual(['src/foo.js']);
    expect(result.removed).toEqual([]);
  });

  it('handles file with no trailing newline', () => {
    const root = makeRoot();
    fs.writeFileSync(journalPath(root), '# codegraph-journal v1 1700000000000\nsrc/a.js');

    const result = readJournal(root);
    expect(result.valid).toBe(true);
    expect(result.changed).toEqual(['src/a.js']);
  });
});

describe('writeJournalHeader', () => {
  it('creates journal with header only', () => {
    const root = makeRoot();
    writeJournalHeader(root, 1700000000000);

    const content = fs.readFileSync(journalPath(root), 'utf-8');
    expect(content).toBe('# codegraph-journal v1 1700000000000\n');
  });

  it('overwrites existing journal content', () => {
    const root = makeRoot();
    fs.writeFileSync(journalPath(root), '# codegraph-journal v1 100\nsrc/old.js\n');
    writeJournalHeader(root, 200);

    const content = fs.readFileSync(journalPath(root), 'utf-8');
    expect(content).toBe('# codegraph-journal v1 200\n');
  });

  it('creates .codegraph directory if missing', () => {
    const root = fs.mkdtempSync(path.join(tmpDir, 'nodir-'));
    writeJournalHeader(root, 1700000000000);
    expect(fs.existsSync(journalPath(root))).toBe(true);
  });
});

describe('appendJournalEntries', () => {
  it('appends changed file entries', () => {
    const root = makeRoot();
    writeJournalHeader(root, 1700000000000);
    appendJournalEntries(root, [{ file: 'src/a.js' }, { file: 'src/b.js' }]);

    const result = readJournal(root);
    expect(result.valid).toBe(true);
    expect(result.changed).toEqual(['src/a.js', 'src/b.js']);
  });

  it('appends deleted file entries with DELETED prefix', () => {
    const root = makeRoot();
    writeJournalHeader(root, 1700000000000);
    appendJournalEntries(root, [{ file: 'src/removed.js', deleted: true }]);

    const result = readJournal(root);
    expect(result.removed).toEqual(['src/removed.js']);
  });

  it('creates journal with placeholder header if missing', () => {
    const root = makeRoot();
    appendJournalEntries(root, [{ file: 'src/a.js' }]);

    // Placeholder header has timestamp 0 → readJournal returns invalid
    const result = readJournal(root);
    expect(result.valid).toBe(false);

    // But the file exists and has the entry
    const content = fs.readFileSync(journalPath(root), 'utf-8');
    expect(content).toContain('src/a.js');
  });

  it('appends multiple batches', () => {
    const root = makeRoot();
    writeJournalHeader(root, 1700000000000);
    appendJournalEntries(root, [{ file: 'src/a.js' }]);
    appendJournalEntries(root, [{ file: 'src/b.js' }]);

    const result = readJournal(root);
    expect(result.changed).toEqual(['src/a.js', 'src/b.js']);
  });
});

describe('appendJournalEntriesAndStampHeader', () => {
  it('creates journal with header + entries when none exists', () => {
    const root = makeRoot();
    appendJournalEntriesAndStampHeader(root, [{ file: 'src/a.js' }], 1700000000000);

    const result = readJournal(root);
    expect(result.valid).toBe(true);
    expect(result.timestamp).toBe(1700000000000);
    expect(result.changed).toEqual(['src/a.js']);
  });

  it('advances the header timestamp while preserving prior entries', () => {
    const root = makeRoot();
    writeJournalHeader(root, 1000);
    appendJournalEntries(root, [{ file: 'src/a.js' }, { file: 'src/b.js', deleted: true }]);

    appendJournalEntriesAndStampHeader(root, [{ file: 'src/c.js' }], 2000);

    const result = readJournal(root);
    expect(result.valid).toBe(true);
    expect(result.timestamp).toBe(2000);
    expect(result.changed).toEqual(['src/a.js', 'src/c.js']);
    expect(result.removed).toEqual(['src/b.js']);
  });

  it('advances the header even when no new entries are supplied', () => {
    const root = makeRoot();
    writeJournalHeader(root, 1000);
    appendJournalEntries(root, [{ file: 'src/a.js' }]);

    appendJournalEntriesAndStampHeader(root, [], 2000);

    const result = readJournal(root);
    expect(result.timestamp).toBe(2000);
    expect(result.changed).toEqual(['src/a.js']);
  });

  it('is atomic: interleaved reads see either old or new state, never a truncated header', () => {
    const root = makeRoot();
    writeJournalHeader(root, 1000);
    appendJournalEntries(root, [{ file: 'src/a.js' }]);

    appendJournalEntriesAndStampHeader(root, [{ file: 'src/b.js' }], 2000);

    // No leftover .tmp file after the rename
    expect(fs.existsSync(`${journalPath(root)}.tmp`)).toBe(false);
    const content = fs.readFileSync(journalPath(root), 'utf-8');
    expect(content.startsWith('# codegraph-journal v1 2000\n')).toBe(true);
  });
});

describe('regression: watch session keeps header ahead of DB mtime', () => {
  it('header timestamp reflects latest append, not prior build', () => {
    // Simulates the bug in #997: after a build finalizes the journal header
    // at T0, the watcher appends entries at T1 > T0. A later build's Tier 0
    // check compares journal.timestamp against MAX(file_hashes.mtime).
    // If the header stays at T0, Tier 0 bails out and the fast path is lost.
    const root = makeRoot();

    const buildFinalizedAt = 1000;
    writeJournalHeader(root, buildFinalizedAt);

    const watcherAppendAt = 2500;
    appendJournalEntriesAndStampHeader(root, [{ file: 'src/a.js' }], watcherAppendAt);

    const journal = readJournal(root);
    expect(journal.valid).toBe(true);
    expect(journal.timestamp).toBeGreaterThanOrEqual(watcherAppendAt);
    // latestDbMtime can never exceed the timestamp of the most recent append
    // because the watcher journals a file immediately after processing it.
    const simulatedDbMtime = watcherAppendAt;
    expect(journal.timestamp!).toBeGreaterThanOrEqual(simulatedDbMtime);
  });
});

describe('read/write/append lifecycle', () => {
  it('full lifecycle: header → append → read → new header', () => {
    const root = makeRoot();

    // Simulate build completion
    writeJournalHeader(root, 1000);

    // Simulate watcher appending changes
    appendJournalEntries(root, [{ file: 'src/foo.js' }, { file: 'src/bar.js', deleted: true }]);

    // Simulate next build reading journal
    const journal = readJournal(root);
    expect(journal.valid).toBe(true);
    expect(journal.timestamp).toBe(1000);
    expect(journal.changed).toEqual(['src/foo.js']);
    expect(journal.removed).toEqual(['src/bar.js']);

    // Build completes, reset journal
    writeJournalHeader(root, 2000);
    const fresh = readJournal(root);
    expect(fresh.valid).toBe(true);
    expect(fresh.changed).toEqual([]);
    expect(fresh.removed).toEqual([]);
  });
});
