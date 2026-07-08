/**
 * Integration test for #1773: destructured object-pattern binding targets
 * (renamed and non-renamed) were classified with `kind: "function"` instead
 * of `kind: "constant"`, regardless of what the destructured value actually
 * held. Because these bindings had no call-graph edges pointing at them by
 * name, `codegraph roles --role dead` risked flagging them `dead-unresolved`
 * (the "genuinely dead callable" bucket) even when read repeatedly elsewhere.
 *
 * Root cause: `extractDestructuredBindings` (src/extractors/javascript.ts,
 * shared by both the walk and query extraction paths) and its native mirror
 * `extract_destructured_bindings` (crates/codegraph-core/src/extractors/
 * javascript.rs) hardcoded `kind: 'function'` for every object-pattern
 * binding target, on the theory that destructured names are usually
 * callbacks. That miscategorized any destructured value that wasn't a
 * function (e.g. `const { dbPath } = workerData`).
 *
 * Fix: both engines now emit `kind: 'constant'`, matching the existing
 * convention for plain `const x = <literal>` bindings and array-pattern
 * destructuring. Constants remain fully resolvable as call targets (call-
 * target resolution is kind-agnostic), so callback-style destructured
 * bindings still resolve; and constants with active call-graph-connected
 * siblings in the same file are classified `leaf`, not `dead-unresolved` —
 * exactly like any other same-file constant.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

// Repro 1 (renamed destructuring, issue #1773): a file with other real,
// call-graph-connected functions (giving it "active file siblings") plus a
// renamed destructured binding read repeatedly afterward — mirrors
// scripts/token-benchmark.ts's `const { values: flags } = parseArgs(...)`.
// Repro 2 (non-renamed destructuring, issue #1773): an isolated worker-style
// file with *only* a destructured binding from a non-call RHS and no other
// callables — mirrors tests/unit/snapshot-race-worker.mjs's
// `const { dbPath, name, force } = workerData`.
const FIXTURE = {
  'renamed-repro.js': `
function parseArgs(opts) { return { values: computeDefaults(opts) }; }
function computeDefaults(opts) { return { runs: 3, model: opts.model }; }

const { values: flags } = parseArgs({ model: 'x' });

function main() {
  console.log(flags.runs, flags.model);
}
main();
`,
  'worker-repro.mjs': `
const { dbPath, name, force } = workerData;
save(name, { dbPath, force });
`,
};

function readNode(dbPath: string, file: string, name: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare('SELECT name, kind, role FROM nodes WHERE file = ? AND name = ?')
      .get(file, name) as { name: string; kind: string; role: string | null } | undefined;
  } finally {
    db.close();
  }
}

function expectFixedKindAndRole(dbPath: string) {
  // Repro 1: renamed destructured binding, active file siblings present.
  const flags = readNode(dbPath, 'renamed-repro.js', 'flags');
  expect(flags, 'flags node not found').toBeDefined();
  expect(flags!.kind, 'flags must be kind constant, not function').toBe('constant');
  expect(
    flags!.role,
    `flags was classified as ${flags!.role} — must not be dead-unresolved`,
  ).not.toBe('dead-unresolved');

  // Repro 2: non-renamed destructured bindings, no active file siblings.
  for (const varName of ['dbPath', 'name', 'force']) {
    const node = readNode(dbPath, 'worker-repro.mjs', varName);
    expect(node, `${varName} node not found`).toBeDefined();
    expect(node!.kind, `${varName} must be kind constant, not function`).toBe('constant');
    // With no other call-graph-connected callable in the file, these fall
    // back to 'dead-leaf' — the same honest classification any isolated,
    // unreferenced-by-calls constant gets (properties/constants are leaf
    // nodes by definition; call-graph reachability can't prove liveness for
    // pure value bindings). The bug this test guards against is the far more
    // misleading 'dead-unresolved' ("genuinely dead callable") label that a
    // wrong kind: 'function' classification used to produce.
    expect(
      node!.role,
      `${varName} was classified as ${node!.role} — must not be dead-unresolved`,
    ).not.toBe('dead-unresolved');
  }
}

describe('destructured binding kind classification (#1773) — WASM', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1773-'));
    for (const [rel, content] of Object.entries(FIXTURE)) {
      fs.writeFileSync(path.join(tmpDir, rel), content);
    }
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('classifies renamed and non-renamed destructured bindings as kind constant, not dead-unresolved', () => {
    expectFixedKindAndRole(path.join(tmpDir, '.codegraph', 'graph.db'));
  });

  it('still resolves calls made through a destructured callback-style binding', () => {
    // `flags.runs`/`flags.model` are property reads, not calls, but `flags`
    // itself must still show up as the attributed caller of `parseArgs` — the
    // fix must not break caller attribution for the top-level binding.
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS cnt
           FROM edges e
           JOIN nodes s ON e.source_id = s.id
           JOIN nodes t ON e.target_id = t.id
           WHERE s.name = 'flags' AND t.name = 'parseArgs' AND e.kind = 'calls'`,
        )
        .get() as { cnt: number };
      expect(row.cnt, 'expected flags -> parseArgs calls edge to survive the kind fix').toBe(1);
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!isNativeAvailable())(
  'destructured binding kind classification (#1773) — native',
  () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1773-native-'));
      for (const [rel, content] of Object.entries(FIXTURE)) {
        fs.writeFileSync(path.join(tmpDir, rel), content);
      }
      await buildGraph(tmpDir, { engine: 'native', incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('classifies renamed and non-renamed destructured bindings as kind constant, not dead-unresolved', () => {
      expectFixedKindAndRole(path.join(tmpDir, '.codegraph', 'graph.db'));
    });

    it('still resolves calls made through a destructured callback-style binding', () => {
      // `flags.runs`/`flags.model` are property reads, not calls, but `flags`
      // itself must still show up as the attributed caller of `parseArgs` — the
      // fix must not break caller attribution for the top-level binding.
      const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS cnt
             FROM edges e
             JOIN nodes s ON e.source_id = s.id
             JOIN nodes t ON e.target_id = t.id
             WHERE s.name = 'flags' AND t.name = 'parseArgs' AND e.kind = 'calls'`,
          )
          .get() as { cnt: number };
        expect(row.cnt, 'expected flags -> parseArgs calls edge to survive the kind fix').toBe(1);
      } finally {
        db.close();
      }
    });
  },
);
