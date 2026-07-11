/**
 * Regression test for #1888: the same-file bare-name lookup in
 * `resolveCallTargets` (`lookup.byNameAndFile(call.name, relPath)`) ran
 * unconditionally for every call and was unfiltered by symbol kind. A call
 * with a receiver — `this.x()`, `obj.x()` — is logically "invoke a member of
 * some instance", so an unrelated same-file class/interface/etc. that merely
 * shared the call's bare name won outright, before any more specific
 * resolution tier (receiver typing, the Object.defineProperty accessor
 * fallback, etc.) ever got a chance to run. The exact same defect existed in
 * the mirrored Rust `resolve_call_targets` / `resolve_exact_global_match` in
 * `build_edges.rs` — confirmed identical on both engines before the fix.
 *
 * Repro (from the issue): `this.bar()` inside a plain function `getter`,
 * registered as a get-accessor for `obj` (an instance of `Registry`, which
 * defines `bar()`) via `Object.defineProperty`, plus an unrelated
 * `class bar {}` declared later in the same file.
 *
 *   class Registry { bar() { return 1; } }
 *   const obj = new Registry();
 *   function getter() { this.bar(); }
 *   Object.defineProperty(obj, 'x', { get: getter });
 *   class bar {}
 *
 * Before the fix: `getter -> bar` (kind: class) — the coincidentally-named
 * class pre-empted the correctly-typed `Registry.bar` method, which was only
 * reachable via a later, more specific fallback tier that never got a
 * chance to run.
 *
 * After the fix: `getter -> Registry.bar` (kind: method), and the unrelated
 * `bar` class no longer receives a `calls` edge at all.
 *
 * The `new Registry()` constructor call (`obj -> Registry`) is also asserted
 * to still resolve — that call has no receiver at all, so it is
 * indistinguishable, at this resolution layer, from a plain bare call; kind
 * must NOT be filtered for it, or constructor-call resolution regresses.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';
import type { EngineMode } from '../../src/types.js';

const FIXTURE = `
class Registry {
  bar() {
    return 1;
  }
}

const obj = new Registry();

function getter() {
  this.bar();
}

Object.defineProperty(obj, 'x', { get: getter });

class bar {}
`;

interface CallEdgeRow {
  src: string;
  srcKind: string;
  tgt: string;
  tgtKind: string;
}

function readCallEdges(dbPath: string): CallEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n1.kind AS srcKind, n2.name AS tgt, n2.kind AS tgtKind
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

function runScenario(engine: EngineMode): void {
  describe(`same-file bare-name lookup kind filter (#1888) — ${engine}`, () => {
    let dir: string;

    beforeAll(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1888-${engine}-`));
      fs.writeFileSync(path.join(dir, 'repro.js'), FIXTURE);
      await buildGraph(dir, { engine, incremental: false, skipRegistry: true });
    }, 30_000);

    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('resolves this.bar() to Registry.bar, not the unrelated class bar', () => {
      const edges = readCallEdges(path.join(dir, '.codegraph', 'graph.db'));

      expect(edges).toContainEqual({
        src: 'getter',
        srcKind: 'function',
        tgt: 'Registry.bar',
        tgtKind: 'method',
      });
      expect(edges.some((e) => e.tgt === 'bar' && e.tgtKind === 'class')).toBe(false);
    });

    it('still resolves the new Registry() constructor call (bare call, no receiver)', () => {
      const edges = readCallEdges(path.join(dir, '.codegraph', 'graph.db'));

      expect(edges).toContainEqual({
        src: 'obj',
        srcKind: 'constant',
        tgt: 'Registry',
        tgtKind: 'class',
      });
    });
  });
}

runScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runScenario('native');
});
