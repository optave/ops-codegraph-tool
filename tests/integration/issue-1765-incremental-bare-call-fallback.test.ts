/**
 * Regression test for #1765: incremental rebuild was missing the same-class
 * bare-call fallback that the full-build pipeline has
 * (`resolveSameClassBareCallFallback` in `stages/build-edges.ts`).
 *
 * For class-scoped languages (e.g. C#), a bare call with no receiver that
 * fails global resolution should retry qualified as `<CallerClass>.<callName>`
 * — this is how C# static sibling calls like `IsValidEmail()` inside
 * `Validators.ValidateUser` resolve to `Validators.IsValidEmail`.
 *
 * `incremental.ts`'s call-resolution path (`applyCallResolutionFallbacks`)
 * now shares the same fallback helpers as the full build
 * (`resolveSameClassThisFallback` / `resolveSameClassBareCallFallback` in
 * `call-resolver.ts`), so a single-file incremental rebuild (watch mode)
 * must produce the exact same call edges as a full `codegraph build`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'bare-call-scope');

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
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
      )
      .all() as CallEdgeRow[];
  } finally {
    db.close();
  }
}

describe('incremental same-class bare-call fallback parity (#1765)', () => {
  let tmpDir: string;
  let fullEdges: CallEdgeRow[];
  let incrEdges: CallEdgeRow[];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bare-call-parity-'));
    const fullDir = path.join(tmpDir, 'full');
    const incrDir = path.join(tmpDir, 'incr');

    fs.cpSync(FIXTURE_DIR, fullDir, { recursive: true });
    fs.cpSync(FIXTURE_DIR, incrDir, { recursive: true });

    // Initial full build on the incr copy (establishes baseline hashes)
    await buildGraph(incrDir, { incremental: false, skipRegistry: true, engine: 'wasm' });

    // Comment-only touch — triggers incremental rebuild of Validators.cs
    const touch = (dir: string) =>
      fs.appendFileSync(path.join(dir, 'Validators.cs'), '\n// touch\n');
    touch(fullDir);
    touch(incrDir);

    // Full build from scratch
    await buildGraph(fullDir, { incremental: false, skipRegistry: true, engine: 'wasm' });
    // Incremental rebuild — exercises applyCallResolutionFallbacks's bare-call strategy
    await buildGraph(incrDir, { incremental: true, skipRegistry: true, engine: 'wasm' });

    fullEdges = readCallEdges(path.join(fullDir, '.codegraph', 'graph.db'));
    incrEdges = readCallEdges(path.join(incrDir, '.codegraph', 'graph.db'));
  }, 60_000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('incremental emits Validators.ValidateUser → Validators.IsValidEmail (bare-call same-class fallback)', () => {
    const edge = incrEdges.find(
      (e) =>
        e.caller_name === 'Validators.ValidateUser' && e.callee_name === 'Validators.IsValidEmail',
    );
    expect(
      edge,
      `Expected Validators.ValidateUser -> Validators.IsValidEmail in incremental build.\nActual edges:\n${JSON.stringify(incrEdges, null, 2)}`,
    ).toBeDefined();
  });

  it('incremental does NOT emit Validators.ValidateUser → Formatters.IsValidEmail (cross-class false-positive)', () => {
    const edge = incrEdges.find(
      (e) =>
        e.caller_name === 'Validators.ValidateUser' && e.callee_name === 'Formatters.IsValidEmail',
    );
    expect(
      edge,
      `Expected NO Validators.ValidateUser -> Formatters.IsValidEmail edge.\nActual edges:\n${JSON.stringify(incrEdges, null, 2)}`,
    ).toBeUndefined();
  });

  it('incremental edges match full build edges exactly', () => {
    const fullSet = new Set(fullEdges.map((e) => `${e.caller_name}→${e.callee_name}`));
    const incrSet = new Set(incrEdges.map((e) => `${e.caller_name}→${e.callee_name}`));
    const missing = [...fullSet].filter((k) => !incrSet.has(k));
    const extra = [...incrSet].filter((k) => !fullSet.has(k));
    expect(missing, `Missing in incremental: ${missing.join(', ')}`).toEqual([]);
    expect(extra, `Extra in incremental: ${extra.join(', ')}`).toEqual([]);
  });
});
