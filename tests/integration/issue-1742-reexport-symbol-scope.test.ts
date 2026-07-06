/**
 * Regression for #1742: `codegraph exports <file>` treated a single named
 * re-export (`export { X } from 'Y'`) as if the file transitively
 * re-exported EVERY export of `Y`, even symbols never mentioned in any
 * reexport clause (and even symbols only ever imported as a type).
 *
 * Fixture:
 *   viewer.ts      — defines loadPlotConfig, buildLayoutOptions, escapeHtml
 *                    (function) and PlotConfig (interface)
 *   helpers.ts     — defines formatDate, formatNumber
 *   enrichment.ts  — `export { loadPlotConfig, buildLayoutOptions as
 *                    buildOptions } from './viewer.js'` (named, one plain +
 *                    one renamed specifier in a single statement) plus
 *                    `import type { PlotConfig } from './viewer.js'`
 *                    (type-only — NOT a reexport)
 *   all-helpers.ts — `export * from './helpers.js'` (pure wildcard barrel)
 *
 * Before the fix, `reexportedSymbols` for enrichment.ts dumped all four of
 * viewer.ts's exports (including escapeHtml and PlotConfig, neither of
 * which is re-exported) merely because a file-level `reexports` edge to
 * viewer.ts existed. It should report exactly loadPlotConfig and
 * buildLayoutOptions from viewer.ts. all-helpers.ts's wildcard re-export
 * should keep reporting every export of helpers.ts — genuinely different
 * semantics from a named specifier, handled distinctly.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { exportsData } from '../../src/domain/queries.js';
import type { EngineMode } from '../../src/types.js';

const FIXTURE_DIR = path.join(
  import.meta.dirname,
  '..',
  'fixtures',
  'issue-1742-reexport-symbol-scope',
);

interface EdgeRow {
  source_file: string;
  target_file: string;
  target_name: string;
  target_kind: string;
  kind: string;
}

function readReexportEdges(dbPath: string): EdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.file AS source_file, n2.file AS target_file,
                n2.name AS target_name, n2.kind AS target_kind, e.kind
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'reexports'
         ORDER BY n1.file, n2.file, n2.name`,
      )
      .all() as EdgeRow[];
  } finally {
    db.close();
  }
}

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)('#1742 reexportedSymbols scoping (%s)', (engine) => {
  let tmpDir: string;
  let dbPath: string;
  let reexportEdges: EdgeRow[];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-1742-${engine}-`));
    fs.cpSync(FIXTURE_DIR, tmpDir, { recursive: true });

    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine });
    dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    reexportEdges = readReexportEdges(dbPath);
  }, 60_000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits a symbol-level reexports edge straight to loadPlotConfig', () => {
    const edge = reexportEdges.find(
      (e) => e.source_file === 'enrichment.ts' && e.target_name === 'loadPlotConfig',
    );
    expect(
      edge,
      `Expected a symbol-level reexports edge to loadPlotConfig.\nActual reexports edges:\n${JSON.stringify(reexportEdges, null, 2)}`,
    ).toBeDefined();
    expect(edge!.target_file).toBe('viewer.ts');
    expect(edge!.target_kind).not.toBe('file');
  });

  it('emits a symbol-level reexports edge to buildLayoutOptions (original name, not the external alias)', () => {
    const edge = reexportEdges.find(
      (e) => e.source_file === 'enrichment.ts' && e.target_name === 'buildLayoutOptions',
    );
    expect(edge).toBeDefined();
    expect(edge!.target_file).toBe('viewer.ts');
    expect(reexportEdges.some((e) => e.target_name === 'buildOptions')).toBe(false);
  });

  it('does NOT emit a symbol-level reexports edge to escapeHtml or PlotConfig', () => {
    expect(reexportEdges.some((e) => e.target_name === 'escapeHtml')).toBe(false);
    expect(reexportEdges.some((e) => e.target_name === 'PlotConfig')).toBe(false);
  });

  it('does NOT emit any symbol-level reexports edge for the wildcard barrel', () => {
    const fromAllHelpers = reexportEdges.filter((e) => e.source_file === 'all-helpers.ts');
    // Only the file-level edge (target_kind === 'file') should exist — no
    // specific names are ever spelled out in `export * from './helpers.js'`.
    expect(fromAllHelpers.every((e) => e.target_kind === 'file')).toBe(true);
    expect(fromAllHelpers.length).toBeGreaterThan(0);
  });

  it('exportsData reports only the specifically-named symbols from viewer.ts', () => {
    const data = exportsData('enrichment.ts', dbPath);
    const fromViewer = data.reexportedSymbols
      .filter((s: { originFile: string }) => s.originFile === 'viewer.ts')
      .map((s: { name: string }) => s.name)
      .sort();
    expect(fromViewer).toEqual(['buildLayoutOptions', 'loadPlotConfig']);
  });

  it('exportsData totalReexported for enrichment.ts is exactly 2 — not the 4 that the pre-fix leak would report', () => {
    const data = exportsData('enrichment.ts', dbPath);
    expect(data.reexportedSymbols.length).toBe(2);
    expect(data.totalReexported).toBe(2);
  });

  it('exportsData still reports the full wildcard re-export list for the pure-barrel file', () => {
    const data = exportsData('all-helpers.ts', dbPath);
    const names = data.reexportedSymbols.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(['formatDate', 'formatNumber']);
    expect(data.totalReexported).toBe(2);
  });
});
