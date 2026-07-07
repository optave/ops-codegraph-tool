/**
 * Regression for #1833: `codegraph exports`/dead-export analysis never
 * credited a plain (no `type` keyword) import of a TypeScript
 * interface/type-alias as a consumer. Only a whole-statement
 * `import type { X }` (#1724) or an inline per-specifier `import { type X }`
 * (#1813) produced a symbol-level `imports-type` edge — but TypeScript
 * allows importing type-level declarations without the `type` keyword at
 * all, which is extremely common in codebases that don't enforce
 * `import/consistent-type-imports`. Since interfaces/type aliases are erased
 * before runtime, they can never receive a `calls` edge either — so a plain
 * import was the only possible consumption signal, and it was being ignored,
 * making every such interface/type alias look permanently dead.
 *
 * Fixture:
 *   types.ts    — exports interface Config, type alias Mode, and function
 *                 helper (helper is never imported anywhere — a genuinely
 *                 dead export used as a baseline).
 *   consumer.ts — a single plain import statement (no `type` keyword):
 *                   import { Config, Mode } from './types.js';
 *                 using both purely in type position.
 *
 * Config and Mode should each get a symbol-level `imports-type` edge from
 * consumer.ts even though the import statement has no `type` keyword at all.
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
  'issue-1833-plain-type-import',
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

describe.each(ENGINES)('#1833 plain (no `type` keyword) type-only import (%s)', (engine) => {
  let tmpDir: string;
  let dbPath: string;
  let edges: EdgeRow[];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-1833-${engine}-`));
    fs.cpSync(FIXTURE_DIR, tmpDir, { recursive: true });

    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine });
    dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    edges = readImportEdgesFromConsumer(dbPath);
  }, 60_000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('credits Config with a symbol-level imports-type edge despite the plain import', () => {
    const hit = edges.find((e) => e.kind === 'imports-type' && e.target_name === 'Config');
    expect(hit).toBeDefined();
    expect(hit?.target_file).toBe('types.ts');
  });

  it('credits Mode with a symbol-level imports-type edge despite the plain import', () => {
    const hit = edges.find((e) => e.kind === 'imports-type' && e.target_name === 'Mode');
    expect(hit).toBeDefined();
    expect(hit?.target_file).toBe('types.ts');
  });

  it('keeps the file-level edge as plain imports, not imports-type', () => {
    const fileLevel = edges.filter((e) => e.target_name === 'types.ts');
    expect(fileLevel.length).toBeGreaterThan(0);
    for (const e of fileLevel) {
      expect(e.kind).toBe('imports');
    }
  });

  it('reports Config and Mode as consumed via codegraph exports', () => {
    const data = exportsData('types.ts', dbPath, { noTests: true }) as {
      results: Array<{ name: string; consumerCount: number }>;
    };
    const config = data.results.find((r) => r.name === 'Config');
    const mode = data.results.find((r) => r.name === 'Mode');
    expect(config?.consumerCount).toBeGreaterThan(0);
    expect(mode?.consumerCount).toBeGreaterThan(0);
  });

  it('still reports the genuinely unimported helper export as unused', () => {
    const data = exportsData('types.ts', dbPath, { noTests: true }) as {
      results: Array<{ name: string; consumerCount: number }>;
    };
    const helper = data.results.find((r) => r.name === 'helper');
    expect(helper?.consumerCount).toBe(0);
  });
});
