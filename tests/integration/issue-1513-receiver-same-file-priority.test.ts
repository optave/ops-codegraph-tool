/**
 * Regression test for #1513 / #1539: a locally-defined function constructor
 * must block the cross-file class fallback in receiver-edge resolution.
 *
 * Setup: two files both define a symbol named `C`.
 *   - a.js: `function C() {}` with `C.prototype = { foo: function(){} }`
 *             and a caller `run()` that does `new C(); v.foo()`
 *   - b.js: `class C { bar() {} }` — same name, different file
 *
 * Expected behavior (#1539): the locally-defined `function C` in a.js owns the
 * name, so no cross-file fallback to `class C` in b.js.  No receiver edge is
 * emitted for `run` (the function constructor blocks the global class, and
 * `function` kind is not in RECEIVER_KINDS so the same-file candidate set is
 * empty after kind filtering).  Both engines must agree.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FILE_A = `
function C() {}
C.prototype = {
  foo: function() {},
};
export function run() {
  var v = new C();
  v.foo();
}
`;

// Same name C in a different file — must not steal the receiver edge from a.js
const FILE_B = `
export class C {
  bar() {}
}
`;

let tmpWasm: string;
let tmpNative: string;

beforeAll(async () => {
  tmpWasm = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1513-wasm-'));
  fs.writeFileSync(path.join(tmpWasm, 'a.js'), FILE_A);
  fs.writeFileSync(path.join(tmpWasm, 'b.js'), FILE_B);

  tmpNative = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1513-native-'));
  fs.writeFileSync(path.join(tmpNative, 'a.js'), FILE_A);
  fs.writeFileSync(path.join(tmpNative, 'b.js'), FILE_B);

  await Promise.all([
    buildGraph(tmpWasm, { incremental: false, skipRegistry: true, engine: 'wasm' }),
    buildGraph(tmpNative, { incremental: false, skipRegistry: true, engine: 'native' }),
  ]);
});

afterAll(() => {
  fs.rmSync(tmpWasm, { recursive: true, force: true });
  fs.rmSync(tmpNative, { recursive: true, force: true });
});

function getReceiverEdges(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n2.name AS tgt, n2.file AS tgt_file
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'receiver'
         ORDER BY n1.name, n2.name`,
      )
      .all() as Array<{ src: string; tgt: string; tgt_file: string }>;
  } finally {
    db.close();
  }
}

describe('receiver same-file priority over cross-file (#1513 / #1539)', () => {
  it('WASM: local function constructor blocks cross-file class — no receiver edge for run', () => {
    const edges = getReceiverEdges(path.join(tmpWasm, '.codegraph', 'graph.db'));
    const wrongEdge = edges.find((e) => e.src === 'run' && e.tgt_file === 'b.js');
    expect(wrongEdge).toBeUndefined();
  });

  it('Native: local function constructor blocks cross-file class — no receiver edge for run', () => {
    const edges = getReceiverEdges(path.join(tmpNative, '.codegraph', 'graph.db'));
    const wrongEdge = edges.find((e) => e.src === 'run' && e.tgt_file === 'b.js');
    expect(wrongEdge).toBeUndefined();
  });

  it('neither engine produces a cross-file receiver edge to b.js', () => {
    const wasmEdges = getReceiverEdges(path.join(tmpWasm, '.codegraph', 'graph.db'));
    const nativeEdges = getReceiverEdges(path.join(tmpNative, '.codegraph', 'graph.db'));
    const wasmWrongEdge = wasmEdges.find((e) => e.src === 'run' && e.tgt_file === 'b.js');
    const nativeWrongEdge = nativeEdges.find((e) => e.src === 'run' && e.tgt_file === 'b.js');
    expect(wasmWrongEdge).toBeUndefined();
    expect(nativeWrongEdge).toBeUndefined();
  });
});
