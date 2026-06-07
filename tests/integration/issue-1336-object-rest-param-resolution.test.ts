/**
 * Integration test for #1336 + #1349: resolve property calls on object
 * destructuring rest parameters — both WASM and native engines.
 *
 * When a function parameter uses object destructuring with a rest element (`...rest`),
 * and the rest object's property is then called, codegraph should resolve the callee.
 *
 * Pattern:
 *   function f3({ e1: eee1, ...eerest }) { eerest.e4(); }
 *   f3(obj);
 *
 * Resolution chain (Phase 8.3f):
 *   1. Extractor seeds typeMap['obj.e4'] = { type: 'e4' } from `var obj = { e4 }`.
 *   2. Extractor records objectRestParamBinding { callee: 'f3', argIndex: 0, restName: 'eerest' }.
 *   3. Extractor records paramBinding { callee: 'f3', argIndex: 0, argName: 'obj' } from f3(obj).
 *   4. Phase 8.3f seeds typeMap['f3::eerest'] = { type: 'obj' } (scoped by callee, #1358).
 *      Because f3 is the only callee using 'eerest', the unscoped key typeMap['eerest'] is
 *      also seeded as a null-callerName fallback (single-callee shortcut, #1358).
 *   5. resolveByMethodOrGlobal: typeMap['eerest'] (unscoped, single-callee fallback) → obj;
 *      typeMap['obj.e4'] → e4 → resolved. The scoped key 'f3::eerest' is a no-op here but
 *      would be the active path if a second function also declared '...eerest'.
 *
 * WASM: resolved via Phase 8.3f typeMap chain in buildCallEdgesJS.
 * Native: resolved via same-file name lookup (step 2 in Rust resolve_call_targets);
 *         the Phase 8.3f post-pass (buildObjectRestParamPostPass) provides the typeMap-chain
 *         fallback for cross-file cases not directly imported.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE_CODE = `
function e1() { console.log('31'); }
function e4() { console.log('34'); }

var obj = { e1, e4 };

function f3({ e1: eee1, ...eerest }) {
  eee1(); // call through named destructuring alias
  eerest.e4(); // call through rest binding — expected edge: f3 → e4
}
f3(obj);
`;

let tmpWasm: string;
let tmpNative: string;

beforeAll(async () => {
  tmpWasm = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1336-wasm-'));
  fs.writeFileSync(path.join(tmpWasm, 'rest.js'), FIXTURE_CODE);
  await buildGraph(tmpWasm, { engine: 'wasm', incremental: false, skipRegistry: true });

  tmpNative = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1336-native-'));
  fs.writeFileSync(path.join(tmpNative, 'rest.js'), FIXTURE_CODE);
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

describe('Issue #1336 + #1349: object destructuring rest parameter call resolution', () => {
  it('WASM: emits a calls edge from f3 to e4 via eerest.e4() rest-receiver resolution', () => {
    const edges = readCallEdges(path.join(tmpWasm, '.codegraph', 'graph.db'));
    const edge = edges.find((e) => e.src === 'f3' && e.tgt === 'e4');
    expect(edge).toBeDefined();
    expect(edge!.dynamic).toBe(0);
  });

  it('Native: emits a calls edge from f3 to e4 via eerest.e4() rest-receiver resolution', () => {
    const edges = readCallEdges(path.join(tmpNative, '.codegraph', 'graph.db'));
    const edge = edges.find((e) => e.src === 'f3' && e.tgt === 'e4');
    expect(edge).toBeDefined();
    expect(edge!.dynamic).toBe(0);
  });
});
