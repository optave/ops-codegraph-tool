/**
 * Phase 8.5: Enhanced Dynamic Dispatch Resolution — CHA + RTA
 *
 * Verifies three capabilities introduced in Phase 8.5:
 *
 * 1. CHA interface dispatch: `worker.doWork()` where `worker: IWorker` now
 *    resolves to ALL instantiated concrete implementations (ConcreteWorker and
 *    MockWorker), not just the interface method declaration.
 *
 * 2. RTA filtering: GhostWorker implements IWorker but is never constructed
 *    with `new GhostWorker()`, so the RTA filter excludes it from CHA targets.
 *    No `dispatch → GhostWorker.doWork` edge should be emitted.
 *
 * 3. this-dispatch: `this.prepare()` inside ConcreteWorker.doWork resolves to
 *    ConcreteWorker.prepare via class hierarchy analysis.
 *
 * Fixture layout:
 *   IWorker.ts          — interface IWorker { doWork(): string }
 *   ConcreteWorker.ts   — implements IWorker; doWork() calls this.prepare()
 *   MockWorker.ts       — implements IWorker; simple doWork()
 *   GhostWorker.ts      — implements IWorker; never instantiated (RTA filter)
 *   Dispatcher.ts       — dispatch(worker: IWorker) + creates new ConcreteWorker/MockWorker
 *   Animal.ts           — base class with speak()
 *   Lion.ts             — extends Animal; speak() calls super.speak()
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'cha-dispatch');

interface CallEdgeRow {
  caller_name: string;
  caller_file: string;
  callee_name: string;
  callee_file: string;
}

function readCallEdges(dbPath: string): CallEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS caller_name, n1.file AS caller_file,
                n2.name AS callee_name, n2.file AS callee_file
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.file, n1.name, n2.file, n2.name`,
      )
      .all() as CallEdgeRow[];
  } finally {
    db.close();
  }
}

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)('Phase 8.5 CHA dispatch (%s)', (engine) => {
  let tmpDir: string;
  let callEdges: CallEdgeRow[];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-8.5-${engine}-`));
    fs.cpSync(FIXTURE_DIR, tmpDir, { recursive: true });

    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine });
    callEdges = readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
  }, 60_000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── CHA interface dispatch ─────────────────────────────────────────────

  it('CHA: emits dispatch → ConcreteWorker.doWork (instantiated implementor)', () => {
    const edge = callEdges.find(
      (e) =>
        e.caller_name === 'dispatch' &&
        e.callee_name === 'ConcreteWorker.doWork' &&
        e.callee_file === 'ConcreteWorker.ts',
    );
    expect(
      edge,
      `Expected dispatch → ConcreteWorker.doWork edge (CHA should expand IWorker dispatch).\nActual edges:\n${JSON.stringify(callEdges, null, 2)}`,
    ).toBeDefined();
  });

  it('CHA: emits dispatch → MockWorker.doWork (instantiated implementor)', () => {
    const edge = callEdges.find(
      (e) =>
        e.caller_name === 'dispatch' &&
        e.callee_name === 'MockWorker.doWork' &&
        e.callee_file === 'MockWorker.ts',
    );
    expect(
      edge,
      `Expected dispatch → MockWorker.doWork edge (CHA should expand IWorker dispatch).\nActual edges:\n${JSON.stringify(callEdges, null, 2)}`,
    ).toBeDefined();
  });

  // ── RTA filter ─────────────────────────────────────────────────────────

  it('RTA: does NOT emit dispatch → GhostWorker.doWork (never instantiated)', () => {
    const edge = callEdges.find(
      (e) => e.caller_name === 'dispatch' && e.callee_name === 'GhostWorker.doWork',
    );
    expect(
      edge,
      `Expected NO dispatch → GhostWorker.doWork edge (RTA should exclude uninstantiated types).\nActual edges:\n${JSON.stringify(callEdges, null, 2)}`,
    ).toBeUndefined();
  });

  // ── this-dispatch ──────────────────────────────────────────────────────

  it('this-dispatch: emits ConcreteWorker.doWork → ConcreteWorker.prepare', () => {
    const edge = callEdges.find(
      (e) =>
        e.caller_name === 'ConcreteWorker.doWork' &&
        e.callee_name === 'ConcreteWorker.prepare' &&
        e.callee_file === 'ConcreteWorker.ts',
    );
    expect(
      edge,
      `Expected ConcreteWorker.doWork → ConcreteWorker.prepare edge (this-dispatch).\nActual edges:\n${JSON.stringify(callEdges, null, 2)}`,
    ).toBeDefined();
  });

  // ── super-dispatch ─────────────────────────────────────────────────────

  it('super-dispatch: emits Lion.speak → Animal.speak', () => {
    const edge = callEdges.find(
      (e) =>
        e.caller_name === 'Lion.speak' &&
        e.callee_name === 'Animal.speak' &&
        e.callee_file === 'Animal.ts',
    );
    expect(
      edge,
      `Expected Lion.speak → Animal.speak edge (super-dispatch via class hierarchy).\nActual edges:\n${JSON.stringify(callEdges, null, 2)}`,
    ).toBeDefined();
  });

  it('super-dispatch: does NOT CHA-expand Lion.speak to sibling Tiger.speak', () => {
    // Tiger is also a subclass of Animal (sibling to Lion). A super.speak() call
    // in Lion.speak goes to Animal.speak — it must NOT be CHA-expanded to
    // Tiger.speak (a sibling), which Lion would never invoke.
    const edge = callEdges.find(
      (e) => e.caller_name === 'Lion.speak' && e.callee_name === 'Tiger.speak',
    );
    expect(
      edge,
      `Expected NO Lion.speak → Tiger.speak edge (super-dispatch must not expand to sibling subclasses).\nActual edges:\n${JSON.stringify(callEdges, null, 2)}`,
    ).toBeUndefined();
  });

  // ── transitive multi-level CHA (issue #1311) ───────────────────────────
  // Hierarchy: IJob → AbstractJob (non-instantiated) → PrintJob / ScanJob
  // resolveChaTargets must BFS through AbstractJob to reach the concrete types.
  //
  // The native path relies on the Rust extractor emitting `implements`/`extends`
  // edges for `abstract class X implements Y`.  The pre-compiled native binary
  // (v3.11.2) does not yet include the `abstract_class_declaration` fix, so
  // transitive CHA requires a binary update. Also blocked by the same raw
  // call-site gap (issue #1326).

  if (engine === 'native') {
    it.todo('CHA transitive: emits runJob → PrintJob.run (3-level hierarchy) (native gap #1326)');
    it.todo('CHA transitive: emits runJob → ScanJob.run (3-level hierarchy) (native gap #1326)');
  } else {
    it('CHA transitive: emits runJob → PrintJob.run (3-level hierarchy)', () => {
      const edge = callEdges.find(
        (e) =>
          e.caller_name === 'runJob' &&
          e.callee_name === 'PrintJob.run' &&
          e.callee_file === 'PrintJob.ts',
      );
      expect(
        edge,
        `Expected runJob → PrintJob.run edge (transitive CHA through AbstractJob).\nActual edges:\n${JSON.stringify(callEdges, null, 2)}`,
      ).toBeDefined();
    });

    it('CHA transitive: emits runJob → ScanJob.run (3-level hierarchy)', () => {
      const edge = callEdges.find(
        (e) =>
          e.caller_name === 'runJob' &&
          e.callee_name === 'ScanJob.run' &&
          e.callee_file === 'ScanJob.ts',
      );
      expect(
        edge,
        `Expected runJob → ScanJob.run edge (transitive CHA through AbstractJob).\nActual edges:\n${JSON.stringify(callEdges, null, 2)}`,
      ).toBeDefined();
    });
  }

  it('CHA transitive: does NOT emit runJob → AbstractJob.run (abstract, never instantiated)', () => {
    const edge = callEdges.find(
      (e) => e.caller_name === 'runJob' && e.callee_name === 'AbstractJob.run',
    );
    expect(
      edge,
      `Expected NO runJob → AbstractJob.run edge (AbstractJob is never instantiated).\nActual edges:\n${JSON.stringify(callEdges, null, 2)}`,
    ).toBeUndefined();
  });
});
