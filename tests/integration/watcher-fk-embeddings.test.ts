/**
 * Regression test for #1176 — watch-mode rebuildFile must purge `embeddings`
 * before deleting nodes, otherwise `FOREIGN KEY constraint failed` crashes the
 * watcher (better-sqlite3 enforces FKs by default).
 *
 * Setup mirrors the user-reported reproduction: full build, write an
 * `embeddings` row referencing a node from the file we're about to rebuild,
 * then run `rebuildFile` and assert it returns cleanly.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getNodeId as getNodeIdQuery, initSchema, openDb } from '../../src/db/index.js';
import { rebuildFile } from '../../src/domain/graph/builder/incremental.js';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'deep-deps-project');

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function makeStmts(db: Database.Database): Parameters<typeof rebuildFile>[3] {
  return {
    insertNode: db.prepare(
      'INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
    ),
    getNodeId: {
      get: (name: string, kind: string, file: string, line: number) => {
        const id = getNodeIdQuery(db, name, kind, file, line);
        return id != null ? { id } : undefined;
      },
    },
    insertEdge: db.prepare(
      'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)',
    ),
    countNodes: db.prepare('SELECT COUNT(*) as c FROM nodes WHERE file = ?'),
    findNodeInFile: db.prepare(
      "SELECT id, file FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant') AND file = ?",
    ),
    findNodeByName: db.prepare(
      "SELECT id, file FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant')",
    ),
    listSymbols: db.prepare("SELECT name, kind, line FROM nodes WHERE file = ? AND kind != 'file'"),
  } as Parameters<typeof rebuildFile>[3];
}

describe('rebuildFile FK safety with embeddings (#1176)', () => {
  let workDir: string;
  let tmpBase: string;
  let dbPath: string;

  beforeAll(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fk-1176-'));
    workDir = path.join(tmpBase, 'project');
    copyDirSync(FIXTURE_DIR, workDir);

    await buildGraph(workDir, { incremental: false, skipRegistry: true });

    dbPath = path.join(workDir, '.codegraph', 'graph.db');

    // Simulate `codegraph embed`: create the embeddings table (better-sqlite3
    // creates it lazily in `initEmbeddingsSchema`) and insert a row that
    // references a node belonging to the file we are about to rebuild.
    const seed = new Database(dbPath);
    try {
      seed.exec(`
        CREATE TABLE IF NOT EXISTS embeddings (
          node_id INTEGER PRIMARY KEY,
          vector BLOB NOT NULL,
          text_preview TEXT,
          FOREIGN KEY(node_id) REFERENCES nodes(id)
        );
      `);
      const target = seed
        .prepare('SELECT id FROM nodes WHERE file = ? LIMIT 1')
        .get('shared/constants.js') as { id: number } | undefined;
      expect(target, 'fixture should contain a node for shared/constants.js').toBeDefined();
      seed
        .prepare('INSERT INTO embeddings (node_id, vector, text_preview) VALUES (?, ?, ?)')
        .run(target!.id, Buffer.from([0, 1, 2, 3]), 'seeded');
    } finally {
      seed.close();
    }
  }, 60_000);

  afterAll(() => {
    try {
      if (tmpBase) fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('does not throw FOREIGN KEY constraint failed when rebuilding a file with embeddings', async () => {
    const db = openDb(dbPath);
    initSchema(db);
    // Make this connection match the watcher's: better-sqlite3 enables foreign
    // keys by default in v9+. Set explicitly so this test catches a regression
    // even on older builds.
    db.pragma('foreign_keys = ON');
    const stmts = makeStmts(db);
    const leafPath = path.join(workDir, 'shared', 'constants.js');
    fs.appendFileSync(leafPath, '\n// touched\n');

    await expect(
      rebuildFile(db, workDir, leafPath, stmts, { engine: 'auto' }, null),
    ).resolves.not.toBeNull();

    // The seeded embedding row should be gone — embeddings for a rebuilt
    // file are purged alongside the nodes they referenced. Count all rows in
    // `embeddings` directly (exactly one was seeded) so the assertion still
    // fails if the row survives as an orphan with a dangling node_id.
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number };
    expect(remaining.c).toBe(0);

    db.close();
  }, 60_000);
});
