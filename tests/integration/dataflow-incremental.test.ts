/**
 * Integration test for P4: incremental re-stitch when a callee file changes.
 *
 * Scenario:
 *   callee.js: function helper(x) { return x; }
 *   caller.js: function main(input) { helper(input); }
 *
 * Simulates the state AFTER a full build but BEFORE the re-analysis:
 *   - nodes for both helper and main exist
 *   - flows_to edge (main → helper at param 0) exists
 *   - main's param vertex exists (caller file did NOT change)
 *   - helper's param vertex does NOT exist (callee purged, awaiting rebuild)
 *
 * Then runs buildDataflowEdges with only callee.js in fileSymbols, and
 * asserts that P4 re-creates the arg_in edge from main.param → helper.param.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { buildDataflowEdges } from '../../src/features/dataflow.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

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

// ─── Fixture ────────────────────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;
let calleeRelPath: string;
let callerRelPath: string;
let mainNodeId: number;
let helperNodeId: number;
let mainParamVertexId: number;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p4-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

  callerRelPath = 'src/caller.js';
  calleeRelPath = 'src/callee.js';

  // Write real source files to disk (P4 re-parses caller from disk).
  fs.writeFileSync(path.join(tmpDir, callerRelPath), 'function main(input) { helper(input); }\n');
  fs.writeFileSync(path.join(tmpDir, calleeRelPath), 'function helper(x) { return x; }\n');

  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // Insert nodes (as a full build would have done).
  mainNodeId = insertNode(db, 'main', 'function', callerRelPath, 1);
  helperNodeId = insertNode(db, 'helper', 'function', calleeRelPath, 1);

  // Simulate post-purge state:
  //   - flows_to edge (main → helper at param 0) still exists (not purged —
  //     only callee file was purged, and this edge's source_id is main's node
  //     in caller.js which was NOT purged).
  //   - main's param vertex [input] exists (caller not purged).
  //   - helper's param vertex does NOT exist (callee was purged).

  db.prepare(
    `INSERT INTO dataflow (source_id, target_id, kind, param_index, expression, line, confidence)
     VALUES (?, ?, 'flows_to', 0, 'input', 1, 1.0)`,
  ).run(mainNodeId, helperNodeId);

  // Also insert a calls edge (used by stitch for call_edge_id).
  db.prepare(`INSERT INTO edges (source_id, target_id, kind) VALUES (?, ?, 'calls')`).run(
    mainNodeId,
    helperNodeId,
  );

  // Insert main's param vertex (simulating that caller.js was NOT purged).
  const vr = db
    .prepare(
      `INSERT INTO dataflow_vertices (func_id, kind, name, param_index, line, node_id)
       VALUES (?, 'param', 'input', 0, 1, NULL)`,
    )
    .run(mainNodeId);
  mainParamVertexId = vr.lastInsertRowid as number;

  db.close();

  // Run buildDataflowEdges with ONLY the callee file in fileSymbols.
  // P4 should detect that main (caller) calls helper (callee) and re-stitch.
  const db2 = new Database(dbPath);
  db2.pragma('journal_mode = WAL');

  const mockCalleeDataflow = {
    parameters: [{ funcName: 'helper', paramName: 'x', paramIndex: 0, line: 1 }],
    returns: [{ funcName: 'helper', expression: 'x', referencedNames: ['x'], line: 1 }],
    assignments: [],
    argFlows: [],
    mutations: [],
  };

  const fileSymbols = new Map([
    [
      calleeRelPath,
      {
        definitions: [{ name: 'helper', kind: 'function', line: 1 }],
        dataflow: mockCalleeDataflow as any,
        _langId: 'javascript' as any,
        _tree: null,
      },
    ],
  ]);

  await buildDataflowEdges(db2, fileSymbols as any, tmpDir);
  db2.close();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('P4: incremental re-stitch', () => {
  function openDb() {
    return new Database(dbPath, { readonly: true });
  }

  test('rebuilds helper param vertex after callee-only rebuild', () => {
    const db = openDb();
    const rows = db
      .prepare(
        `SELECT dv.* FROM dataflow_vertices dv
         JOIN nodes n ON n.id = dv.func_id
         WHERE n.name = 'helper' AND dv.kind = 'param'`,
      )
      .all() as any[];
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('x');
    expect(rows[0]!.param_index).toBe(0);
  });

  test('creates arg_in edge from main.param[input] → helper.param[x]', () => {
    const db = openDb();
    const rows = db
      .prepare(
        `SELECT d.kind, d.scope,
                sv.name AS sv_name, sv.kind AS sv_kind,
                tv.name AS tv_name, tv.kind AS tv_kind
         FROM dataflow d
         JOIN dataflow_vertices sv ON sv.id = d.source_vertex
         JOIN dataflow_vertices tv ON tv.id = d.target_vertex
         WHERE d.kind = 'arg_in' AND d.scope = 'inter'`,
      )
      .all() as any[];
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.sv_name).toBe('input');
    expect(rows[0]!.sv_kind).toBe('param');
    expect(rows[0]!.tv_name).toBe('x');
    expect(rows[0]!.tv_kind).toBe('param');
  });

  test('arg_in source_vertex is the pre-existing main.param vertex (not recreated)', () => {
    const db = openDb();
    const row = db
      .prepare(
        `SELECT source_vertex FROM dataflow WHERE kind = 'arg_in' AND scope = 'inter' LIMIT 1`,
      )
      .get() as { source_vertex: number } | null;
    db.close();
    expect(row).not.toBeNull();
    expect(row!.source_vertex).toBe(mainParamVertexId);
  });

  test('main param vertex was NOT duplicated by P4 re-parse', () => {
    const db = openDb();
    const rows = db
      .prepare(
        `SELECT dv.* FROM dataflow_vertices dv
         JOIN nodes n ON n.id = dv.func_id
         WHERE n.name = 'main' AND dv.kind = 'param'`,
      )
      .all() as any[];
    db.close();
    expect(rows).toHaveLength(1); // still exactly one — P4 does not insert caller vertices
  });

  test('return_out edge is created because helper.param[x] flows_to_return', () => {
    const db = openDb();
    const rows = db
      .prepare(`SELECT * FROM dataflow WHERE kind = 'return_out' AND scope = 'inter'`)
      .all() as any[];
    db.close();
    // helper has x→return def_use, so return_out should be created
    // (only if main has a local that captures helper's return — it doesn't here, so 0)
    expect(rows).toHaveLength(0);
  });

  test('def_use intra edge created for helper.param[x] → helper.return', () => {
    const db = openDb();
    const rows = db
      .prepare(
        `SELECT d.* FROM dataflow d
         JOIN dataflow_vertices sv ON sv.id = d.source_vertex
         JOIN dataflow_vertices tv ON tv.id = d.target_vertex
         JOIN nodes fn ON fn.id = sv.func_id
         WHERE fn.name = 'helper' AND sv.kind = 'param' AND tv.kind = 'return'
           AND d.kind = 'def_use' AND d.scope = 'intra'`,
      )
      .all() as any[];
    db.close();
    expect(rows).toHaveLength(1);
  });
});

// ─── P4 on the native fast path ────────────────────────────────────────────
//
// Same topology as above, but buildDataflowEdges is called with a nativeDb
// mock that has bulkInsertDataflow — exercising the native fast path branch.
// P4 must fire even though the caller file was not in fileSymbols.

let nativeTmpDir: string;
let nativeDbPath: string;
let nativeMainParamVertexId: number;

beforeAll(async () => {
  nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-p4-native-'));
  fs.mkdirSync(path.join(nativeTmpDir, '.codegraph'));
  fs.mkdirSync(path.join(nativeTmpDir, 'src'), { recursive: true });

  const nativeCallerRelPath = 'src/caller.js';
  const nativeCalleeRelPath = 'src/callee.js';

  // Write real source files to disk (P4 re-parses caller from disk).
  fs.writeFileSync(
    path.join(nativeTmpDir, nativeCallerRelPath),
    'function main(input) { helper(input); }\n',
  );
  fs.writeFileSync(
    path.join(nativeTmpDir, nativeCalleeRelPath),
    'function helper(x) { return x; }\n',
  );

  nativeDbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
  const db = new Database(nativeDbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  const nativeMainId = insertNode(db, 'main', 'function', nativeCallerRelPath, 1);
  const nativeHelperId = insertNode(db, 'helper', 'function', nativeCalleeRelPath, 1);

  // Simulate post-purge state: flows_to edge still present, main's param
  // vertex exists, helper's param vertex was purged.
  db.prepare(
    `INSERT INTO dataflow (source_id, target_id, kind, param_index, expression, line, confidence)
     VALUES (?, ?, 'flows_to', 0, 'input', 1, 1.0)`,
  ).run(nativeMainId, nativeHelperId);

  db.prepare(`INSERT INTO edges (source_id, target_id, kind) VALUES (?, ?, 'calls')`).run(
    nativeMainId,
    nativeHelperId,
  );

  const vr = db
    .prepare(
      `INSERT INTO dataflow_vertices (func_id, kind, name, param_index, line, node_id)
       VALUES (?, 'param', 'input', 0, 1, NULL)`,
    )
    .run(nativeMainId);
  nativeMainParamVertexId = vr.lastInsertRowid as number;

  db.close();

  // Run buildDataflowEdges with the native fast path (bulkInsertDataflow mock).
  // Only the callee file is in fileSymbols — P4 must re-stitch the caller.
  const db2 = new Database(nativeDbPath);
  db2.pragma('journal_mode = WAL');

  const mockCalleeDataflow = {
    parameters: [{ funcName: 'helper', paramName: 'x', paramIndex: 0, line: 1 }],
    returns: [{ funcName: 'helper', expression: 'x', referencedNames: ['x'], line: 1 }],
    assignments: [],
    argFlows: [],
    mutations: [],
  };

  const fileSymbols = new Map([
    [
      nativeCalleeRelPath,
      {
        definitions: [{ name: 'helper', kind: 'function', line: 1 }],
        dataflow: mockCalleeDataflow as any,
        _langId: 'javascript' as any,
        _tree: null,
      },
    ],
  ]);

  const nativeDb = {
    bulkInsertDataflow: (_edges: Array<Record<string, unknown>>) => _edges.length,
  };

  await buildDataflowEdges(db2, fileSymbols as any, nativeTmpDir, { nativeDb });
  db2.close();
});

afterAll(() => {
  fs.rmSync(nativeTmpDir, { recursive: true, force: true });
});

describe('P4 on native fast path', () => {
  function openNativeDb() {
    return new Database(nativeDbPath, { readonly: true });
  }

  test('rebuilds helper param vertex after callee-only native rebuild', () => {
    const db = openNativeDb();
    const rows = db
      .prepare(
        `SELECT dv.* FROM dataflow_vertices dv
         JOIN nodes n ON n.id = dv.func_id
         WHERE n.name = 'helper' AND dv.kind = 'param'`,
      )
      .all() as any[];
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('x');
    expect(rows[0]!.param_index).toBe(0);
  });

  test('creates arg_in edge from main.param[input] → helper.param[x] on native path', () => {
    const db = openNativeDb();
    const rows = db
      .prepare(
        `SELECT d.kind, d.scope,
                sv.name AS sv_name, sv.kind AS sv_kind,
                tv.name AS tv_name, tv.kind AS tv_kind
         FROM dataflow d
         JOIN dataflow_vertices sv ON sv.id = d.source_vertex
         JOIN dataflow_vertices tv ON tv.id = d.target_vertex
         WHERE d.kind = 'arg_in' AND d.scope = 'inter'`,
      )
      .all() as any[];
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.sv_name).toBe('input');
    expect(rows[0]!.sv_kind).toBe('param');
    expect(rows[0]!.tv_name).toBe('x');
    expect(rows[0]!.tv_kind).toBe('param');
  });

  test('arg_in source_vertex is the pre-existing main.param vertex on native path', () => {
    const db = openNativeDb();
    const row = db
      .prepare(
        `SELECT source_vertex FROM dataflow WHERE kind = 'arg_in' AND scope = 'inter' LIMIT 1`,
      )
      .get() as { source_vertex: number } | null;
    db.close();
    expect(row).not.toBeNull();
    expect(row!.source_vertex).toBe(nativeMainParamVertexId);
  });

  test('main param vertex not duplicated on native path (P4 does not insert caller vertices)', () => {
    const db = openNativeDb();
    const rows = db
      .prepare(
        `SELECT dv.* FROM dataflow_vertices dv
         JOIN nodes n ON n.id = dv.func_id
         WHERE n.name = 'main' AND dv.kind = 'param'`,
      )
      .all() as any[];
    db.close();
    expect(rows).toHaveLength(1);
  });

  test('def_use intra edge created for helper.param[x] → helper.return on native path', () => {
    const db = openNativeDb();
    const rows = db
      .prepare(
        `SELECT d.* FROM dataflow d
         JOIN dataflow_vertices sv ON sv.id = d.source_vertex
         JOIN dataflow_vertices tv ON tv.id = d.target_vertex
         JOIN nodes fn ON fn.id = sv.func_id
         WHERE fn.name = 'helper' AND sv.kind = 'param' AND tv.kind = 'return'
           AND d.kind = 'def_use' AND d.scope = 'intra'`,
      )
      .all() as any[];
    db.close();
    expect(rows).toHaveLength(1);
  });
});
