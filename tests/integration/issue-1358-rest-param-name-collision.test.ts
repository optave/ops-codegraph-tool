/**
 * Integration test for #1358: two functions in the same file both use `...rest`
 * as their rest-binding name. Without scoped typeMap keys the first seeding wins
 * and the second function resolves via the wrong type.
 *
 * Pattern:
 *   function f1({ a, ...rest }) { rest.m1(); }
 *   function f2({ b, ...rest }) { rest.m2(); }
 *   f1(obj1);  // obj1 has m1
 *   f2(obj2);  // obj2 has m2
 *
 * Expected edges: f1 → m1, f2 → m2.
 * Broken (pre-fix): both resolve through obj1, so f2 → m2 is missing.
 *
 * Fix (Phase 8.3f, #1358): typeMap keys are scoped to `callee::restName`
 * (e.g. `f1::rest`, `f2::rest`) so each function's binding is independent.
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

let tmpWasm: string;
let tmpNative: string;

beforeAll(async () => {
  tmpWasm = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1358-wasm-'));
  fs.writeFileSync(path.join(tmpWasm, 'collision.js'), FIXTURE_CODE);
  await buildGraph(tmpWasm, { engine: 'wasm', incremental: false, skipRegistry: true });

  tmpNative = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1358-native-'));
  fs.writeFileSync(path.join(tmpNative, 'collision.js'), FIXTURE_CODE);
  await buildGraph(tmpNative, { incremental: false, skipRegistry: true });
});

afterAll(() => {
  fs.rmSync(tmpWasm, { recursive: true, force: true });
  fs.rmSync(tmpNative, { recursive: true, force: true });
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

describe('Issue #1358: same rest-param name in two functions — scoped typeMap key', () => {
  it('WASM: f1 → m1 and f2 → m2 both resolve independently without cross-edges', () => {
    const edges = readCallEdges(path.join(tmpWasm, '.codegraph', 'graph.db'));
    expect(edges.find((e) => e.src === 'f1' && e.tgt === 'm1')).toBeDefined();
    expect(edges.find((e) => e.src === 'f2' && e.tgt === 'm2')).toBeDefined();
    expect(edges.find((e) => e.src === 'f1' && e.tgt === 'm2')).toBeUndefined();
    expect(edges.find((e) => e.src === 'f2' && e.tgt === 'm1')).toBeUndefined();
  });

  it('Native: f1 → m1 and f2 → m2 both resolve independently without cross-edges', () => {
    const edges = readCallEdges(path.join(tmpNative, '.codegraph', 'graph.db'));
    expect(edges.find((e) => e.src === 'f1' && e.tgt === 'm1')).toBeDefined();
    expect(edges.find((e) => e.src === 'f2' && e.tgt === 'm2')).toBeDefined();
    expect(edges.find((e) => e.src === 'f1' && e.tgt === 'm2')).toBeUndefined();
    expect(edges.find((e) => e.src === 'f2' && e.tgt === 'm1')).toBeUndefined();
  });
});
