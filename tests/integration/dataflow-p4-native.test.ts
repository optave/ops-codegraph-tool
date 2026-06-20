/**
 * Integration test for P4-on-native: buildDataflowP4ForNative.
 *
 * Scenario — same as the incremental P4 test but exercises the native path:
 *   callee.js: function helper(x) { return x; }
 *   caller.js: function main(input) { helper(input); }
 *
 * Simulates the state AFTER P6 vertex extraction ran for the changed callee
 * file but BEFORE P4 re-stitch:
 *   - nodes for both helper and main exist in the DB
 *   - flows_to edge (main → helper at param 0) exists
 *   - main's param vertex [input] exists (caller file did NOT change)
 *   - helper's param vertex [x] NOW EXISTS (P6 just rebuilt it for the callee)
 *   - arg_in edge does NOT exist yet (P4 hasn't run)
 *
 * buildDataflowP4ForNative is then called with changedFiles=[callee.js] and
 * should create the arg_in edge connecting main.param[input] → helper.param[x].
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { buildDataflowP4ForNative } from '../../src/features/dataflow.js';

function insertNode(
  db: ReturnType<typeof Database>,
  name: string,
  kind: string,
  file: string,
  line: number,
): number {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid as number;
}

let tmpDir: string;
let dbPath: string;
let calleeRelPath: string;
let callerRelPath: string;
let mainNodeId: number;
let helperNodeId: number;
let mainParamVertexId: number;
let helperParamVertexId: number;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p4-native-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

  callerRelPath = 'src/caller.js';
  calleeRelPath = 'src/callee.js';

  // P4 re-parses the caller file from disk.
  fs.writeFileSync(path.join(tmpDir, callerRelPath), 'function main(input) { helper(input); }\n');
  fs.writeFileSync(path.join(tmpDir, calleeRelPath), 'function helper(x) { return x; }\n');

  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  mainNodeId = insertNode(db, 'main', 'function', callerRelPath, 1);
  helperNodeId = insertNode(db, 'helper', 'function', calleeRelPath, 1);

  // flows_to edge: main → helper at param 0 (from a previous full build).
  db.prepare(
    `INSERT INTO dataflow (source_id, target_id, kind, param_index, expression, line, confidence)
     VALUES (?, ?, 'flows_to', 0, 'input', 1, 1.0)`,
  ).run(mainNodeId, helperNodeId);

  // calls edge (used by stitch for call_edge_id linkage).
  db.prepare(`INSERT INTO edges (source_id, target_id, kind) VALUES (?, ?, 'calls')`).run(
    mainNodeId,
    helperNodeId,
  );

  // main's param vertex — caller file was NOT purged, so this still exists.
  mainParamVertexId = db
    .prepare(
      `INSERT INTO dataflow_vertices (func_id, kind, name, param_index, line, node_id)
       VALUES (?, 'param', 'input', 0, 1, NULL)`,
    )
    .run(mainNodeId).lastInsertRowid as number;

  // helper's param vertex — P6 just rebuilt it for the changed callee file.
  helperParamVertexId = db
    .prepare(
      `INSERT INTO dataflow_vertices (func_id, kind, name, param_index, line, node_id)
       VALUES (?, 'param', 'x', 0, 1, NULL)`,
    )
    .run(helperNodeId).lastInsertRowid as number;

  db.close();

  // Run P4-on-native: only the callee changed.
  const db2 = new Database(dbPath);
  db2.pragma('journal_mode = WAL');
  await buildDataflowP4ForNative(db2, [calleeRelPath], tmpDir);
  db2.close();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('P4-on-native: buildDataflowP4ForNative', () => {
  function openDb() {
    return new Database(dbPath, { readonly: true });
  }

  test('creates arg_in edge from main.param[input] → helper.param[x]', () => {
    const db = openDb();
    const edge = db
      .prepare(
        `SELECT d.kind, d.source_vertex, d.target_vertex
         FROM dataflow d
         WHERE d.kind = 'arg_in'`,
      )
      .get() as { kind: string; source_vertex: number; target_vertex: number } | undefined;
    db.close();
    expect(edge).toBeDefined();
    expect(edge!.kind).toBe('arg_in');
    expect(edge!.source_vertex).toBe(mainParamVertexId);
    expect(edge!.target_vertex).toBe(helperParamVertexId);
  });

  test('arg_in edge has scope=inter', () => {
    const db = openDb();
    const edge = db.prepare(`SELECT scope FROM dataflow WHERE kind = 'arg_in'`).get() as
      | { scope: string }
      | undefined;
    db.close();
    expect(edge?.scope).toBe('inter');
  });

  test('no duplicate arg_in edges on repeated call', async () => {
    // Calling P4 again should be idempotent — no new edges inserted.
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    await buildDataflowP4ForNative(db, [calleeRelPath], tmpDir);
    db.close();

    const db2 = openDb();
    const count = (
      db2.prepare(`SELECT COUNT(*) AS n FROM dataflow WHERE kind = 'arg_in'`).get() as { n: number }
    ).n;
    db2.close();
    // SQLite UNIQUE constraints prevent duplicates; count stays at 1.
    expect(count).toBe(1);
  });

  test('full build guard: skips P4 when changedFiles covers all DB files', async () => {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    const countBefore = (
      db.prepare(`SELECT COUNT(*) AS n FROM dataflow WHERE kind = 'arg_in'`).get() as { n: number }
    ).n;

    // Both files = "full build" → P4 should no-op.
    await buildDataflowP4ForNative(db, [callerRelPath, calleeRelPath], tmpDir);
    const countAfter = (
      db.prepare(`SELECT COUNT(*) AS n FROM dataflow WHERE kind = 'arg_in'`).get() as { n: number }
    ).n;
    db.close();

    expect(countAfter).toBe(countBefore);
  });
});
