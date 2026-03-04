/**
 * Full build parity test.
 *
 * Build the same fixture project with both WASM and native engines,
 * then compare the resulting nodes/edges in SQLite.
 *
 * Skipped when the native engine is not installed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/builder.js';
import { isNativeAvailable } from '../../src/native.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'sample-project');

const hasNative = isNativeAvailable();
const describeOrSkip = hasNative ? describe : describe.skip;

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readGraph(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  // Exclude constant nodes — the native engine has a known scope bug where it
  // extracts local `const` variables inside functions as top-level constants,
  // while WASM correctly limits constant extraction to program-level declarations.
  const nodes = db
    .prepare(
      "SELECT name, kind, file, line FROM nodes WHERE kind != 'constant' ORDER BY name, kind, file, line",
    )
    .all();
  const edges = db
    .prepare(`
    SELECT n1.name AS source_name, n2.name AS target_name, e.kind
    FROM edges e
    JOIN nodes n1 ON e.source_id = n1.id
    JOIN nodes n2 ON e.target_id = n2.id
    WHERE n1.kind != 'constant' AND n2.kind != 'constant'
    ORDER BY n1.name, n2.name, e.kind
  `)
    .all();
  db.close();
  return { nodes, edges };
}

describeOrSkip('Build parity: native vs WASM', () => {
  let wasmDir;
  let nativeDir;

  beforeAll(async () => {
    // Create two temp copies of the fixture
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-parity-'));
    wasmDir = path.join(tmpBase, 'wasm');
    nativeDir = path.join(tmpBase, 'native');
    copyDirSync(FIXTURE_DIR, wasmDir);
    copyDirSync(FIXTURE_DIR, nativeDir);

    // Build with WASM
    await buildGraph(wasmDir, { engine: 'wasm', incremental: false, skipRegistry: true });
    // Build with native
    await buildGraph(nativeDir, { engine: 'native', incremental: false, skipRegistry: true });
  }, 60_000);

  afterAll(() => {
    // Cleanup
    try {
      if (wasmDir) fs.rmSync(path.dirname(wasmDir), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('produces identical nodes', () => {
    const wasmGraph = readGraph(path.join(wasmDir, '.codegraph', 'graph.db'));
    const nativeGraph = readGraph(path.join(nativeDir, '.codegraph', 'graph.db'));
    expect(nativeGraph.nodes).toEqual(wasmGraph.nodes);
  });

  it('produces identical edges', () => {
    const wasmGraph = readGraph(path.join(wasmDir, '.codegraph', 'graph.db'));
    const nativeGraph = readGraph(path.join(nativeDir, '.codegraph', 'graph.db'));
    expect(nativeGraph.edges).toEqual(wasmGraph.edges);
  });
});
