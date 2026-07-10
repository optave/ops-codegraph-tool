/**
 * Regression for #1848: the native engine's `run_pipeline` orchestrator
 * classified "barrel-only" files (reexports.length >= ownDefs) by scanning
 * *every* file in the current `file_symbols` map, on full builds and
 * incremental builds alike. WASM only ever classifies files that are
 * transiently side-loaded purely to resolve a reexport chain
 * (`resolve-imports.ts::reparseBarrelFiles`, incremental-only) — never a
 * file that's genuinely part of the build's changed set, and never on a
 * full build (where every file is "genuinely changed").
 *
 * Both divergences caused native to silently drop a barrel-like file's own
 * non-reexport imports (`imports-type`/`imports`/`dynamic-imports`) that
 * WASM correctly keeps:
 *
 *   - Full build: native classified every barrel-like file as barrel-only;
 *     WASM never populates `barrelOnlyFiles` on full builds at all.
 *   - Incremental build: native classified a *changed* barrel-like file as
 *     barrel-only just because it was present in `file_symbols`; WASM only
 *     classifies files added by the barrel-discovery re-parse, never a file
 *     that was already part of the changed set.
 *
 * Fixture: `consumer.ts` re-exports `loadPlotConfig` from `viewer.ts` (1
 * reexport) and also declares its own function `useConfig` (1 own def), so
 * `reexports.length (1) >= ownDefs (1)` classifies it as barrel-like. It also
 * has a genuine `import type { PlotConfig }` from the same file — a
 * non-reexport import that must always survive.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

const FIXTURE_DIR = path.join(
  import.meta.dirname,
  '..',
  'fixtures',
  'issue-1848-barrel-only-full-build',
);

function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function hasPlotConfigTypeImportEdge(dbPath: string): boolean {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT COUNT(*) AS c FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE n1.file = 'consumer.ts' AND n2.file = 'viewer.ts'
           AND n2.name = 'PlotConfig' AND e.kind = 'imports-type'`,
      )
      .get() as { c: number };
    return rows.c > 0;
  } finally {
    db.close();
  }
}

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)('Issue #1848 barrel-only import skipping parity (%s)', (engine) => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-1848-${engine}-`));
    copyDirSync(FIXTURE_DIR, tmpDir);
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps the imports-type edge for a barrel-like file on a full build', async () => {
    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine });
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    expect(hasPlotConfigTypeImportEdge(dbPath)).toBe(true);
  }, 30_000);

  it('keeps the imports-type edge when the barrel-like file itself is the changed file on an incremental rebuild', async () => {
    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine });

    // Edit consumer.ts (the barrel-like file itself, not an unrelated file) so
    // it re-enters `file_symbols` as a genuinely-changed file, not a
    // transient barrel-discovery side-load.
    fs.appendFileSync(path.join(tmpDir, 'consumer.ts'), '\n// touch\n');
    await buildGraph(tmpDir, { incremental: true, skipRegistry: true, engine });

    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    expect(hasPlotConfigTypeImportEdge(dbPath)).toBe(true);
  }, 30_000);
});
