/**
 * Engine-parity tests for `.call/.apply/.bind` reflection tagging and the
 * narrow dedup-collision fix (#1778).
 *
 * BACKGROUND
 * ──────────
 * PR #1693 (closing #1687) made the WASM/TS extractor unconditionally drop
 * `dynamic`/`dynamicKind` for `.call()/.apply()/.bind()` on identifier
 * receivers (e.g. `f.call({})`), to fix a narrow dedup-collision bug: a
 * direct `f()` call followed by `f.call({})` to the SAME target in the SAME
 * scope was wrongly promoting the already-recorded dyn=0 edge to dyn=1 via
 * the `dynZeroEdgeRows` upgrade path in `emitDirectCallEdgesForCall`
 * (build-edges.ts). That fix overcorrected: it silenced the `reflection`
 * DynamicKind for EVERY identifier-based `.call/.apply/.bind`, not just the
 * narrow dedup-collision case — diverging from the native Rust engine, which
 * never changed and still tags these calls `dynamic=true,
 * dynamicKind='reflection'` unconditionally (see ADR-002).
 *
 * FIX (#1778, Option A)
 * ──────────────────────
 * 1. The WASM/TS extractor (`extractMemberExprCallInfo`) once again tags
 *    `.call/.apply/.bind` on identifier receivers as dynamic/reflection,
 *    matching native and preserving the informational value of the
 *    `reflection` DynamicKind (queryable via `codegraph roles --dynamic`).
 * 2. The dedup-collision from #1687 is fixed narrowly, at the edge-emission
 *    layer: `emitDirectCallEdgesForCall`'s dyn=0 → dyn=1 upgrade now compares
 *    SOURCE LINES. It only upgrades when the incoming dynamicKind-tagged call
 *    textually PRECEDES the already-recorded dyn=0 call — which only happens
 *    when the query path's two-phase call collection (query matches, then a
 *    supplementary walk pass for constructs like bare decorators, #1683)
 *    reorders a genuinely-earlier call to arrive later. A `.call/.apply/.bind`
 *    call is an ordinary call_expression collected in the SAME phase as any
 *    prior direct call, so true source order is already preserved — when it
 *    arrives LATER than a recorded dyn=0 edge, it is a genuine second
 *    reference to the same target and must NOT flip the edge, matching
 *    native's plain first-recorded-wins dedup (no upgrade logic at all).
 *
 * These tests build a real graph with each engine and assert on the
 * PERSISTED edge — the only thing that must match across engines.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const ENGINES = ['wasm', 'native'] as const;

interface CallEdgeRow {
  source: string;
  target: string;
  confidence: number;
  dynamic: number;
}

function writeFixture(baseDir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const fullPath = path.join(baseDir, rel);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

function readCallEdgesTo(dbPath: string, targetName: string): CallEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS source, n2.name AS target, e.confidence, e.dynamic
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls' AND n2.name = ?
         ORDER BY n1.name`,
      )
      .all(targetName) as CallEdgeRow[];
  } finally {
    db.close();
  }
}

let tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore cleanup races */
    }
  }
  tmpDirs = [];
});

async function buildAndReadEdgesTo(
  files: Record<string, string>,
  engine: 'wasm' | 'native',
  targetName: string,
): Promise<CallEdgeRow[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1778-${engine}-`));
  tmpDirs.push(tmpDir);
  writeFixture(tmpDir, files);
  await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });
  return readCallEdgesTo(path.join(tmpDir, '.codegraph', 'graph.db'), targetName);
}

describe('#1778: .call/.apply/.bind reflection tagging — engine parity', () => {
  it.each(
    ENGINES,
  )('%s: greet.call(ctx) with NO prior direct call resolves dyn=1 (minimal repro, no dedup collision)', async (engine) => {
    // Exactly the issue's own minimal repro: no direct call to `greet` exists
    // anywhere, so the dedup-collision path in emitDirectCallEdgesForCall never
    // fires — this is the plain, uncomplicated case the #1693 fix wrongly broke.
    const edges = await buildAndReadEdgesTo(
      {
        'index.js': [
          'export function greet(name) { return name; }',
          "export function runCall(ctx) { return greet.call(ctx, 'world'); }",
          '',
        ].join('\n'),
      },
      engine,
      'greet',
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'runCall', target: 'greet', confidence: 1 });
    expect(edges[0].dynamic).toBe(1);
  });

  it.each(
    ENGINES,
  )('%s: direct f() followed by f.call({}) to the same target dedups to a single dyn=0 edge (#1687)', async (engine) => {
    // The original #1687 scenario: a direct call and a reflection-style call to
    // the SAME target from the SAME caller/scope. Must collapse to ONE edge
    // (no double-edge emission) and that edge must be dyn=0, matching native's
    // plain first-recorded-wins dedup (the direct call is recorded first, in
    // true source order, and the later reflection call must not flip it).
    const edges = await buildAndReadEdgesTo(
      { 'index.js': ['function f() {}', 'f();', 'f.call({});', ''].join('\n') },
      engine,
      'f',
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].dynamic).toBe(0);
  });

  it.each(
    ENGINES,
  )('%s: f.call({}) followed by direct f() to the same target dedups to a single dyn=1 edge (reverse-order sanity)', async (engine) => {
    // Mirror of the #1687 fixture with the two call sites swapped: the
    // reflection call is now genuinely first in source order, so it should win
    // the dedup and the later direct call must not downgrade it.
    const edges = await buildAndReadEdgesTo(
      { 'index.js': ['function f() {}', 'f.call({});', 'f();', ''].join('\n') },
      engine,
      'f',
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].dynamic).toBe(1);
  });

  it.each(
    ENGINES,
  )('%s: bare decorator before call-expression decorator still upgrades to dyn=1 (#1683 regression guard)', async (engine) => {
    // Regression guard for the ORIGINAL motivating case of the dynZeroEdgeRows
    // upgrade path: the WASM query path collects `@Log()` (dyn=0) before the
    // bare `@Log` (dyn=1) despite `@Log` appearing earlier in the source — the
    // line-order comparison introduced by #1778's fix must still upgrade this
    // to dyn=1, exactly as the pre-#1778 unconditional-upgrade logic did.
    const edges = await buildAndReadEdgesTo(
      {
        'index.ts': [
          'export function Log(target: unknown): void {}',
          '',
          '@Log',
          'export class UserController {}',
          '',
          '@Log()',
          'export class OrderController {}',
          '',
        ].join('\n'),
      },
      engine,
      'Log',
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].dynamic).toBe(1);
  });
});
