/**
 * this-dispatch scope: same-file fallback must not emit false-positive edges
 * to methods in unrelated classes.
 *
 * Fixtures:
 *  - shapes.ts — three unrelated classes (Shape, Calculator, Formatter) all
 *    defining area().  this.area() inside Shape.describe must resolve only to
 *    Shape.area (multi-match disambiguation path).
 *  - single-sibling.ts — two classes: Caller (no area()) and Sibling (area()).
 *    this.area() inside Caller.run must NOT resolve to Sibling.area even though
 *    it is the only method with that suffix in the file (single-match path).
 *
 * Covers the Rust edge_builder fix in issue #1324.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

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
         WHERE e.kind = 'calls'`,
      )
      .all() as CallEdgeRow[];
  } finally {
    db.close();
  }
}

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)('this-dispatch scope (%s)', (engine) => {
  let tmpDir: string;
  let callEdges: CallEdgeRow[] = [];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-this-scope-${engine}-`));
    fs.cpSync(FIXTURE_DIR, tmpDir, { recursive: true });
    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine });
    callEdges = readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
  }, 60_000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits Shape.describe → Shape.area (correct this-dispatch)', () => {
    const edge = callEdges.find(
      (e) => e.caller_name === 'Shape.describe' && e.callee_name === 'Shape.area',
    );
    expect(
      edge,
      `Expected Shape.describe → Shape.area edge.\nActual edges:\n${JSON.stringify(callEdges, null, 2)}`,
    ).toBeDefined();
  });

  // Native binary v3.11.2 does not include the edge_builder.rs fix for issue #1324 yet.
  // These assertions are active for WASM and will be re-enabled for native once a new
  // binary is published that includes the Rust fix.
  if (engine === 'native') {
    it.todo('does NOT emit Shape.describe → Calculator.area (native binary gap #1324)');
    it.todo('does NOT emit Shape.describe → Formatter.area (native binary gap #1324)');
    it.todo(
      'does NOT emit Caller.run → Sibling.area (single-match false-positive, native binary gap #1324)',
    );
  } else {
    it('does NOT emit Shape.describe → Calculator.area (unrelated class, same method name)', () => {
      const edge = callEdges.find(
        (e) => e.caller_name === 'Shape.describe' && e.callee_name === 'Calculator.area',
      );
      expect(
        edge,
        `Expected NO Shape.describe → Calculator.area edge (false-positive from same-file scan).\nActual edges:\n${JSON.stringify(callEdges, null, 2)}`,
      ).toBeUndefined();
    });

    it('does NOT emit Shape.describe → Formatter.area (unrelated class, same method name)', () => {
      const edge = callEdges.find(
        (e) => e.caller_name === 'Shape.describe' && e.callee_name === 'Formatter.area',
      );
      expect(
        edge,
        `Expected NO Shape.describe → Formatter.area edge (false-positive from same-file scan).\nActual edges:\n${JSON.stringify(callEdges, null, 2)}`,
      ).toBeUndefined();
    });

    // single-sibling.ts: only one class (Sibling) has area(); Caller does not.
    // The single-match arm must still check the caller's own class — Caller.run
    // must not gain a false edge to Sibling.area.
    it('does NOT emit Caller.run → Sibling.area (single-match false-positive, same-file scan)', () => {
      const edge = callEdges.find(
        (e) => e.caller_name === 'Caller.run' && e.callee_name === 'Sibling.area',
      );
      expect(
        edge,
        `Expected NO Caller.run → Sibling.area edge (false-positive from single-match suffix scan).\nActual edges:\n${JSON.stringify(callEdges, null, 2)}`,
      ).toBeUndefined();
    });
  }
});
