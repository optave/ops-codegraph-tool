/**
 * Regression test for #1825: a renamed import used as a call *receiver*
 * (`import { X as Y } from '...'; Y.method()`) must resolve — the qualified-
 * name fallback in `resolveByReceiver` (src/domain/graph/resolver/strategy.ts)
 * previously built the lookup key from the local alias (`Y.method`) instead
 * of the declared name (`X.method`), so the call was silently dropped.
 *
 * Setup: two files.
 *   - helpers.js: `export const NamespaceObj = { doThing() {...} }` and
 *     `export class Greeter { greet() {...} }`.
 *   - consumer.js: imports both renamed (`NamespaceObj as NsAlias`,
 *     `Greeter as GreeterAlias`) and calls:
 *       - `NsAlias.doThing()` — direct-qualified-method path (no typeMap
 *         entry for the receiver; #1825's exact reported repro).
 *       - `new GreeterAlias().greet()` — typed-method path (typeMap records
 *         the constructor's local alias as the receiver's type; the same
 *         de-aliasing gap applies to `resolveViaTypedMethod`).
 *
 * Before the fix, neither call produced a `calls` edge on either engine.
 *
 * Verified on both engines — this is resolver logic mirrored in
 * `crates/codegraph-core/`, so WASM and native must agree.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FILE_HELPERS = `
export const NamespaceObj = {
  doThing() {
    return 1;
  },
};

export class Greeter {
  greet() {
    return 'hi';
  }
}
`;

const FILE_CONSUMER = `
import { NamespaceObj as NsAlias, Greeter as GreeterAlias } from './helpers.js';

export function useReceiver() {
  return NsAlias.doThing();
}

export function useConstructedReceiver() {
  const g = new GreeterAlias();
  return g.greet();
}
`;

let tmpWasm: string;
let tmpNative: string;

beforeAll(async () => {
  tmpWasm = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1825-wasm-'));
  fs.writeFileSync(path.join(tmpWasm, 'helpers.js'), FILE_HELPERS);
  fs.writeFileSync(path.join(tmpWasm, 'consumer.js'), FILE_CONSUMER);

  tmpNative = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1825-native-'));
  fs.writeFileSync(path.join(tmpNative, 'helpers.js'), FILE_HELPERS);
  fs.writeFileSync(path.join(tmpNative, 'consumer.js'), FILE_CONSUMER);

  await Promise.all([
    buildGraph(tmpWasm, { incremental: false, skipRegistry: true, engine: 'wasm' }),
    buildGraph(tmpNative, { incremental: false, skipRegistry: true, engine: 'native' }),
  ]);
});

afterAll(() => {
  fs.rmSync(tmpWasm, { recursive: true, force: true });
  fs.rmSync(tmpNative, { recursive: true, force: true });
});

function getCallEdges(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n1.file AS src_file, n2.name AS tgt, n2.file AS tgt_file
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
      )
      .all() as Array<{ src: string; src_file: string; tgt: string; tgt_file: string }>;
  } finally {
    db.close();
  }
}

describe('call-edge resolution through a renamed import used as a receiver (#1825)', () => {
  it('WASM: useReceiver -> NamespaceObj.doThing calls edge exists (direct-qualified path)', () => {
    const edges = getCallEdges(path.join(tmpWasm, '.codegraph', 'graph.db'));
    const edge = edges.find((e) => e.src === 'useReceiver' && e.tgt === 'NamespaceObj.doThing');
    expect(edge).toBeDefined();
    expect(edge?.tgt_file).toBe('helpers.js');
  });

  it('Native: useReceiver -> NamespaceObj.doThing calls edge exists (direct-qualified path)', () => {
    const edges = getCallEdges(path.join(tmpNative, '.codegraph', 'graph.db'));
    const edge = edges.find((e) => e.src === 'useReceiver' && e.tgt === 'NamespaceObj.doThing');
    expect(edge).toBeDefined();
    expect(edge?.tgt_file).toBe('helpers.js');
  });

  it('WASM: useConstructedReceiver -> Greeter.greet calls edge exists (typed-method path)', () => {
    const edges = getCallEdges(path.join(tmpWasm, '.codegraph', 'graph.db'));
    const edge = edges.find((e) => e.src === 'useConstructedReceiver' && e.tgt === 'Greeter.greet');
    expect(edge).toBeDefined();
    expect(edge?.tgt_file).toBe('helpers.js');
  });

  it('Native: useConstructedReceiver -> Greeter.greet calls edge exists (typed-method path)', () => {
    const edges = getCallEdges(path.join(tmpNative, '.codegraph', 'graph.db'));
    const edge = edges.find((e) => e.src === 'useConstructedReceiver' && e.tgt === 'Greeter.greet');
    expect(edge).toBeDefined();
    expect(edge?.tgt_file).toBe('helpers.js');
  });

  it('no spurious edge is created against the local alias names', () => {
    for (const dbPath of [
      path.join(tmpWasm, '.codegraph', 'graph.db'),
      path.join(tmpNative, '.codegraph', 'graph.db'),
    ]) {
      const edges = getCallEdges(dbPath);
      expect(edges.find((e) => e.tgt === 'NsAlias.doThing')).toBeUndefined();
      expect(edges.find((e) => e.tgt === 'GreeterAlias.greet')).toBeUndefined();
    }
  });
});
