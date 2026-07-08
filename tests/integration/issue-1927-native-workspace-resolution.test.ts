/**
 * Regression test for #1927: the native engine's `resolve_import_path_inner`
 * had no workspace-awareness at all, so a bare monorepo workspace-package
 * specifier (e.g. `import "@myorg/lib"`) fell straight through to the raw-
 * specifier fallback under the native engine — unlike the WASM/JS engine's
 * `resolveViaWorkspace()`, which resolves it to the package's real entry file.
 *
 * Fixture: a two-package monorepo —
 *   packages/lib/package.json  { name: "@myorg/lib", main: "./src/index.js" }
 *   packages/lib/src/index.js  exports `add`/`multiply`
 *   apps/web/index.js          `import { add, multiply } from "@myorg/lib"`
 *                              and calls both from `calculate()`
 *
 * Verifies, for both engines:
 *  1. The `imports` edge from apps/web/index.js resolves to the workspace
 *     package's real entry file, not the raw `@myorg/lib` specifier.
 *  2. `calculate` gets `calls` edges to both `add` and `multiply`.
 *  3. Those `calls` edges carry the 0.95 workspace-resolved confidence floor
 *     (mirrors `computeConfidenceJS`'s `_workspaceResolvedPaths` check).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'issue-1927-fixture',
    private: true,
    workspaces: ['packages/*', 'apps/*'],
  }),
  'packages/lib/package.json': JSON.stringify({
    name: '@myorg/lib',
    version: '1.0.0',
    main: './src/index.js',
  }),
  'packages/lib/src/index.js': `
export function add(a, b) {
  return a + b;
}

export function multiply(a, b) {
  return a * b;
}
`,
  'apps/web/package.json': JSON.stringify({
    name: '@myorg/web',
    version: '1.0.0',
    main: './index.js',
  }),
  'apps/web/index.js': `
import { add, multiply } from '@myorg/lib';

export function calculate(a, b) {
  return add(a, b) + multiply(a, b);
}
`,
};

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)('monorepo workspace import resolution (#1927, %s)', (engine) => {
  let tmpDir: string;
  let importEdges: Array<{ src_file: string; tgt_file: string }>;
  let callEdges: Array<{ src: string; tgt: string; tgt_file: string; confidence: number }>;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1927-${engine}-`));
    for (const [rel, content] of Object.entries(FIXTURE)) {
      const full = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine });

    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const db = new Database(dbPath, { readonly: true });
    try {
      importEdges = db
        .prepare(
          `SELECT n1.file AS src_file, n2.file AS tgt_file
           FROM edges e
           JOIN nodes n1 ON e.source_id = n1.id
           JOIN nodes n2 ON e.target_id = n2.id
           WHERE e.kind = 'imports' AND n1.file = 'apps/web/index.js'`,
        )
        .all() as Array<{ src_file: string; tgt_file: string }>;
      callEdges = db
        .prepare(
          `SELECT n1.name AS src, n2.name AS tgt, n2.file AS tgt_file, e.confidence AS confidence
           FROM edges e
           JOIN nodes n1 ON e.source_id = n1.id
           JOIN nodes n2 ON e.target_id = n2.id
           WHERE e.kind = 'calls' AND n1.name = 'calculate'
           ORDER BY n2.name`,
        )
        .all() as Array<{ src: string; tgt: string; tgt_file: string; confidence: number }>;
    } finally {
      db.close();
    }
  }, 60_000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves the workspace-package import to the package entry file', () => {
    expect(
      importEdges,
      `Expected an imports edge from apps/web/index.js resolved into packages/lib.\nEdges: ${JSON.stringify(importEdges, null, 2)}`,
    ).toContainEqual(
      expect.objectContaining({
        src_file: 'apps/web/index.js',
        tgt_file: 'packages/lib/src/index.js',
      }),
    );
  });

  it('emits calls edges from calculate to both workspace-imported functions', () => {
    const targets = callEdges.map((e) => e.tgt);
    expect(targets, `All calls edges: ${JSON.stringify(callEdges, null, 2)}`).toEqual([
      'add',
      'multiply',
    ]);
    for (const edge of callEdges) {
      expect(edge.tgt_file, `Edge to ${edge.tgt} should resolve into packages/lib`).toBe(
        'packages/lib/src/index.js',
      );
    }
  });

  it('grants the workspace-resolved confidence floor (0.95) to cross-package calls', () => {
    for (const edge of callEdges) {
      expect(
        edge.confidence,
        `calculate -> ${edge.tgt} confidence should be >= 0.95 (workspace-resolved)`,
      ).toBeGreaterThanOrEqual(0.95);
    }
  });
});
