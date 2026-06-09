/**
 * Regression test for the missing callerName in the incremental resolveCallTargets call.
 *
 * Without callerName, same-class `this.method()` dispatch (which requires
 * callerName to construct the qualified key `ClassName.method`) silently
 * produces zero targets in incremental builds, dropping edges that a full
 * build emits correctly.
 *
 * Covers the fix in #1370.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'this-dispatch-scope');

interface CallEdgeRow {
  caller_name: string;
  callee_name: string;
}

function readCallEdges(dbPath: string): CallEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS caller_name, n2.name AS callee_name
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
      )
      .all() as CallEdgeRow[];
  } finally {
    db.close();
  }
}

describe('incremental callerName parity — this-dispatch scoped resolution', () => {
  let tmpDir: string;
  let fullEdges: CallEdgeRow[];
  let incrEdges: CallEdgeRow[];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-caller-name-parity-'));
    const fullDir = path.join(tmpDir, 'full');
    const incrDir = path.join(tmpDir, 'incr');

    fs.cpSync(FIXTURE_DIR, fullDir, { recursive: true });
    fs.cpSync(FIXTURE_DIR, incrDir, { recursive: true });

    // Initial full build on the incr copy (establishes baseline hashes)
    await buildGraph(incrDir, { incremental: false, skipRegistry: true, engine: 'wasm' });

    // Comment-only touch — triggers incremental rebuild of shapes.ts
    const touch = (dir: string) => fs.appendFileSync(path.join(dir, 'shapes.ts'), '\n// touch\n');
    touch(fullDir);
    touch(incrDir);

    // Full build from scratch
    await buildGraph(fullDir, { incremental: false, skipRegistry: true, engine: 'wasm' });
    // Incremental rebuild — exercises the callerName-augmented incremental path
    await buildGraph(incrDir, { incremental: true, skipRegistry: true, engine: 'wasm' });

    fullEdges = readCallEdges(path.join(fullDir, '.codegraph', 'graph.db'));
    incrEdges = readCallEdges(path.join(incrDir, '.codegraph', 'graph.db'));
  }, 60_000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('incremental emits Shape.describe → Shape.area (callerName-gated same-class dispatch)', () => {
    const edge = incrEdges.find(
      (e) => e.caller_name === 'Shape.describe' && e.callee_name === 'Shape.area',
    );
    expect(
      edge,
      `Expected Shape.describe → Shape.area in incremental build.\nActual edges:\n${JSON.stringify(incrEdges, null, 2)}`,
    ).toBeDefined();
  });

  it('incremental does NOT emit Shape.describe → Calculator.area (cross-class false-positive)', () => {
    const edge = incrEdges.find(
      (e) => e.caller_name === 'Shape.describe' && e.callee_name === 'Calculator.area',
    );
    expect(
      edge,
      `Expected NO Shape.describe → Calculator.area edge.\nActual edges:\n${JSON.stringify(incrEdges, null, 2)}`,
    ).toBeUndefined();
  });

  it('incremental does NOT emit Shape.describe → Formatter.area (cross-class false-positive)', () => {
    const edge = incrEdges.find(
      (e) => e.caller_name === 'Shape.describe' && e.callee_name === 'Formatter.area',
    );
    expect(
      edge,
      `Expected NO Shape.describe → Formatter.area edge.\nActual edges:\n${JSON.stringify(incrEdges, null, 2)}`,
    ).toBeUndefined();
  });

  it('incremental edges match full build edges exactly', () => {
    const fullSet = new Set(fullEdges.map((e) => `${e.caller_name}→${e.callee_name}`));
    const incrSet = new Set(incrEdges.map((e) => `${e.caller_name}→${e.callee_name}`));
    const missing = [...fullSet].filter((k) => !incrSet.has(k));
    const extra = [...incrSet].filter((k) => !fullSet.has(k));
    expect(missing, `Missing in incremental: ${missing.join(', ')}`).toEqual([]);
    expect(extra, `Extra in incremental: ${extra.join(', ')}`).toEqual([]);
  });
});
