/**
 * Regression test for #1743: `codegraph build` (incremental mode) computed
 * WRONG `cyclomatic` complexity for functions that were NOT edited, when they
 * live in a file where a DIFFERENT function was edited elsewhere (shifting
 * line numbers). `cognitive`, Halstead, `loc`/`sloc` all stayed correct — only
 * `cyclomatic` (and the `maintainabilityIndex` derived from it) came out wrong.
 * A full clean rebuild recomputed the correct values.
 *
 * Root cause: `storeCfgResults` / `storeNativeCfgResults` in
 * `src/ast-analysis/engine.ts` (and a near-identical duplicate in
 * `src/domain/wasm-worker-entry.ts`) OVERWROTE the correctly-computed,
 * AST-derived `complexity.cyclomatic` with a CFG block/edge-count value
 * (`edges - blocks + 2`, McCabe's formula applied to the control-flow graph).
 * That override is wrong because the CFG builder does not model:
 *   - short-circuit logical operators (`&&`, `||`, `??`),
 *   - optional chaining (`?.`),
 *   - or nested function/closure bodies (a CFG stops at a nested function
 *     boundary, while the AST-based cyclomatic walk intentionally folds a
 *     closure's branches into its enclosing function, same as cognitive
 *     complexity does) —
 * all of which the AST-derived cyclomatic (`computeFunctionComplexity` /
 * `compute_all_metrics`, used directly and unconditionally by the native
 * engine) correctly counts. Verified empirically against
 * `src/extractors/javascript.ts`'s real `extractReturnTypeMapWalk` (whose
 * entire body is a single nested `walk` closure): CFG blocks=3/edges=2 →
 * override computed cyclomatic=1, while the correct AST-derived value is 26.
 *
 * This override ran whenever the JS `ast-analysis` pipeline processed a file
 * — unconditionally for `--engine wasm`, and for `--engine native` whenever
 * the Rust orchestrator was bypassed (e.g. `forceFullRebuild` triggered by an
 * engine switch, schema/version/config change — see
 * `checkEngineSchemaMismatch` in `domain/graph/builder/pipeline.ts`), which
 * silently corrupts native-sourced complexity data too since the override
 * doesn't care where `def.complexity`/`def.cfg` came from. This is why the
 * bug was reported as "incremental only": the reporter's baseline "clean
 * rebuild" happened to run through the native orchestrator's own fast path
 * (which never applied this override) while the follow-up rebuild took the
 * JS-pipeline path instead.
 *
 * Fixed by removing the CFG-derived cyclomatic override entirely — cyclomatic
 * complexity is now always the single, correctly-computed AST-derived value,
 * matching the native engine's (always-correct) behavior. CFG blocks/edges
 * are still stored for `codegraph cfg` visualization; they just no longer
 * feed back into `complexity.cyclomatic`.
 *
 * Strategy (mirrors #1738's incremental-vs-full-rebuild ground-truth
 * pattern): build a multi-function fixture deliberately covering all three
 * CFG blind spots (`&&`/`||`, `?.`, and a nested closure) in functions that
 * are never edited, edit an EARLIER, unrelated function to shift every later
 * line number, rebuild incrementally, then diff the untouched functions'
 * complexity against a from-scratch full rebuild of the exact same final
 * file content.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { complexityData } from '../../src/features/complexity.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';
import type { EngineMode } from '../../src/types.js';

const REL_FILE = 'src/lib/calc.js';

/** Functions that are NEVER edited across the whole scenario — the ones the
 *  bug corrupted. Each exercises a distinct CFG blind spot. */
const UNTOUCHED_FUNCTIONS = ['processWithGuards', 'accessOptional', 'walkTreeOuter'] as const;

function baseFixtureSource(): string {
  return `function helperOne(x) {
  return x + 1;
}

function processWithGuards(a, b, c) {
  let result = 0;
  if (a && b) {
    result += 1;
  } else if (a || c) {
    result += 2;
  }
  if (a && b && c) {
    result += 3;
  }
  return result;
}

function accessOptional(obj) {
  if (obj?.a?.b) {
    return obj.a.b.value;
  }
  return obj?.fallback ?? null;
}

function walkTreeOuter(root) {
  function visit(node) {
    if (!node) return;
    if (node.left) {
      visit(node.left);
    } else if (node.right) {
      visit(node.right);
    }
    for (const child of node.children || []) {
      if (child.active) {
        visit(child);
      }
    }
  }
  visit(root);
}

module.exports = { helperOne, processWithGuards, accessOptional, walkTreeOuter };
`;
}

/** The same fixture after `helperOne` (only) has been edited — adds several
 *  lines with no branches of its own, shifting every later function's line
 *  numbers without changing any of their own source text. */
function editedFixtureSource(): string {
  return baseFixtureSource().replace(
    `function helperOne(x) {
  return x + 1;
}`,
    `function helperOne(x) {
  // Several lines added here shift every function below down by a fixed
  // amount, without touching their own source text at all.
  console.log('helperOne called with', x);
  console.log('some more logging');
  console.log('and even more logging, to shift line numbers meaningfully');
  return x + 1;
}`,
  );
}

function writeFixture(root: string, source: string): void {
  fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, REL_FILE), source);
}

interface ComplexitySnapshot {
  cyclomatic: number;
  cognitive: number;
  maintainabilityIndex: number;
}

function snapshotComplexity(dbPath: string): Map<string, ComplexitySnapshot> {
  const data = complexityData(dbPath, { file: REL_FILE, noTests: true, limit: 500 }) as {
    functions: Array<{
      name: string;
      cyclomatic: number;
      cognitive: number;
      maintainabilityIndex: number;
    }>;
  };
  const byName = new Map<string, ComplexitySnapshot>();
  for (const f of data.functions) {
    byName.set(f.name, {
      cyclomatic: f.cyclomatic,
      cognitive: f.cognitive,
      maintainabilityIndex: f.maintainabilityIndex,
    });
  }
  return byName;
}

function runScenario(engine: EngineMode): void {
  describe(`cyclomatic complexity after incremental rebuild (#1743) — ${engine}`, () => {
    let projDir: string;
    const tmpDirs: string[] = [];
    const dbPath = () => path.join(projDir, '.codegraph', 'graph.db');

    function mkTmp(prefix: string): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      tmpDirs.push(dir);
      return dir;
    }

    beforeAll(async () => {
      projDir = mkTmp(`cg-1743-${engine}-`);
      writeFixture(projDir, baseFixtureSource());
      await buildGraph(projDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('baseline full build reports non-trivial cyclomatic for every untouched function', () => {
      const snap = snapshotComplexity(dbPath());
      // Sanity floor: guards against a future regression producing a
      // different-but-still-wrong low value (e.g. 1) that happens to match
      // the reference build by coincidence in the test below.
      expect(snap.get('processWithGuards')?.cyclomatic ?? 0).toBeGreaterThanOrEqual(6);
      expect(snap.get('accessOptional')?.cyclomatic ?? 0).toBeGreaterThanOrEqual(3);
      expect(snap.get('walkTreeOuter')?.cyclomatic ?? 0).toBeGreaterThanOrEqual(5);
    });

    it('untouched functions keep their exact cyclomatic/cognitive/MI after an incremental ' +
      'rebuild that only edits an earlier, unrelated function (matches a from-scratch full rebuild)', async () => {
      const before = snapshotComplexity(dbPath());

      // Edit ONLY helperOne — shifts every later function's line numbers
      // without touching their source text at all.
      writeFixture(projDir, editedFixtureSource());
      await buildGraph(projDir, { engine, skipRegistry: true }); // incremental (default)
      const incremental = snapshotComplexity(dbPath());

      // Ground truth: an independent repo built in one full pass with the
      // identical final file content (post-edit).
      const refDir = mkTmp(`cg-1743-ref-${engine}-`);
      writeFixture(refDir, editedFixtureSource());
      await buildGraph(refDir, { engine, incremental: false, skipRegistry: true });
      const reference = snapshotComplexity(path.join(refDir, '.codegraph', 'graph.db'));

      for (const name of UNTOUCHED_FUNCTIONS) {
        const beforeSnap = before.get(name);
        const incrSnap = incremental.get(name);
        const refSnap = reference.get(name);
        expect(incrSnap, `${name} missing from incremental build`).toBeDefined();
        expect(refSnap, `${name} missing from reference full rebuild`).toBeDefined();
        expect(beforeSnap, `${name} missing from pre-edit baseline`).toBeDefined();

        expect(
          incrSnap!.cyclomatic,
          `${name}: cyclomatic complexity went stale/wrong after an incremental rebuild ` +
            `that only shifted its line number (#1743) — incremental=${incrSnap!.cyclomatic}, ` +
            `full-rebuild ground truth=${refSnap!.cyclomatic}`,
        ).toBe(refSnap!.cyclomatic);
        // The edit never touches these functions' own source, so cyclomatic
        // must also be byte-for-byte identical to the pre-edit baseline.
        expect(incrSnap!.cyclomatic).toBe(beforeSnap!.cyclomatic);
        expect(incrSnap!.cognitive).toBe(refSnap!.cognitive);
        expect(incrSnap!.maintainabilityIndex).toBe(refSnap!.maintainabilityIndex);
      }
    }, 60_000);
  });
}

runScenario('wasm');

describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runScenario('native');

  // Concrete, independently-verified trigger for the native engine: switching
  // `--engine` on an existing graph.db sets `forceFullRebuild` (engine-mismatch
  // guard in `checkEngineSchemaMismatch`), which bypasses the Rust orchestrator
  // and routes the rebuild through the same JS `ast-analysis` pipeline WASM
  // always uses — exercising the exact CFG-override bug even though `--engine
  // native` is requested for the final rebuild.
  it('switching engines on an existing graph.db does not corrupt cyclomatic on the ' +
    'follow-up native rebuild (forceFullRebuild bypasses the Rust orchestrator)', async () => {
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1743-engineswitch-'));
    try {
      writeFixture(projDir, baseFixtureSource());
      await buildGraph(projDir, { engine: 'native', incremental: false, skipRegistry: true });
      const dbPath = path.join(projDir, '.codegraph', 'graph.db');
      const before = snapshotComplexity(dbPath);

      // Switch to wasm (no file changes), then switch back to native.
      await buildGraph(projDir, { engine: 'wasm', skipRegistry: true });
      await buildGraph(projDir, { engine: 'native', skipRegistry: true });
      const after = snapshotComplexity(dbPath);

      for (const name of UNTOUCHED_FUNCTIONS) {
        expect(
          after.get(name)?.cyclomatic,
          `${name}: cyclomatic corrupted after an engine-switch round trip (#1743)`,
        ).toBe(before.get(name)?.cyclomatic);
      }
    } finally {
      fs.rmSync(projDir, { recursive: true, force: true });
    }
  }, 60_000);
});
