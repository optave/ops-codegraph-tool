/**
 * Integration test for #1336: resolve property calls on object destructuring rest parameters.
 *
 * When a function parameter uses object destructuring with a rest element (`...rest`),
 * and the rest object's property is then called, codegraph should resolve the callee.
 *
 * Pattern:
 *   function f3({ e1: eee1, ...eerest }) { eerest.e4(); }
 *   f3(obj);
 *
 * Resolution chain (Phase 8.3f, WASM engine):
 *   1. Extractor seeds typeMap['obj.e4'] = { type: 'e4' } from the object literal `var obj = { e4 }`.
 *   2. Extractor records objectRestParamBinding { callee: 'f3', argIndex: 0, restName: 'eerest' }.
 *   3. Extractor records paramBinding { callee: 'f3', argIndex: 0, argName: 'obj' } from f3(obj).
 *   4. build-edges.ts cross-references (2) and (3) to seed typeMap['eerest'] = { type: 'obj' }.
 *   5. resolveByMethodOrGlobal: typeMap['eerest'] → obj; typeMap['obj.e4'] → e4 → resolved edge.
 *
 * Native engine parity is tracked in #1349.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE_CODE = `
function e1() { console.log("31"); }
function e4() { console.log("34"); }

var obj = { e1, e4 };

function f3({ e1: eee1, ...eerest }) {
    eee1();       // call through named destructuring alias
    eerest.e4();  // call through rest binding — expected edge: f3 → e4
}
f3(obj);
`;

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1336-'));
  fs.writeFileSync(path.join(tmpDir, 'rest.js'), FIXTURE_CODE);
  // Force WASM engine — native engine parity tracked in #1349.
  await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readCallEdges(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n2.name AS tgt, e.kind, e.dynamic
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
      )
      .all() as Array<{ src: string; tgt: string; kind: string; dynamic: number }>;
  } finally {
    db.close();
  }
}

describe('Issue #1336: object destructuring rest parameter call resolution', () => {
  it('emits a calls edge from f3 to e4 via eerest.e4() rest-receiver resolution', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readCallEdges(dbPath);
    const edge = edges.find((e) => e.src === 'f3' && e.tgt === 'e4');
    expect(edge).toBeDefined();
    // eerest.e4() is a static member access — not dynamic.
    expect(edge!.dynamic).toBe(0);
  });
});
