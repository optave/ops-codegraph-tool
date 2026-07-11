/**
 * Integration test for #1901: engine parity for `const [a, b] = fn();`
 * top-level array-pattern destructuring.
 *
 * Root cause: the native Rust extractor (`crates/codegraph-core/src/
 * extractors/javascript.rs`, `handle_var_decl`) emitted no `Definition` at
 * all for array-pattern name nodes, while the WASM/TS extractor
 * (`src/extractors/javascript.ts`, both the walk path in
 * `handleVariableDeclarator` and the query path in
 * `extractDestructuredDeclarators`) emitted a single `Definition` whose
 * `name` was the raw pattern source text (e.g. `"[a, b]"`) — not a real
 * identifier, and never itself a valid call target.
 *
 * Fix: both engines now emit one `constant`-kind `Definition` per bound
 * identifier (`a`, `b`, ...), mirroring how object-pattern destructuring
 * already works per-property (#1773) — via `extractArrayPatternBindings`
 * (WASM/TS) and `extract_array_pattern_bindings` (native).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE = {
  'sample.js': `
function getArr() { return [1, 2]; }
const [a, b] = getArr();
console.log(a, b);

function withDefaultsAndRest() { return [1, 2, 3]; }
const [c = 0, ...rest] = withDefaultsAndRest();
console.log(c, rest);
`,
};

function readNode(dbPath: string, file: string, name: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT name, kind FROM nodes WHERE file = ? AND name = ?').get(file, name) as
      | { name: string; kind: string }
      | undefined;
  } finally {
    db.close();
  }
}

function expectPerElementBindings(dbPath: string) {
  for (const name of ['a', 'b', 'c', 'rest']) {
    const node = readNode(dbPath, 'sample.js', name);
    expect(node, `${name} node not found`).toBeDefined();
    expect(node!.kind, `${name} must be kind constant`).toBe('constant');
  }
  // The old single-node-named-by-raw-pattern-text approach must be gone.
  expect(readNode(dbPath, 'sample.js', '[a, b]')).toBeUndefined();
  expect(readNode(dbPath, 'sample.js', '[c = 0, ...rest]')).toBeUndefined();
}

describe('array-pattern destructuring Definition extraction (#1901) — WASM', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1901-wasm-'));
    for (const [rel, content] of Object.entries(FIXTURE)) {
      fs.writeFileSync(path.join(tmpDir, rel), content);
    }
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts one constant definition per bound identifier', () => {
    expectPerElementBindings(path.join(tmpDir, '.codegraph', 'graph.db'));
  });
});

describe.skipIf(!isNativeAvailable())(
  'array-pattern destructuring Definition extraction (#1901) — native',
  () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1901-native-'));
      for (const [rel, content] of Object.entries(FIXTURE)) {
        fs.writeFileSync(path.join(tmpDir, rel), content);
      }
      await buildGraph(tmpDir, { engine: 'native', incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('extracts one constant definition per bound identifier (previously emitted none)', () => {
      expectPerElementBindings(path.join(tmpDir, '.codegraph', 'graph.db'));
    });
  },
);
