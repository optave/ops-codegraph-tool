/**
 * Regression test for #1887: the native orchestrator's fast path
 * (`tryNativeOrchestrator` in `native-orchestrator.ts`) skips
 * `runPipelineStages` entirely on success, so `buildDefinePropertyPostPass`
 * (`stages/build-edges.ts`) — which resolves `this.method()` calls inside
 * getter/setter functions registered via `Object.defineProperty` — never ran
 * for native full builds. The edge was entirely missing, not merely
 * resolved to the wrong kind (contrast with #1766).
 *
 * This only reproduced for the *typed-instance-receiver* case (the accessor
 * target is `new SomeClass()`, so the callee lives behind a qualified
 * `Type.method` lookup). The *object-literal* variant (`const obj = { bar() {} }`)
 * already worked under native via Rust's own independent composite-pts-key
 * mechanism — see `issue-1766-defineproperty-kind-filter-parity.test.ts`.
 *
 * Fixed by `runPostNativeDefinePropertyDispatch`, a new hybrid WASM re-parse
 * post-pass (mirroring the existing `runPostNativeThisDispatch` for
 * this/super dispatch) wired into `runPostNativePasses`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';
import type { EngineMode } from '../../src/types.js';

const FIXTURE_SOURCE = `class Registry {
  bar() {
    return 1;
  }
}

const obj = new Registry();

function getter() {
  this.bar();
}

Object.defineProperty(obj, 'x', { get: getter });
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

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(
  ENGINES,
)('Object.defineProperty typed-instance accessor dispatch (%s, #1887)', (engine) => {
  let tmpDir: string;
  let callEdges: CallEdgeRow[] = [];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-1887-${engine}-`));
    fs.writeFileSync(path.join(tmpDir, 'registry.js'), FIXTURE_SOURCE);
    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine });
    callEdges = readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
  }, 60_000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves getter -> Registry.bar via the Object.defineProperty accessor receiver', () => {
    const edge = callEdges.find((e) => e.src === 'getter' && e.tgt === 'Registry.bar');
    expect(
      edge,
      `Expected getter -> Registry.bar edge.\nActual edges:\n${JSON.stringify(callEdges, null, 2)}`,
    ).toBeDefined();
    expect(edge?.tgtKind).toBe('method');
  });
});

describe.skipIf(!isNativeAvailable())(
  'Object.defineProperty typed-instance accessor dispatch — native engine coverage (#1887)',
  () => {
    it('incremental rebuild picks up a newly-added accessor pattern', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1887-incremental-'));
      try {
        // Initial build with no Object.defineProperty pattern at all.
        fs.writeFileSync(
          path.join(tmpDir, 'registry.js'),
          `class Registry {
  bar() {
    return 1;
  }
}
`,
        );
        await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine: 'native' });

        // Incrementally add the accessor pattern to the same file, then rebuild.
        fs.writeFileSync(path.join(tmpDir, 'registry.js'), FIXTURE_SOURCE);
        await buildGraph(tmpDir, { incremental: true, skipRegistry: true, engine: 'native' });

        const edges = readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
        const edge = edges.find((e) => e.src === 'getter' && e.tgt === 'Registry.bar');
        expect(
          edge,
          `Expected getter -> Registry.bar edge after incremental rebuild.\nActual edges:\n${JSON.stringify(edges, null, 2)}`,
        ).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
