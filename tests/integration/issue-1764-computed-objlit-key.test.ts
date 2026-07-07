/**
 * Integration test for #1764: object literal computed method keys extract as
 * `obj.['foo']` instead of `obj.foo`.
 *
 * `extractObjectLiteralFunctions`'s `pair` branch (and several sibling helpers that
 * resolve a `pair`'s key field — typeMap seeding, Object.defineProperties, prototype
 * assignment) only stripped quotes for plain `string`-typed keys. For a computed
 * string-literal key like `{ ['foo']: () => {} }`, the key node type is
 * `computed_property_name`, so the old code fell through to the raw bracket/quote
 * text, producing `obj.['foo']` instead of `obj.foo` — call sites like `obj.foo()`
 * could never resolve to it.
 *
 * Fix: a shared `resolvePropertyKeyName` (WASM) / `resolve_property_key_name`
 * (native) helper unwraps `computed_property_name` string literals the same way the
 * existing `resolveMethodDefinitionName` / `resolve_method_def_name` helpers already
 * did for `method_definition` name nodes. Non-string computed keys (e.g.
 * `[Symbol.iterator]`) are skipped rather than producing a garbage name.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE = {
  'service.js': `
const obj = {
  ['foo']: () => {
    return 1;
  },
  bar: () => {
    return 2;
  },
};

obj.foo();
obj.bar();
`,
};

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1764-'));
  for (const [rel, content] of Object.entries(FIXTURE)) {
    fs.writeFileSync(path.join(tmpDir, rel), content);
  }
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

function readNodes(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT name, kind FROM nodes ORDER BY name').all() as Array<{
      name: string;
      kind: string;
    }>;
  } finally {
    db.close();
  }
}

describe('computed object-literal key extraction (#1764) — WASM', () => {
  it('stores computed object-literal property under plain qualified name (no brackets)', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const nodes = readNodes(dbPath);
    const fooNode = nodes.find((n) => n.name === 'obj.foo');
    expect(
      fooNode,
      'obj.foo node missing — computed object-literal key stored with brackets instead of plain name',
    ).toBeDefined();
    expect(fooNode!.kind).toBe('function');
  });

  it('does not store any node with brackets in its name from computed keys', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const nodes = readNodes(dbPath);
    const bracketedNodes = nodes.filter((n) => n.name.includes('['));
    expect(
      bracketedNodes,
      `Found nodes with brackets in name (bracket representation leaked): ${bracketedNodes.map((n) => n.name).join(', ')}`,
    ).toHaveLength(0);
  });

  it('resolves call to computed object-literal property at dot-notation call site', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readCallEdges(dbPath);
    const edge = edges.find((e) => e.tgt === 'obj.foo');
    expect(
      edge,
      'No call edge to obj.foo — computed object-literal key not resolvable at call site',
    ).toBeDefined();
  });

  it('resolves call to regular (non-computed) object-literal property at dot-notation call site', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readCallEdges(dbPath);
    const edge = edges.find((e) => e.tgt === 'obj.bar');
    expect(
      edge,
      'No call edge to obj.bar — regular object-literal key resolution broken by fix',
    ).toBeDefined();
  });
});

// ── Native engine parity ────────────────────────────────────────────────────
// Guards that resolve_property_key_name in Rust applies the same unwrapping as
// the WASM path. Skipped when the native addon is not installed.

describe.skipIf(!isNativeAvailable())(
  'computed object-literal key extraction (#1764) — native',
  () => {
    let nativeTmpDir: string;

    beforeAll(async () => {
      nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1764-native-'));
      for (const [rel, content] of Object.entries(FIXTURE)) {
        fs.writeFileSync(path.join(nativeTmpDir, rel), content);
      }
      await buildGraph(nativeTmpDir, { engine: 'native', incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(nativeTmpDir, { recursive: true, force: true });
    });

    it('stores computed object-literal property under plain qualified name (no brackets)', () => {
      const nodes = readNodes(path.join(nativeTmpDir, '.codegraph', 'graph.db'));
      const node = nodes.find((n) => n.name === 'obj.foo');
      expect(
        node,
        'obj.foo missing in native output — resolve_property_key_name may not strip brackets',
      ).toBeDefined();
      expect(node!.kind).toBe('function');
    });

    it('does not store any node with brackets in its name from computed keys', () => {
      const nodes = readNodes(path.join(nativeTmpDir, '.codegraph', 'graph.db'));
      const bracketed = nodes.filter((n) => n.name.includes('['));
      expect(
        bracketed,
        `Native output has bracket-leaked nodes: ${bracketed.map((n) => n.name).join(', ')}`,
      ).toHaveLength(0);
    });

    it('resolves call to computed object-literal property at dot-notation call site', () => {
      const edges = readCallEdges(path.join(nativeTmpDir, '.codegraph', 'graph.db'));
      const edge = edges.find((e) => e.tgt === 'obj.foo');
      expect(
        edge,
        'No native call edge to obj.foo — computed object-literal key not resolvable in native engine',
      ).toBeDefined();
    });
  },
);
