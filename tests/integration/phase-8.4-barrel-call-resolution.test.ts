/**
 * Phase 8.4: barrel file re-export chain resolution for call edges.
 *
 * Before this fix, symbols imported through barrel files resolved to the barrel
 * (e.g. `components/index.ts`) instead of the actual definition file
 * (`components/Button.ts`). buildImportedNamesMap (JS/WASM path) mapped
 * `Button → components/index.ts`, so the call edge from `render → Button`
 * was unresolvable.
 *
 * Fixture:
 *   components/Button.ts   — defines `Button`
 *   components/index.ts    — pure barrel: `export { Button } from './Button.js'`
 *   App.ts                 — imports `Button` from barrel, calls it inside `render()`
 *
 * Expected: a `calls` edge from `render` (App.ts) → `Button` (components/Button.ts)
 * — not to the barrel index.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'barrel-call-resolution');

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

describe.each(ENGINES)('Phase 8.4 barrel call resolution (%s)', (engine) => {
  let tmpDir: string;
  let callEdges: CallEdgeRow[];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-8.4-${engine}-`));
    // Copy fixture to a temp dir so the build doesn't pollute the source tree
    fs.cpSync(FIXTURE_DIR, tmpDir, { recursive: true });

    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine });
    callEdges = readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
  }, 60_000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits a calls edge from render to Button in the leaf definition file', () => {
    const barrelCallEdge = callEdges.find(
      (e) =>
        e.caller_name === 'render' &&
        e.callee_name === 'Button' &&
        e.callee_file === 'components/Button.ts',
    );
    expect(
      barrelCallEdge,
      `Expected render → Button (components/Button.ts) edge.\nActual call edges:\n${JSON.stringify(callEdges, null, 2)}`,
    ).toBeDefined();
  });

  it('does NOT emit a calls edge from render to the barrel index', () => {
    const barrelEdge = callEdges.find(
      (e) =>
        e.caller_name === 'render' &&
        e.callee_name === 'Button' &&
        e.callee_file === 'components/index.ts',
    );
    expect(barrelEdge).toBeUndefined();
  });
});
