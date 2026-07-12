/**
 * Unit tests for `db/repository/deleted-export-advisories.ts` — the durable
 * pre-purge snapshot that lets `checkNoDeletedExportsInUse` still see a
 * deleted file's exported-symbol violations once a rebuild has already
 * purged its `nodes`/`edges` rows. See issue #1938.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import {
  clearDeletedExportAdvisories,
  getDeletedExportAdvisories,
  recordDeletedExportAdvisories,
} from '../../src/db/repository/deleted-export-advisories.js';

function insertNode(db, name, kind, file, line, exported = 0) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line, exported) VALUES (?, ?, ?, ?, ?)')
    .run(name, kind, file, line, exported).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence) VALUES (?, ?, ?, 1.0)',
  ).run(sourceId, targetId, kind);
}

let tmpDir: string;
let db: any;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-deleted-export-advisories-'));
  db = new Database(path.join(tmpDir, 'graph.db'));
  db.pragma('journal_mode = WAL');
  initSchema(db);
});

afterAll(() => {
  if (db) db.close();
});

describe('recordDeletedExportAdvisories', () => {
  test('captures one row per external consumer of an exported def', () => {
    const helperId = insertNode(db, 'helper', 'function', 'src/gone.js', 1, 1);
    const callerAId = insertNode(db, 'callerA', 'function', 'src/a.js', 1);
    const callerBId = insertNode(db, 'callerB', 'function', 'src/b.js', 1);
    insertEdge(db, callerAId, helperId, 'calls');
    insertEdge(db, callerBId, helperId, 'imports-type');

    recordDeletedExportAdvisories(db, ['src/gone.js']);

    const entries = getDeletedExportAdvisories(db, ['src/gone.js'], new Set());
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('helper');
    expect(entries[0].consumers.map((c) => c.file).sort()).toEqual(['src/a.js', 'src/b.js']);
  });

  test('does not record an advisory for an export with no external consumers', () => {
    insertNode(db, 'unusedHelper', 'function', 'src/orphan.js', 1, 1);

    recordDeletedExportAdvisories(db, ['src/orphan.js']);

    expect(getDeletedExportAdvisories(db, ['src/orphan.js'], new Set())).toEqual([]);
  });

  test('ignores a caller living in the same removed file', () => {
    const helperId = insertNode(db, 'helper', 'function', 'src/gone.js', 1, 1);
    const sameFileCallerId = insertNode(db, 'sibling', 'function', 'src/gone.js', 10);
    insertEdge(db, sameFileCallerId, helperId, 'calls');

    recordDeletedExportAdvisories(db, ['src/gone.js']);

    expect(getDeletedExportAdvisories(db, ['src/gone.js'], new Set())).toEqual([]);
  });

  test('is a no-op for an empty removed-files list', () => {
    insertNode(db, 'helper', 'function', 'src/gone.js', 1, 1);
    recordDeletedExportAdvisories(db, []);
    expect(getDeletedExportAdvisories(db, ['src/gone.js'], new Set())).toEqual([]);
  });

  test('replaces a prior snapshot for the same file rather than accumulating', () => {
    const helperId = insertNode(db, 'helper', 'function', 'src/gone.js', 1, 1);
    const callerAId = insertNode(db, 'callerA', 'function', 'src/a.js', 1);
    insertEdge(db, callerAId, helperId, 'calls');
    recordDeletedExportAdvisories(db, ['src/gone.js']);

    // Simulate a second capture pass (e.g. a redundant re-detection) with a
    // different consumer set — the stale first snapshot must not linger
    // alongside the fresh one.
    const callerCId = insertNode(db, 'callerC', 'function', 'src/c.js', 1);
    insertEdge(db, callerCId, helperId, 'calls');
    recordDeletedExportAdvisories(db, ['src/gone.js']);

    const entries = getDeletedExportAdvisories(db, ['src/gone.js'], new Set());
    expect(entries).toHaveLength(1);
    expect(entries[0].consumers.map((c) => c.file).sort()).toEqual(['src/a.js', 'src/c.js']);
  });

  test('preserves a persisted snapshot once the file nodes are purged, instead of erasing it on a repeat call', () => {
    // Regression test: `file_hashes` for a removed file is never purged on
    // the incremental path, so a subsequent build keeps re-detecting the
    // same file as "removed" and calls recordDeletedExportAdvisories again
    // long after its `nodes` rows are gone. That later call must not wipe
    // the snapshot captured while the nodes were still live (#1938).
    const helperId = insertNode(db, 'helper', 'function', 'src/gone.js', 1, 1);
    const callerAId = insertNode(db, 'callerA', 'function', 'src/a.js', 1);
    insertEdge(db, callerAId, helperId, 'calls');

    // First call: nodes are still live — this is the authoritative capture.
    recordDeletedExportAdvisories(db, ['src/gone.js']);
    expect(getDeletedExportAdvisories(db, ['src/gone.js'], new Set())).toHaveLength(1);

    // Simulate the purge that follows the capture in the real build
    // pipeline — src/gone.js's nodes (and the edges that reference them) are
    // gone, but its file_hashes row (not modeled here) lives on, so a later
    // build still passes it in removedFiles.
    db.prepare(
      'DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?) OR target_id IN (SELECT id FROM nodes WHERE file = ?)',
    ).run('src/gone.js', 'src/gone.js');
    db.prepare("DELETE FROM nodes WHERE file = 'src/gone.js'").run();

    recordDeletedExportAdvisories(db, ['src/gone.js']);

    const entries = getDeletedExportAdvisories(db, ['src/gone.js'], new Set());
    expect(entries).toHaveLength(1);
    expect(entries[0].consumers.map((c) => c.file)).toEqual(['src/a.js']);
  });
});

describe('getDeletedExportAdvisories', () => {
  test('excludes consumers whose file is in excludeConsumerFiles', () => {
    const helperId = insertNode(db, 'helper', 'function', 'src/gone.js', 1, 1);
    const callerAId = insertNode(db, 'callerA', 'function', 'src/a.js', 1);
    const callerBId = insertNode(db, 'callerB', 'function', 'src/b.js', 1);
    insertEdge(db, callerAId, helperId, 'calls');
    insertEdge(db, callerBId, helperId, 'calls');
    recordDeletedExportAdvisories(db, ['src/gone.js']);

    const entries = getDeletedExportAdvisories(db, ['src/gone.js'], new Set(['src/a.js']));
    expect(entries).toHaveLength(1);
    expect(entries[0].consumers.map((c) => c.file)).toEqual(['src/b.js']);
  });

  test('drops an entry entirely once all its consumers are excluded', () => {
    const helperId = insertNode(db, 'helper', 'function', 'src/gone.js', 1, 1);
    const callerAId = insertNode(db, 'callerA', 'function', 'src/a.js', 1);
    insertEdge(db, callerAId, helperId, 'calls');
    recordDeletedExportAdvisories(db, ['src/gone.js']);

    expect(getDeletedExportAdvisories(db, ['src/gone.js'], new Set(['src/a.js']))).toEqual([]);
  });

  test('returns nothing for a file with no recorded advisory', () => {
    expect(getDeletedExportAdvisories(db, ['src/never-deleted.js'], new Set())).toEqual([]);
  });
});

describe('clearDeletedExportAdvisories', () => {
  test('removes advisory rows for a file that has reappeared', () => {
    const helperId = insertNode(db, 'helper', 'function', 'src/gone.js', 1, 1);
    const callerAId = insertNode(db, 'callerA', 'function', 'src/a.js', 1);
    insertEdge(db, callerAId, helperId, 'calls');
    recordDeletedExportAdvisories(db, ['src/gone.js']);
    expect(getDeletedExportAdvisories(db, ['src/gone.js'], new Set())).toHaveLength(1);

    clearDeletedExportAdvisories(db, ['src/gone.js']);

    expect(getDeletedExportAdvisories(db, ['src/gone.js'], new Set())).toEqual([]);
  });

  test('leaves other files untouched', () => {
    const helperId = insertNode(db, 'helper', 'function', 'src/gone.js', 1, 1);
    const callerAId = insertNode(db, 'callerA', 'function', 'src/a.js', 1);
    insertEdge(db, callerAId, helperId, 'calls');
    const otherId = insertNode(db, 'otherHelper', 'function', 'src/other-gone.js', 1, 1);
    const otherCallerId = insertNode(db, 'otherCaller', 'function', 'src/d.js', 1);
    insertEdge(db, otherCallerId, otherId, 'calls');
    recordDeletedExportAdvisories(db, ['src/gone.js', 'src/other-gone.js']);

    clearDeletedExportAdvisories(db, ['src/gone.js']);

    expect(getDeletedExportAdvisories(db, ['src/gone.js'], new Set())).toEqual([]);
    expect(getDeletedExportAdvisories(db, ['src/other-gone.js'], new Set())).toHaveLength(1);
  });

  test('is a no-op for an empty file list', () => {
    const helperId = insertNode(db, 'helper', 'function', 'src/gone.js', 1, 1);
    const callerAId = insertNode(db, 'callerA', 'function', 'src/a.js', 1);
    insertEdge(db, callerAId, helperId, 'calls');
    recordDeletedExportAdvisories(db, ['src/gone.js']);

    clearDeletedExportAdvisories(db, []);

    expect(getDeletedExportAdvisories(db, ['src/gone.js'], new Set())).toHaveLength(1);
  });
});
