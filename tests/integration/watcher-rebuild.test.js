/**
 * Watcher rebuild parity test (#533).
 *
 * Exercises the `rebuildFile` function (the watcher code path) directly,
 * verifying that single-file rebuilds with reverse-dep cascade produce
 * identical nodes and edges to a full build.
 *
 * This is distinct from incr-edge-gap.test.js which tests the build
 * pipeline's incremental path (detect-changes.js).
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

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readGraph(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const nodes = db
    .prepare('SELECT name, kind, file, line FROM nodes ORDER BY name, kind, file, line')
    .all();
  const edges = db
    .prepare(
      `SELECT n1.name AS src, n2.name AS tgt, e.kind
       FROM edges e
       JOIN nodes n1 ON e.source_id = n1.id
       JOIN nodes n2 ON e.target_id = n2.id
       ORDER BY n1.name, n2.name, e.kind`,
    )
    .all();
  db.close();
  return { nodes, edges };
}

/** Build the prepared statements object that watcher.js normally provides. */
function makeStmts(db) {
  const stmts = {
    insertNode: db.prepare(
      'INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
    ),
    getNodeId: {
      get: (name, kind, file, line) => {
        const id = getNodeIdQuery(db, name, kind, file, line);
        return id != null ? { id } : undefined;
      },
    },
    insertEdge: db.prepare(
      'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)',
    ),
    deleteNodes: db.prepare('DELETE FROM nodes WHERE file = ?'),
    deleteEdgesForFile: null,
    countNodes: db.prepare('SELECT COUNT(*) as c FROM nodes WHERE file = ?'),
    countEdgesForFile: null,
    findNodeInFile: db.prepare(
      "SELECT id, file FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant') AND file = ?",
    ),
    findNodeByName: db.prepare(
      "SELECT id, file FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant')",
    ),
    listSymbols: db.prepare("SELECT name, kind, line FROM nodes WHERE file = ? AND kind != 'file'"),
  };

  const origDeleteEdges = db.prepare(
    `DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = @f) OR target_id IN (SELECT id FROM nodes WHERE file = @f)`,
  );
  const origCountEdges = db.prepare(
    `SELECT COUNT(*) as c FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = @f) OR target_id IN (SELECT id FROM nodes WHERE file = @f)`,
  );
  stmts.deleteEdgesForFile = { run: (f) => origDeleteEdges.run({ f }) };
  stmts.countEdgesForFile = { get: (f) => origCountEdges.get({ f }) };

  return stmts;
}

describe('Watcher rebuildFile parity (#533)', () => {
  let fullDir;
  let watcherDir;
  let tmpBase;

  beforeAll(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-watcher-533-'));
    fullDir = path.join(tmpBase, 'full');
    watcherDir = path.join(tmpBase, 'watcher');
    copyDirSync(FIXTURE_DIR, fullDir);
    copyDirSync(FIXTURE_DIR, watcherDir);

    // Step 1: Full build both copies
    await buildGraph(fullDir, { incremental: false, skipRegistry: true });
    await buildGraph(watcherDir, { incremental: false, skipRegistry: true });

    // Step 2: Touch the leaf file (shared/constants.js) in the watcher copy
    const leafPath = path.join(watcherDir, 'shared', 'constants.js');
    fs.appendFileSync(leafPath, '\n// touched\n');

    // Step 3: Use rebuildFile (the watcher code path) to rebuild
    const dbPath = path.join(watcherDir, '.codegraph', 'graph.db');
    const db = openDb(dbPath);
    initSchema(db);
    const stmts = makeStmts(db);
    await rebuildFile(db, watcherDir, leafPath, stmts, { engine: 'auto' }, null);
    db.close();

    // Step 4: Apply same change to full copy and do a full rebuild
    const fullLeafPath = path.join(fullDir, 'shared', 'constants.js');
    fs.appendFileSync(fullLeafPath, '\n// touched\n');
    await buildGraph(fullDir, { incremental: false, skipRegistry: true });
  }, 60_000);

  afterAll(() => {
    try {
      if (tmpBase) fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('produces identical node count', () => {
    const fullGraph = readGraph(path.join(fullDir, '.codegraph', 'graph.db'));
    const watcherGraph = readGraph(path.join(watcherDir, '.codegraph', 'graph.db'));
    expect(watcherGraph.nodes.length).toBe(fullGraph.nodes.length);
  });

  it('produces identical edge count', () => {
    const fullGraph = readGraph(path.join(fullDir, '.codegraph', 'graph.db'));
    const watcherGraph = readGraph(path.join(watcherDir, '.codegraph', 'graph.db'));

    if (watcherGraph.edges.length !== fullGraph.edges.length) {
      const fSet = new Set(fullGraph.edges.map((e) => `${e.src}->${e.tgt}[${e.kind}]`));
      const wSet = new Set(watcherGraph.edges.map((e) => `${e.src}->${e.tgt}[${e.kind}]`));
      const missing = [...fSet].filter((k) => !wSet.has(k));
      const extra = [...wSet].filter((k) => !fSet.has(k));
      console.log(`Missing in watcher (${missing.length}):`, missing.slice(0, 10));
      console.log(`Extra in watcher (${extra.length}):`, extra.slice(0, 10));
    }

    expect(watcherGraph.edges.length).toBe(fullGraph.edges.length);
  });

  it('produces identical nodes', () => {
    const fullGraph = readGraph(path.join(fullDir, '.codegraph', 'graph.db'));
    const watcherGraph = readGraph(path.join(watcherDir, '.codegraph', 'graph.db'));
    expect(watcherGraph.nodes).toEqual(fullGraph.nodes);
  });

  it('produces identical edges', () => {
    const fullGraph = readGraph(path.join(fullDir, '.codegraph', 'graph.db'));
    const watcherGraph = readGraph(path.join(watcherDir, '.codegraph', 'graph.db'));
    expect(watcherGraph.edges).toEqual(fullGraph.edges);
  });
});
