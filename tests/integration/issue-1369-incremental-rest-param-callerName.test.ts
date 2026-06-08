/**
 * Integration test for #1369: incremental rebuild path must pass callerName to
 * resolveCallTargets so the scoped Phase 8.3f typeMap key (`callee::restName`)
 * can be resolved correctly after a file edit.
 *
 * Scenario (same fixture as #1358 — two functions sharing a rest-param name):
 *   function f1({ a, ...rest }) { rest.m1(); }
 *   function f2({ b, ...rest }) { rest.m2(); }
 *   f1(obj1);  f2(obj2);
 *
 * A full build produces f1→m1 and f2→m2.  Without the fix, touching the file
 * and doing an incremental rebuild would drop f2→m2 because:
 *   1. The incremental buildCallEdges didn't seed callee::restName scoped keys.
 *   2. Even after adding the seeding, it didn't pass caller.callerName to
 *      resolveCallTargets, so resolveByMethodOrGlobal's scoped-key fallback
 *      (`typeMap.get(`${callerName}::${effectiveReceiver}`)`) never fired.
 *
 * Fix (this PR / #1369): seed scoped keys + pass callerName in incremental path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE_CODE = `
function m1() {}
function m2() {}

var obj1 = { m1 };
var obj2 = { m2 };

function f1({ a, ...rest }) {
  rest.m1();
}

function f2({ b, ...rest }) {
  rest.m2();
}

f1(obj1);
f2(obj2);
`;

const FIXTURE_CODE_TOUCHED = `${FIXTURE_CODE}
// touched to trigger incremental rebuild
`;

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1369-'));
  fs.writeFileSync(path.join(tmpDir, 'collision.js'), FIXTURE_CODE);
  await buildGraph(tmpDir, { incremental: false, skipRegistry: true });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readCallEdges(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n2.name AS tgt
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
      )
      .all() as Array<{ src: string; tgt: string }>;
  } finally {
    db.close();
  }
}

describe('Issue #1369: incremental rebuild preserves scoped rest-param resolution', () => {
  it('full build: f1 → m1 and f2 → m2 resolve correctly', () => {
    const edges = readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
    expect(edges.find((e) => e.src === 'f1' && e.tgt === 'm1')).toBeDefined();
    expect(edges.find((e) => e.src === 'f2' && e.tgt === 'm2')).toBeDefined();
    expect(edges.find((e) => e.src === 'f1' && e.tgt === 'm2')).toBeUndefined();
    expect(edges.find((e) => e.src === 'f2' && e.tgt === 'm1')).toBeUndefined();
  });

  it('incremental rebuild: f1 → m1 and f2 → m2 still resolve after file touch', async () => {
    fs.writeFileSync(path.join(tmpDir, 'collision.js'), FIXTURE_CODE_TOUCHED);
    await buildGraph(tmpDir, { incremental: true, skipRegistry: true });

    const edges = readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
    expect(edges.find((e) => e.src === 'f1' && e.tgt === 'm1')).toBeDefined();
    expect(edges.find((e) => e.src === 'f2' && e.tgt === 'm2')).toBeDefined();
    expect(edges.find((e) => e.src === 'f1' && e.tgt === 'm2')).toBeUndefined();
    expect(edges.find((e) => e.src === 'f2' && e.tgt === 'm1')).toBeUndefined();
  });
});
