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

// Fixture for the confidence-upgrade scenario: the caller both aliases and
// directly calls the same target in the same function body.  The pts-resolved
// edge (lower confidence) must be upgraded to direct-call confidence when the
// direct call is encountered — mirroring the ptsEdgeRows upgrade on the JS path.
const CONSUMER_UPGRADE_JS = `
import { handler } from './handler.js';

export function processItemsDirect(items) {
  const alias = handler;
  items.map(alias);  // pts-resolved edge (penalised confidence)
  handler(items[0]); // direct call — must upgrade confidence in-place
}
`.trimStart();

// ── Helpers ───────────────────────────────────────────────────────────────

function writeFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'handler.js'), HANDLER_JS);
  fs.writeFileSync(path.join(dir, 'consumer.js'), CONSUMER_JS);
}

function writeUpgradeFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'handler.js'), HANDLER_JS);
  fs.writeFileSync(path.join(dir, 'consumer.js'), CONSUMER_UPGRADE_JS);
}

function readCallEdgesWithConfidence(
  dbPath: string,
): Array<{ source: string; target: string; confidence: number }> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(`
      SELECT n1.name AS source, n2.name AS target, e.confidence
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE e.kind = 'calls'
      ORDER BY n1.name, n2.name
    `)
    .all() as Array<{ source: string; target: string; confidence: number }>;
  db.close();
  return rows;
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

// ── WASM-only test (always runs, guards the serialization fix) ────────────
//
// The bug fixed in Phase 8.3 was that `fnRefBindings` was silently dropped at
// the WASM worker boundary.  This suite does NOT require native — it always
// runs and validates that the WASM engine alone resolves alias call edges.

describe('Phase 8.3 WASM pts: fnRefBindings serialization fix', () => {
  let wasmOnlyDir: string;

  beforeAll(async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pts-wasm-'));
    wasmOnlyDir = path.join(tmpBase, 'wasm');
    writeFixture(wasmOnlyDir);
    await buildGraph(wasmOnlyDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  }, 60_000);

  afterAll(() => {
    try {
      if (wasmOnlyDir) fs.rmSync(path.dirname(wasmOnlyDir), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('WASM engine records fnRefBindings and resolves processItems → handler via pts alias', () => {
    const edges = readCallEdges(path.join(wasmOnlyDir, '.codegraph', 'graph.db'));
    expect(edges).toContainEqual({ source: 'processItems', target: 'handler' });
  });
});

// ── Confidence upgrade test (WASM always runs) ────────────────────────────
//
// Guards the ptsEdgeRows / pts_edge_map confidence-upgrade path: when a file
// contains both an alias call (pts-resolved, penalised confidence) and a
// subsequent direct call to the same target in the same function body, the edge
// confidence must be upgraded to the direct-call value — not left at the
// penalised pts confidence.  Both engines must agree.

describe('Phase 8.3 pts: confidence upgrade when alias + direct call coexist (WASM)', () => {
  let upgradeWasmDir: string;

  beforeAll(async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pts-upgrade-wasm-'));
    upgradeWasmDir = path.join(tmpBase, 'wasm');
    writeUpgradeFixture(upgradeWasmDir);
    await buildGraph(upgradeWasmDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  }, 60_000);

  afterAll(() => {
    try {
      if (upgradeWasmDir) fs.rmSync(path.dirname(upgradeWasmDir), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('WASM engine emits processItemsDirect → handler with direct-call confidence (not pts-penalised)', () => {
    const edges = readCallEdgesWithConfidence(path.join(upgradeWasmDir, '.codegraph', 'graph.db'));
    const edge = edges.find((e) => e.source === 'processItemsDirect' && e.target === 'handler');
    expect(edge).toBeDefined();
    // Direct-call confidence (>= 0.9 for same-dir imports) must be higher than
    // a pts-penalised confidence (direct - 0.1).  Assert it is at least 0.9 to
    // confirm the upgrade happened and the penalised value was not kept.
    expect(edge!.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

describeOrSkip(
  'Phase 8.3 pts: confidence upgrade when alias + direct call coexist (parity)',
  () => {
    let upgradeWasmDir: string;
    let upgradeNativeDir: string;

    beforeAll(async () => {
      const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pts-upgrade-'));
      upgradeWasmDir = path.join(tmpBase, 'wasm');
      upgradeNativeDir = path.join(tmpBase, 'native');
      writeUpgradeFixture(upgradeWasmDir);
      writeUpgradeFixture(upgradeNativeDir);

      await buildGraph(upgradeWasmDir, { engine: 'wasm', incremental: false, skipRegistry: true });
      await buildGraph(upgradeNativeDir, {
        engine: 'native',
        incremental: false,
        skipRegistry: true,
      });
    }, 60_000);

    afterAll(() => {
      try {
        if (upgradeWasmDir)
          fs.rmSync(path.dirname(upgradeWasmDir), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('native engine emits processItemsDirect → handler with direct-call confidence (not pts-penalised)', () => {
      const edges = readCallEdgesWithConfidence(
        path.join(upgradeNativeDir, '.codegraph', 'graph.db'),
      );
      const edge = edges.find((e) => e.source === 'processItemsDirect' && e.target === 'handler');
      expect(edge).toBeDefined();
      expect(edge!.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('both engines emit identical confidence for the processItemsDirect → handler edge', () => {
      const wasmEdges = readCallEdgesWithConfidence(
        path.join(upgradeWasmDir, '.codegraph', 'graph.db'),
      );
      const nativeEdges = readCallEdgesWithConfidence(
        path.join(upgradeNativeDir, '.codegraph', 'graph.db'),
      );
      const wasmEdge = wasmEdges.find(
        (e) => e.source === 'processItemsDirect' && e.target === 'handler',
      );
      const nativeEdge = nativeEdges.find(
        (e) => e.source === 'processItemsDirect' && e.target === 'handler',
      );
      expect(nativeEdge).toBeDefined();
      expect(wasmEdge).toBeDefined();
      expect(nativeEdge!.confidence).toBeCloseTo(wasmEdge!.confidence, 5);
    });
  },
);

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
