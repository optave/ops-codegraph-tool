/**
 * Regression test for #1689: CJS require-destructured class must produce a
 * receiver edge in the WASM engine, matching native behaviour.
 *
 * Setup:
 *   - utils.js: exports `class Calculator { compute() {} }`
 *   - index.js: `const { Calculator } = require('./utils'); ... new Calculator(); calc.compute()`
 *
 * Root cause: `const { Calculator } = require('./utils')` creates a
 * kind='function' shadow node for `Calculator` in index.js.
 * `resolveReceiverEdge` uses `importedNames.has(effectiveReceiver)` to
 * distinguish import artifacts from local definitions.  CJS bindings were
 * absent from `importedNames` (only ES module imports were included), so
 * `isLocalDefinition` was wrongly `true`, blocking the global class lookup.
 *
 * Fix (PR #1671, via `buildImportArtifactNames`): the map passed to
 * `resolveReceiverEdge` now includes CJS require bindings in addition to ES
 * module imports, so the shadow function node is correctly classified as an
 * import artifact and the global `class Calculator` wins.
 *
 * Both engines must emit `main → Calculator (receiver)`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const UTILS_JS = `
const { add, square } = require('./math');

class Calculator {
  compute(x, y) {
    return x + y;
  }
}

module.exports = { Calculator };
`;

const INDEX_JS = `
const { Calculator } = require('./utils');

function main() {
  const calc = new Calculator();
  calc.compute(1, 2);
}

module.exports = { main };
`;

const MATH_JS = `
function add(a, b) { return a + b; }
function square(x) { return x * x; }
module.exports = { add, square };
`;

let tmpWasm: string;
let tmpNative: string;

beforeAll(async () => {
  tmpWasm = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1689-wasm-'));
  fs.writeFileSync(path.join(tmpWasm, 'utils.js'), UTILS_JS);
  fs.writeFileSync(path.join(tmpWasm, 'index.js'), INDEX_JS);
  fs.writeFileSync(path.join(tmpWasm, 'math.js'), MATH_JS);

  tmpNative = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1689-native-'));
  fs.writeFileSync(path.join(tmpNative, 'utils.js'), UTILS_JS);
  fs.writeFileSync(path.join(tmpNative, 'index.js'), INDEX_JS);
  fs.writeFileSync(path.join(tmpNative, 'math.js'), MATH_JS);

  await Promise.all([
    buildGraph(tmpWasm, { incremental: false, skipRegistry: true, engine: 'wasm' }),
    buildGraph(tmpNative, { incremental: false, skipRegistry: true, engine: 'native' }),
  ]);
}, 30_000);

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

describe('CJS require-destructured class emits receiver edge (#1689)', () => {
  it('WASM: main → Calculator (receiver) edge exists', () => {
    const edges = getReceiverEdges(path.join(tmpWasm, '.codegraph', 'graph.db'));
    const recv = edges.find((e) => e.src === 'main' && e.tgt === 'Calculator');
    expect(
      recv,
      `Expected WASM to emit receiver edge main → Calculator.\nActual edges:\n${JSON.stringify(edges, null, 2)}`,
    ).toBeDefined();
    expect(recv?.tgt_file).toBe('utils.js');
  });

  it('Native: main → Calculator (receiver) edge exists', () => {
    const edges = getReceiverEdges(path.join(tmpNative, '.codegraph', 'graph.db'));
    const recv = edges.find((e) => e.src === 'main' && e.tgt === 'Calculator');
    expect(
      recv,
      `Expected native to emit receiver edge main → Calculator.\nActual edges:\n${JSON.stringify(edges, null, 2)}`,
    ).toBeDefined();
    expect(recv?.tgt_file).toBe('utils.js');
  });

  it('both engines emit identical receiver edges', () => {
    const wasmEdges = getReceiverEdges(path.join(tmpWasm, '.codegraph', 'graph.db'));
    const nativeEdges = getReceiverEdges(path.join(tmpNative, '.codegraph', 'graph.db'));
    expect(wasmEdges).toEqual(nativeEdges);
  });
});
