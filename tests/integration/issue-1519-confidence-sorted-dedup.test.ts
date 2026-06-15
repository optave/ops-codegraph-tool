/**
 * Confidence-value sanity tests for the sorted multi-target resolution path (#1519).
 *
 * PR #1486 added a descending-confidence sort to the `targets` array in
 * buildFileCallEdges (build-edges.ts lines 1126-1132) before the emit loop,
 * and matching sorts to the Phase 8.3 pts alias loops.
 *
 * WHAT THESE TESTS GUARD
 * ──────────────────────
 * Both fixtures resolve multiple candidates with distinct node IDs (different
 * files → different graph nodes). The `seenCallEdges` / `ptsEdgeRows` dedup key
 * is `${caller.id}|${t.id}`, so dedup never fires across distinct nodes.
 *
 * These tests therefore verify the confidence SCORING invariant:
 *   • A near-directory target always receives a higher confidence value than a
 *     far-directory target for the same call site.
 *   • Both edges are emitted (neither is suppressed by sort logic).
 *
 * WHAT THESE TESTS DO NOT GUARD
 * ──────────────────────────────
 * The dedup-winning path — where the same node ID appears twice in `targets`
 * via different resolution strategies — is not exercised here. In that scenario
 * the sort determines which confidence value reaches the `seenCallEdges` guard
 * first and wins; these tests would remain green even if the sort were removed.
 * A dedicated fixture for that path is tracked in #1547.
 *
 * Scenario tested: `process` calls `helper()` without an import.
 * Two definitions exist:
 *   - src/helper.js  (same directory as caller → computeConfidence ≥ 0.7)
 *   - other/helper.js (different directory → computeConfidence < 0.7)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

// ── Fixture: multi-target byName resolution with different confidence scores ──
//
// src/consumer.js calls helper() without importing it.
// Two files define helper(): one in the same directory (high confidence),
// one in a different directory (low confidence).
// Both edges are expected, each with the correct confidence for its file proximity.

const MULTI_TARGET_FIXTURE: Record<string, string> = {
  'src/consumer.js': `
export function process() {
  helper(); // no import — resolves via byName to both src/helper.js and other/helper.js
}
`.trimStart(),

  'src/helper.js': `
export function helper() { return 'near'; }
`.trimStart(),

  'other/helper.js': `
export function helper() { return 'far'; }
`.trimStart(),
};

// ── Fixture: pts alias dedup — highest-confidence target wins ptsEdgeRows slot ──
//
// consumer.js aliases a locally-defined `nearHelper` function then calls the alias.
// A second function with the same name exists in a far directory.
// The sort in the pts loop must ensure the near definition (high confidence)
// wins the ptsEdgeRows dedup check and produces the emitted edge.

const PTS_SORT_FIXTURE: Record<string, string> = {
  'src/consumer.js': `
export function nearHelper() { return 42; }

export function run() {
  const fn = nearHelper; // fnRefBinding: fn → nearHelper
  fn();                  // pts call: alias resolves via byName('nearHelper')
}
`.trimStart(),

  'other/nearHelper.js': `
// Same function name in a far directory — lower confidence from src/consumer.js
export function nearHelper() { return 0; }
`.trimStart(),
};

// ── DB helpers ────────────────────────────────────────────────────────────────

function readEdgesWithConfidence(dbPath: string): Array<{
  source: string;
  source_file: string;
  target: string;
  target_file: string;
  confidence: number;
}> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS source, n1.file AS source_file,
                n2.name AS target, n2.file AS target_file,
                e.confidence
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.file`,
      )
      .all() as Array<{
      source: string;
      source_file: string;
      target: string;
      target_file: string;
      confidence: number;
    }>;
  } finally {
    db.close();
  }
}

function writeFixture(baseDir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const fullPath = path.join(baseDir, rel);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

// ── Multi-target byName suite ──────────────────────────────────────────────────

describe('confidence-sorted dedup: multi-target byName resolution (#1519)', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1519-multi-'));
    writeFixture(tmpDir, MULTI_TARGET_FIXTURE);
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  }, 60_000);

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('emits an edge from process to the near helper (src/helper.js)', () => {
    const edges = readEdgesWithConfidence(path.join(tmpDir, '.codegraph', 'graph.db'));
    const nearEdge = edges.find(
      (e) => e.source === 'process' && e.target === 'helper' && e.target_file === 'src/helper.js',
    );
    expect(
      nearEdge,
      'Expected edge process → helper (src/helper.js) — confidence sort may have suppressed the high-confidence target',
    ).toBeDefined();
  });

  it('near-target edge (src/helper.js) has confidence ≥ 0.7 (same-directory proximity)', () => {
    const edges = readEdgesWithConfidence(path.join(tmpDir, '.codegraph', 'graph.db'));
    const nearEdge = edges.find(
      (e) => e.source === 'process' && e.target === 'helper' && e.target_file === 'src/helper.js',
    );
    expect(nearEdge).toBeDefined();
    // computeConfidence: same directory → 0.7; imported from same dir → 1.0.
    // Without import, same-dir score is 0.7.
    expect(nearEdge!.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('far-target edge (other/helper.js) has confidence < 0.7 (different-directory proximity)', () => {
    const edges = readEdgesWithConfidence(path.join(tmpDir, '.codegraph', 'graph.db'));
    const farEdge = edges.find(
      (e) => e.source === 'process' && e.target === 'helper' && e.target_file === 'other/helper.js',
    );
    expect(farEdge).toBeDefined();
    // computeConfidence: different parent directory → 0.3 or 0.5.
    // The far target must score lower than the near target.
    expect(farEdge!.confidence).toBeLessThan(0.7);
  });

  it('near-target confidence is strictly greater than far-target confidence', () => {
    const edges = readEdgesWithConfidence(path.join(tmpDir, '.codegraph', 'graph.db'));
    const nearEdge = edges.find(
      (e) => e.source === 'process' && e.target === 'helper' && e.target_file === 'src/helper.js',
    );
    const farEdge = edges.find(
      (e) => e.source === 'process' && e.target === 'helper' && e.target_file === 'other/helper.js',
    );
    expect(nearEdge).toBeDefined();
    expect(farEdge).toBeDefined();
    // The sort at build-edges.ts:1126-1132 processes high-confidence targets first.
    // Both edges are stored (different node IDs); this assertion verifies the
    // confidence ordering invariant that the sort enforces.
    expect(nearEdge!.confidence).toBeGreaterThan(farEdge!.confidence);
  });
});

// ── pts alias sort suite ───────────────────────────────────────────────────────

describe('confidence-sorted dedup: pts alias loop ordering (#1519)', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1519-pts-'));
    writeFixture(tmpDir, PTS_SORT_FIXTURE);
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  }, 60_000);

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('emits a pts edge from run to the local nearHelper (src/consumer.js)', () => {
    const edges = readEdgesWithConfidence(path.join(tmpDir, '.codegraph', 'graph.db'));
    // The pts alias `const fn = nearHelper; fn()` should resolve run → nearHelper.
    // The local definition (same file, confidence 1.0 before penalty) must beat
    // the far definition in other/nearHelper.js (confidence 0.3 before penalty).
    const nearEdge = edges.find(
      (e) => e.source === 'run' && e.target === 'nearHelper' && e.target_file === 'src/consumer.js',
    );
    expect(
      nearEdge,
      'Expected pts edge run → nearHelper (src/consumer.js) — pts alias sort may have lost the high-confidence target',
    ).toBeDefined();
  });

  it('pts edge to local nearHelper has confidence > pts edge to far nearHelper (if both exist)', () => {
    const edges = readEdgesWithConfidence(path.join(tmpDir, '.codegraph', 'graph.db'));
    const localEdge = edges.find(
      (e) => e.source === 'run' && e.target === 'nearHelper' && e.target_file === 'src/consumer.js',
    );
    const farEdge = edges.find(
      (e) =>
        e.source === 'run' && e.target === 'nearHelper' && e.target_file === 'other/nearHelper.js',
    );
    // If both edges are present, the local one must have higher confidence.
    // The sort at build-edges.ts:1215-1222 ensures highest-confidence aliasTargets
    // are processed first in the pts loop; the ptsEdgeRows dedup prevents a
    // lower-confidence target from overwriting a higher-confidence entry for the
    // same (caller, target) pair.
    if (localEdge && farEdge) {
      expect(localEdge.confidence).toBeGreaterThan(farEdge.confidence);
    } else {
      // At minimum the local edge must exist (the sort must not suppress it).
      expect(localEdge).toBeDefined();
    }
  });
});
