/**
 * Integration tests for the `exports` command (exportsData).
 *
 * Test graph:
 *
 *   Files: lib.js, app.js, barrel.js, lib.test.js
 *
 *   Symbols in lib.js: add (function, line 1), multiply (function, line 10),
 *                       helper (function, line 20), unusedFn (function, line 30)
 *   Symbols in app.js: main (function, line 1)
 *   Symbols in lib.test.js: testAdd (function, line 1)
 *
 *   Exported (exported=1): add, multiply, unusedFn
 *   Internal (not exported): helper
 *
 *   Call edges:
 *     main → add        (cross-file)
 *     main → multiply   (cross-file)
 *     add → helper      (same-file, internal)
 *     testAdd → add     (cross-file, from test)
 *
 *   Reexport edge:
 *     barrel.js → lib.js (kind: 'reexports')
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { exportsData } from '../../src/domain/queries.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function insertNode(db, name, kind, file, line) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind, confidence = 1.0) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, 0)',
  ).run(sourceId, targetId, kind, confidence);
}

// ─── Fixture DB ────────────────────────────────────────────────────────

let tmpDir: string, dbPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-exports-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // File nodes
  const fLib = insertNode(db, 'lib.js', 'file', 'lib.js', 0);
  const fApp = insertNode(db, 'app.js', 'file', 'app.js', 0);
  const fBarrel = insertNode(db, 'barrel.js', 'file', 'barrel.js', 0);
  const fTest = insertNode(db, 'lib.test.js', 'file', 'lib.test.js', 0);

  // Function nodes in lib.js
  const add = insertNode(db, 'add', 'function', 'lib.js', 1);
  const multiply = insertNode(db, 'multiply', 'function', 'lib.js', 10);
  const helper = insertNode(db, 'helper', 'function', 'lib.js', 20);
  const unusedFn = insertNode(db, 'unusedFn', 'function', 'lib.js', 30);

  // Function nodes in app.js
  const main = insertNode(db, 'main', 'function', 'app.js', 1);

  // Function nodes in lib.test.js
  const testAdd = insertNode(db, 'testAdd', 'function', 'lib.test.js', 1);

  // Mark exported symbols (add, multiply, unusedFn are exported; helper is not)
  const markExported = db.prepare('UPDATE nodes SET exported = 1 WHERE id = ?');
  markExported.run(add);
  markExported.run(multiply);
  markExported.run(unusedFn);

  // Import edges
  insertEdge(db, fApp, fLib, 'imports');
  insertEdge(db, fTest, fLib, 'imports');

  // Call edges
  insertEdge(db, main, add, 'calls'); // cross-file: app.js → lib.js
  insertEdge(db, main, multiply, 'calls'); // cross-file: app.js → lib.js
  insertEdge(db, add, helper, 'calls'); // same-file: lib.js internal
  insertEdge(db, testAdd, add, 'calls'); // cross-file: test → lib.js

  // Reexport edge: barrel.js re-exports lib.js
  insertEdge(db, fBarrel, fLib, 'reexports');

  db.close();
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────────────────

describe('exportsData', () => {
  test('returns exported symbols with consumers', () => {
    const data = exportsData('lib.js', dbPath);
    expect(data.file).toBe('lib.js');
    expect(data.results.length).toBe(3); // add, multiply, unusedFn

    const addExport = data.results.find((r) => r.name === 'add');
    expect(addExport).toBeDefined();
    expect(addExport.kind).toBe('function');
    expect(addExport.line).toBe(1);
    // main and testAdd both call add from other files
    expect(addExport.consumers.length).toBe(2);
    expect(addExport.consumers.map((c) => c.name).sort()).toEqual(['main', 'testAdd']);

    const mulExport = data.results.find((r) => r.name === 'multiply');
    expect(mulExport).toBeDefined();
    expect(mulExport.consumers.length).toBe(1);
    expect(mulExport.consumers[0].name).toBe('main');

    const unusedExport = data.results.find((r) => r.name === 'unusedFn');
    expect(unusedExport).toBeDefined();
    expect(unusedExport.consumers.length).toBe(0);
    expect(unusedExport.consumerCount).toBe(0);

    // helper is internal (not marked exported)
    const helperExport = data.results.find((r) => r.name === 'helper');
    expect(helperExport).toBeUndefined();
  });

  test('totalExported and totalInternal counts', () => {
    const data = exportsData('lib.js', dbPath);
    expect(data.totalExported).toBe(3); // add, multiply, unusedFn
    expect(data.totalInternal).toBe(1); // helper
  });

  test('reexports detected', () => {
    const data = exportsData('lib.js', dbPath);
    expect(data.reexports.length).toBe(1);
    expect(data.reexports[0].file).toBe('barrel.js');
  });

  test('noTests filters test consumers', () => {
    const data = exportsData('lib.js', dbPath, { noTests: true });
    const addExport = data.results.find((r) => r.name === 'add');
    expect(addExport).toBeDefined();
    // testAdd from lib.test.js should be filtered out
    expect(addExport.consumers.length).toBe(1);
    expect(addExport.consumers[0].name).toBe('main');
    expect(addExport.consumerCount).toBe(1);
  });

  test('empty result for unknown file', () => {
    const data = exportsData('nonexistent.js', dbPath);
    expect(data.results).toEqual([]);
    expect(data.totalExported).toBe(0);
    expect(data.totalInternal).toBe(0);
    expect(data.totalUnused).toBe(0);
  });

  test('pagination works', () => {
    const data = exportsData('lib.js', dbPath, { limit: 1 });
    expect(data.results.length).toBe(1);
    expect(data._pagination).toBeDefined();
    expect(data._pagination.total).toBe(3);
    expect(data._pagination.hasMore).toBe(true);
    expect(data._pagination.returned).toBe(1);
  });

  test('totalUnused is always present', () => {
    const data = exportsData('lib.js', dbPath);
    expect(data.totalUnused).toBe(1); // unusedFn has zero consumers
  });

  test('--unused filters to zero-consumer exports', () => {
    const data = exportsData('lib.js', dbPath, { unused: true });
    expect(data.results.length).toBe(1);
    expect(data.results[0].name).toBe('unusedFn');
    expect(data.results[0].consumerCount).toBe(0);
    // totalExported still reflects all exports
    expect(data.totalExported).toBe(3);
    expect(data.totalUnused).toBe(1);
  });

  test('--unused returns empty when all exports have consumers', () => {
    const data = exportsData('app.js', dbPath, { unused: true });
    expect(data.results).toEqual([]);
  });

  test('--unused with pagination', () => {
    const data = exportsData('lib.js', dbPath, { unused: true, limit: 1 });
    expect(data.results.length).toBe(1);
    expect(data._pagination).toBeDefined();
    expect(data._pagination.total).toBe(1);
    expect(data._pagination.hasMore).toBe(false);
  });

  test('barrel file shows re-exported symbols from target modules', () => {
    const data = exportsData('barrel.js', dbPath);
    expect(data.file).toBe('barrel.js');
    // barrel.js has no own exports
    expect(data.results).toEqual([]);
    expect(data.totalExported).toBe(0);
    // but it surfaces re-exported symbols from lib.js
    expect(data.reexportedSymbols.length).toBe(3); // add, multiply, unusedFn
    const names = data.reexportedSymbols.map((s) => s.name).sort();
    expect(names).toEqual(['add', 'multiply', 'unusedFn']);
    // each re-exported symbol has originFile
    for (const sym of data.reexportedSymbols) {
      expect(sym.originFile).toBe('lib.js');
    }
    // consumer info is preserved
    const addSym = data.reexportedSymbols.find((s) => s.name === 'add');
    expect(addSym.consumerCount).toBe(2);
    // re-export counters reflect barrel symbols
    expect(data.totalReexported).toBe(3);
    expect(data.totalReexportedUnused).toBe(1); // unusedFn
  });

  test('barrel file --unused filters re-exported symbols', () => {
    const data = exportsData('barrel.js', dbPath, { unused: true });
    expect(data.results).toEqual([]);
    expect(data.reexportedSymbols.length).toBe(1);
    expect(data.reexportedSymbols[0].name).toBe('unusedFn');
    expect(data.reexportedSymbols[0].consumerCount).toBe(0);
    // counters still reflect totals (not filtered)
    expect(data.totalReexported).toBe(3);
    expect(data.totalReexportedUnused).toBe(1);
  });

  test('reexportedSymbols is empty array for non-barrel files', () => {
    const data = exportsData('lib.js', dbPath);
    expect(data.reexportedSymbols).toEqual([]);
    expect(data.totalReexported).toBe(0);
    expect(data.totalReexportedUnused).toBe(0);
  });
});

// ─── import type / type-only consumer crediting (#1724) ──────────────────
//
// Regression coverage for: interfaces/types that are only ever consumed via
// `import type { X }` (never called/constructed) were reported as zero-
// consumer dead exports, even though the builder already emits a
// symbol-level `imports-type` edge (source = importing file node, target =
// the specific imported symbol) for exactly this case. `codegraph deps`
// already surfaced the file-level import correctly; `exportsData`'s
// per-symbol consumer query only looked at `kind = 'calls'` and missed it.

describe('exportsData — import type consumer crediting (#1724)', () => {
  let tmpDir2: string, dbPath2: string;

  beforeAll(() => {
    tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-exports-typeonly-'));
    fs.mkdirSync(path.join(tmpDir2, '.codegraph'));
    dbPath2 = path.join(tmpDir2, '.codegraph', 'graph.db');

    const db = new Database(dbPath2);
    db.pragma('journal_mode = WAL');
    initSchema(db);

    // File nodes
    insertNode(db, 'types.ts', 'file', 'types.ts', 0);
    const fConsumer = insertNode(db, 'consumer.ts', 'file', 'consumer.ts', 0);

    // Interface exported from types.ts, referenced elsewhere only via a type
    // annotation (never called/constructed).
    const configIface = insertNode(db, 'Config', 'interface', 'types.ts', 1);
    // Interface exported from types.ts, genuinely never referenced anywhere.
    const unusedIface = insertNode(db, 'Unused', 'interface', 'types.ts', 10);

    const markExported = db.prepare('UPDATE nodes SET exported = 1 WHERE id = ?');
    markExported.run(configIface);
    markExported.run(unusedIface);

    // consumer.ts does `import type { Config } from './types'`. The builder
    // emits the symbol-level edge with the importing *file* as source (see
    // emitTypeOnlySymbolEdges in domain/graph/builder/stages/build-edges.ts
    // and incremental.ts) since the import statement — not a specific
    // function — is what references the type.
    insertEdge(db, fConsumer, configIface, 'imports-type');

    db.close();
  });

  afterAll(() => {
    if (tmpDir2) fs.rmSync(tmpDir2, { recursive: true, force: true });
  });

  test('interface consumed only via `import type` is credited with a consumer', () => {
    const data = exportsData('types.ts', dbPath2);
    const config = data.results.find((r) => r.name === 'Config');
    expect(config).toBeDefined();
    expect(config.consumerCount).toBe(1);
    expect(config.consumers.length).toBe(1);
    expect(config.consumers[0].file).toBe('consumer.ts');
  });

  test('interface consumed only via `import type` is excluded from --unused', () => {
    const data = exportsData('types.ts', dbPath2, { unused: true });
    expect(data.results.find((r) => r.name === 'Config')).toBeUndefined();
  });

  test('interface with no references anywhere is still classified unused', () => {
    const data = exportsData('types.ts', dbPath2, { unused: true });
    const unused = data.results.find((r) => r.name === 'Unused');
    expect(unused).toBeDefined();
    expect(unused.consumerCount).toBe(0);
    expect(unused.consumers).toEqual([]);
  });
});

// ─── reexportedSymbols scoped to actually-named specifiers (#1742) ───────
//
// Regression coverage for: a single named re-export (`export { X } from 'Y'`)
// was treated as if the file transitively re-exported EVERY export of `Y`,
// even symbols never mentioned in any reexport clause (and even symbols only
// imported as a type, never re-exported). The builder now emits a
// symbol-level `reexports` edge straight to the specifically-named symbol
// (mirroring the existing `imports-type` symbol-level edge from #1724) —
// see `emitNamedSymbolEdges` in build-edges.ts / incremental.ts and the
// mirrored Rust extractors. `collectReexportedSymbols` only falls back to a
// target's full export list when no symbol-level edge was recorded for it
// (i.e. a genuine `export * from 'Y'` wildcard, which really does re-export
// everything).

describe('exportsData — reexportedSymbols scoped to named specifiers (#1742)', () => {
  let tmpDir3: string, dbPath3: string;

  beforeAll(() => {
    tmpDir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-exports-reexport-scope-'));
    fs.mkdirSync(path.join(tmpDir3, '.codegraph'));
    dbPath3 = path.join(tmpDir3, '.codegraph', 'graph.db');

    const db = new Database(dbPath3);
    db.pragma('journal_mode = WAL');
    initSchema(db);

    // File nodes
    const fViewer = insertNode(db, 'viewer.ts', 'file', 'viewer.ts', 0);
    const fHelpers = insertNode(db, 'helpers.ts', 'file', 'helpers.ts', 0);
    const fBarrel = insertNode(db, 'enrichment.ts', 'file', 'enrichment.ts', 0);

    // viewer.ts exports four symbols; only two are ever re-exported by
    // enrichment.ts, one of them under a renamed external alias.
    const loadPlotConfig = insertNode(db, 'loadPlotConfig', 'function', 'viewer.ts', 1);
    const buildLayoutOptions = insertNode(db, 'buildLayoutOptions', 'function', 'viewer.ts', 10);
    const escapeHtml = insertNode(db, 'escapeHtml', 'function', 'viewer.ts', 20);
    const plotConfig = insertNode(db, 'PlotConfig', 'interface', 'viewer.ts', 30);

    // helpers.ts is reached only via a wildcard re-export (`export * from`) —
    // no symbol-level edges are ever recorded for it.
    const formatDate = insertNode(db, 'formatDate', 'function', 'helpers.ts', 1);
    const formatNumber = insertNode(db, 'formatNumber', 'function', 'helpers.ts', 10);

    const markExported = db.prepare('UPDATE nodes SET exported = 1 WHERE id = ?');
    for (const id of [
      loadPlotConfig,
      buildLayoutOptions,
      escapeHtml,
      plotConfig,
      formatDate,
      formatNumber,
    ]) {
      markExported.run(id);
    }

    // enrichment.ts:
    //   export { loadPlotConfig } from './viewer';                 (named, no rename)
    //   export { buildLayoutOptions as buildOptions } from './viewer'; (named, renamed)
    //   import type { PlotConfig } from './viewer';                 (type-only, NOT a reexport)
    //   export * from './helpers';                                  (wildcard)
    //
    // File-level `reexports` edges (barrel-relationship proof, one per target):
    insertEdge(db, fBarrel, fViewer, 'reexports');
    insertEdge(db, fBarrel, fHelpers, 'reexports');
    // Symbol-level `reexports` edges (the precise named specifiers). The
    // rename target still points at buildLayoutOptions's own node — `names`
    // always carries the pre-rename declaration name (see
    // `extractImportNames` / `does not apply rename tracking to
    // export_specifier` in tests/parsers/javascript.test.ts).
    insertEdge(db, fBarrel, loadPlotConfig, 'reexports');
    insertEdge(db, fBarrel, buildLayoutOptions, 'reexports');
    // Type-only import — must never contribute to reexportedSymbols.
    insertEdge(db, fBarrel, plotConfig, 'imports-type');

    db.close();
  });

  afterAll(() => {
    if (tmpDir3) fs.rmSync(tmpDir3, { recursive: true, force: true });
  });

  test('only the specifically-named symbols are reported, not every export of the target file', () => {
    const data = exportsData('enrichment.ts', dbPath3);
    const fromViewer = data.reexportedSymbols.filter((s) => s.originFile === 'viewer.ts');
    const names = fromViewer.map((s) => s.name).sort();
    expect(names).toEqual(['buildLayoutOptions', 'loadPlotConfig']);
    // escapeHtml is exported by viewer.ts but never re-exported by
    // enrichment.ts — it must not leak in.
    expect(names).not.toContain('escapeHtml');
  });

  test('a symbol imported as a type (not re-exported) is excluded', () => {
    const data = exportsData('enrichment.ts', dbPath3);
    const names = data.reexportedSymbols.map((s) => s.name);
    expect(names).not.toContain('PlotConfig');
  });

  test('a renamed re-export (`export { X as Y } from ...`) resolves to X, not the external alias', () => {
    const data = exportsData('enrichment.ts', dbPath3);
    const renamed = data.reexportedSymbols.find(
      (s) => s.originFile === 'viewer.ts' && s.name === 'buildLayoutOptions',
    );
    expect(renamed).toBeDefined();
    expect(renamed.kind).toBe('function');
    // The external alias name is never used as the reported name.
    expect(data.reexportedSymbols.some((s) => s.name === 'buildOptions')).toBe(false);
  });

  test('a wildcard re-export (`export * from ...`) still reports every export of its target, distinctly from the named case', () => {
    const data = exportsData('enrichment.ts', dbPath3);
    const fromHelpers = data.reexportedSymbols.filter((s) => s.originFile === 'helpers.ts');
    const names = fromHelpers.map((s) => s.name).sort();
    expect(names).toEqual(['formatDate', 'formatNumber']);
  });

  test('total reexported count reflects only the correctly-scoped symbols', () => {
    const data = exportsData('enrichment.ts', dbPath3);
    // 2 named from viewer.ts (loadPlotConfig, buildLayoutOptions) + 2 wildcard
    // from helpers.ts (formatDate, formatNumber) = 4. Not 6 (which would
    // include the stray escapeHtml/PlotConfig leak from the pre-fix bug).
    expect(data.reexportedSymbols.length).toBe(4);
    expect(data.totalReexported).toBe(4);
  });
});

// ─── Named + wildcard reexport of the SAME target file (#1849 review) ────
//
// Greptile flagged that `collectReexportedSymbols`'s `namedByFile.get(file)
// ?? findExportedNodesByFile(...)` selection is winner-takes-all per target
// file: if a named reexport edge exists for a file, the wildcard fallback
// was unconditionally suppressed — even when a *different* statement in the
// same barrel also does `export * from` that exact target. The builder now
// emits a dedicated `reexports-wildcard` file-level marker edge whenever a
// wildcard statement exists, and the query layer always prefers the full
// export list for any target carrying that marker, regardless of whether
// named symbol-level edges also exist for it.

describe('exportsData — named + wildcard reexport of the same target file (#1849 review)', () => {
  let tmpDir4: string, dbPath4: string;

  beforeAll(() => {
    tmpDir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-exports-reexport-mixed-'));
    fs.mkdirSync(path.join(tmpDir4, '.codegraph'));
    dbPath4 = path.join(tmpDir4, '.codegraph', 'graph.db');

    const db = new Database(dbPath4);
    db.pragma('journal_mode = WAL');
    initSchema(db);

    const fUtils = insertNode(db, 'utils.ts', 'file', 'utils.ts', 0);
    const fBarrel = insertNode(db, 'mixed-barrel.ts', 'file', 'mixed-barrel.ts', 0);

    const foo = insertNode(db, 'foo', 'function', 'utils.ts', 1);
    const bar = insertNode(db, 'bar', 'function', 'utils.ts', 10);

    const markExported = db.prepare('UPDATE nodes SET exported = 1 WHERE id = ?');
    markExported.run(foo);
    markExported.run(bar);

    // mixed-barrel.ts:
    //   export { foo } from './utils';   (named)
    //   export * from './utils';         (wildcard, same target)
    insertEdge(db, fBarrel, fUtils, 'reexports');
    insertEdge(db, fBarrel, foo, 'reexports');
    insertEdge(db, fBarrel, fUtils, 'reexports-wildcard');

    db.close();
  });

  afterAll(() => {
    if (tmpDir4) fs.rmSync(tmpDir4, { recursive: true, force: true });
  });

  test('reports every export of the target, not just the named specifier', () => {
    const data = exportsData('mixed-barrel.ts', dbPath4);
    const names = data.reexportedSymbols.map((s) => s.name).sort();
    // Both foo (named) and bar (only reachable via the wildcard) must be
    // present — the pre-fix bug would report only ['foo'].
    expect(names).toEqual(['bar', 'foo']);
    expect(data.totalReexported).toBe(2);
  });
});
