/**
 * Phase 8.3b parity test — points-to analysis: native vs WASM.
 *
 * Verifies that when a function reference is aliased and passed as a
 * higher-order argument (`const fn = handler; arr.map(fn)`), both engines
 * emit a call edge from the containing function to the aliased target.
 *
 * This test guards the Phase 8.3b native pts implementation introduced in
 * issue #1290. Both engines must produce the same set of call edges.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const hasNative = isNativeAvailable();
const requireParity = !!process.env.CODEGRAPH_PARITY;
const describeOrSkip = requireParity || hasNative ? describe : describe.skip;

// ── Fixture source ────────────────────────────────────────────────────────

const HANDLER_JS = `
export function handler(item) {
  return item * 2;
}
`.trimStart();

const CONSUMER_JS = `
import { handler } from './handler.js';

export function processItems(items) {
  const alias = handler;
  return items.map(alias);
}
`.trimStart();

// ── Helpers ───────────────────────────────────────────────────────────────

function writeFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'handler.js'), HANDLER_JS);
  fs.writeFileSync(path.join(dir, 'consumer.js'), CONSUMER_JS);
}

function readCallEdges(dbPath: string): Array<{ source: string; target: string }> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(`
      SELECT n1.name AS source, n2.name AS target
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE e.kind = 'calls'
      ORDER BY n1.name, n2.name
    `)
    .all() as Array<{ source: string; target: string }>;
  db.close();
  return rows;
}

// ── Test ──────────────────────────────────────────────────────────────────

describeOrSkip('Phase 8.3 pts parity: native vs WASM', () => {
  let wasmDir: string;
  let nativeDir: string;

  beforeAll(async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pts-parity-'));
    wasmDir = path.join(tmpBase, 'wasm');
    nativeDir = path.join(tmpBase, 'native');
    writeFixture(wasmDir);
    writeFixture(nativeDir);

    await buildGraph(wasmDir, { engine: 'wasm', incremental: false, skipRegistry: true });
    await buildGraph(nativeDir, { engine: 'native', incremental: false, skipRegistry: true });
  }, 60_000);

  afterAll(() => {
    try {
      if (wasmDir) fs.rmSync(path.dirname(wasmDir), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('WASM engine resolves processItems → handler via pts alias', () => {
    const edges = readCallEdges(path.join(wasmDir, '.codegraph', 'graph.db'));
    expect(edges).toContainEqual({ source: 'processItems', target: 'handler' });
  });

  it('native engine resolves processItems → handler via pts alias', () => {
    const edges = readCallEdges(path.join(nativeDir, '.codegraph', 'graph.db'));
    expect(edges).toContainEqual({ source: 'processItems', target: 'handler' });
  });

  it('both engines emit identical call edges', () => {
    const wasmEdges = readCallEdges(path.join(wasmDir, '.codegraph', 'graph.db'));
    const nativeEdges = readCallEdges(path.join(nativeDir, '.codegraph', 'graph.db'));
    expect(nativeEdges).toEqual(wasmEdges);
  });
});
