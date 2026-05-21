/**
 * Regression for #1174: incremental rebuild silently drops imports edges
 * when an unrelated file in a barrel chain is touched.
 *
 * Fixture shape (mirrors the dogfooded reproduction):
 *
 *   app.js
 *     └─ imports `runParser` from parser.js
 *
 *   parser.js  (hybrid barrel — 1 reexport + many local defs)
 *     ├─ `export { Token } from './types/index.js'`
 *     └─ imports `extractAlpha/Beta/Gamma/Delta` from extractors/index.js
 *
 *   extractors/index.js  (pure barrel — re-exports only)
 *     └─ re-exports each `extract*` symbol from its leaf file
 *
 *   extractors/{alpha,beta,gamma,delta}.js  (leaf definitions)
 *
 * Before the fix, editing `app.js` triggered re-parse of `parser.js` (it has
 * one re-export so the orchestrator flags it as a barrel candidate), wiped
 * its outgoing edges, and re-emitted them. The barrel-through edges from
 * `parser.js` to each `extractors/<leaf>.js` were silently dropped because
 * `extractors/index.js` was never added to `file_symbols` — Stage 6b's
 * candidate discovery was single-pass.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'issue-1174-chained-barrel');

function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

interface EdgeRow {
  source_file: string;
  source_name: string;
  target_file: string;
  target_name: string;
  kind: string;
}

function readEdges(dbPath: string): EdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.file AS source_file, n1.name AS source_name,
                n2.file AS target_file, n2.name AS target_name, e.kind
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         ORDER BY n1.file, n1.name, n2.file, n2.name, e.kind`,
      )
      .all() as EdgeRow[];
  } finally {
    db.close();
  }
}

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)('Issue #1174 chained-barrel incremental parity (%s)', (engine) => {
  let fullEdges: EdgeRow[];
  let incrEdges: EdgeRow[];
  let tmpBase: string;

  beforeAll(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-1174-${engine}-`));
    const fullDir = path.join(tmpBase, 'full');
    const incrDir = path.join(tmpBase, 'incr');
    copyDirSync(FIXTURE_DIR, fullDir);
    copyDirSync(FIXTURE_DIR, incrDir);

    // Establish baseline on the incremental copy
    await buildGraph(incrDir, { incremental: false, skipRegistry: true, engine });

    // Mutate app.js (the only "changed" file) on both copies
    const mutate = (dir: string) => {
      fs.appendFileSync(path.join(dir, 'app.js'), '\n// touch\n');
    };
    mutate(fullDir);
    mutate(incrDir);

    // Full build on the full copy
    await buildGraph(fullDir, { incremental: false, skipRegistry: true, engine });
    // Incremental rebuild on the incr copy
    await buildGraph(incrDir, { incremental: true, skipRegistry: true, engine });

    fullEdges = readEdges(path.join(fullDir, '.codegraph', 'graph.db'));
    incrEdges = readEdges(path.join(incrDir, '.codegraph', 'graph.db'));
  }, 90_000);

  afterAll(() => {
    if (tmpBase) fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('emits the parser.js → extractors/*.js barrel-through edges on full build', () => {
    const barrelThrough = fullEdges.filter(
      (e) =>
        e.source_file === 'parser.js' &&
        e.target_file.startsWith('extractors/') &&
        e.target_file !== 'extractors/index.js' &&
        e.kind === 'imports',
    );
    // Four leaf extractors: alpha, beta, gamma, delta.
    expect(barrelThrough.map((e) => e.target_file).sort()).toEqual([
      'extractors/alpha.js',
      'extractors/beta.js',
      'extractors/delta.js',
      'extractors/gamma.js',
    ]);
  });

  it('imports edge count matches full rebuild', () => {
    const fullImports = fullEdges.filter((e) => e.kind === 'imports');
    const incrImports = incrEdges.filter((e) => e.kind === 'imports');
    expect(incrImports.length).toBe(fullImports.length);
  });

  it('every barrel-through edge survives the incremental rebuild', () => {
    const key = (e: EdgeRow) => `${e.source_file}|${e.target_file}|${e.kind}`;
    const fullKeys = new Set(fullEdges.filter((e) => e.kind === 'imports').map(key));
    const incrKeys = new Set(incrEdges.filter((e) => e.kind === 'imports').map(key));
    const missing = [...fullKeys].filter((k) => !incrKeys.has(k));
    expect(missing).toEqual([]);
  });
});
