/**
 * Regression for #1813: `import { value, type Foo } from 'mod'` — an inline
 * per-specifier `type` modifier — was not tracked as type-only at all in
 * either engine. Only a whole-statement `import type { Foo } from 'mod'`
 * produced a symbol-level `imports-type` edge (#1724); a mixed statement got
 * no type-only credit for `Foo`, undercounting real consumers reported by
 * `codegraph exports`.
 *
 * Fixture:
 *   types.ts    — defines openRepo/Repository and computeSize/Widget
 *   consumer.ts — a single mixed import statement from types.ts:
 *                   import { computeSize, openRepo, type Repository, type Widget } from './types.js';
 *
 * Repository and Widget should each get a symbol-level `imports-type` edge
 * from consumer.ts; openRepo and computeSize (the plain value specifiers in
 * the same statement) must not. (Modifier-position invariance — leading vs.
 * trailing within a specifier list — is covered separately at the extractor
 * unit-test level in tests/parsers/javascript.test.ts.)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

const FIXTURE_DIR = path.join(
  import.meta.dirname,
  '..',
  'fixtures',
  'issue-1813-inline-type-modifier',
);

interface EdgeRow {
  kind: string;
  target_name: string;
  target_file: string;
}

function readImportEdgesFromConsumer(dbPath: string): EdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT e.kind, n2.name AS target_name, n2.file AS target_file
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE n1.file = 'consumer.ts' AND n1.kind = 'file'
           AND e.kind IN ('imports', 'imports-type')
         ORDER BY e.kind, n2.name`,
      )
      .all() as EdgeRow[];
  } finally {
    db.close();
  }
}

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)('#1813 inline per-specifier type modifier (%s)', (engine) => {
  let tmpDir: string;
  let edges: EdgeRow[];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-1813-${engine}-`));
    fs.cpSync(FIXTURE_DIR, tmpDir, { recursive: true });

    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine });
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    edges = readImportEdgesFromConsumer(dbPath);
  }, 60_000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('credits Repository with a symbol-level imports-type edge', () => {
    const hit = edges.find((e) => e.kind === 'imports-type' && e.target_name === 'Repository');
    expect(hit).toBeDefined();
    expect(hit?.target_file).toBe('types.ts');
  });

  it('credits Widget with a symbol-level imports-type edge', () => {
    const hit = edges.find((e) => e.kind === 'imports-type' && e.target_name === 'Widget');
    expect(hit).toBeDefined();
    expect(hit?.target_file).toBe('types.ts');
  });

  it('does not credit the value specifiers sharing the same mixed statement', () => {
    const wrongCredits = edges.filter(
      (e) =>
        e.kind === 'imports-type' &&
        (e.target_name === 'openRepo' || e.target_name === 'computeSize'),
    );
    expect(wrongCredits).toEqual([]);
  });

  it('keeps the file-level edge for the mixed statement as plain imports, not imports-type', () => {
    const fileLevel = edges.filter((e) => e.target_name === 'types.ts');
    expect(fileLevel.length).toBeGreaterThan(0);
    for (const e of fileLevel) {
      expect(e.kind).toBe('imports');
    }
  });
});
