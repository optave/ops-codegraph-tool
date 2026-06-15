/**
 * Regression test for #1550: UNION file-selection arm in runPostNativeThisDispatch
 * must not over-scan class-method files.
 *
 * The third UNION arm selects files containing dot-named method nodes for
 * func-prop this-dispatch (`f.h = function(){ this.g() }`).  Before the fix it
 * matched ALL dot-qualified method names including class methods like
 * `Foo.bar`, pulling every class-method file into the WASM re-parse set on
 * full builds.
 *
 * The fix adds:
 *   AND SUBSTR(n.name, 1, INSTR(n.name, '.') - 1) NOT IN (
 *     SELECT name FROM nodes WHERE kind IN ('class','struct','interface','type')
 *     AND name IS NOT NULL
 *   )
 *
 * This test verifies two things:
 *  1. Func-prop this-dispatch still resolves correctly (regression guard).
 *  2. Class-method files that have NO extends edges do not receive spurious
 *     this-dispatch edges via the UNION over-scan.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

/**
 * Two-file fixture:
 *
 * func-prop.js — contains a func-prop object: `obj.helper` and `obj.run` where
 *   `obj.run` calls `this.helper()`.  The UNION arm must pick up this file so
 *   the this-dispatch edge `obj.run → obj.helper` is emitted.
 *
 * class-only.js — contains a standalone class Foo with methods Foo.bar and
 *   Foo.baz.  Foo.bar calls `this.baz()`.  There are NO extends edges for Foo.
 *   Before the fix the UNION arm would include this file in the re-parse set,
 *   which is harmless for CHA-resolved classes but wastes re-parse budget.
 *   More importantly, the re-parse must not emit a false cross-file this-dispatch
 *   edge like `Foo.bar → obj.helper` (different owner prefix).
 */
const FIXTURE: Record<string, string> = {
  'func-prop.js': `
function obj() {}
obj.helper = function() { return 42; }
obj.run = function() {
  this.helper();
}
`,
  'class-only.js': `
class Foo {
  bar() {
    this.baz();
  }
  baz() {
    return 1;
  }
}
`,
};

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)('UNION file-selection narrowing (#1550, %s)', (engine) => {
  let tmpDir: string;
  let callEdges: Array<{ src: string; tgt: string }>;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1550-${engine}-`));
    for (const [rel, content] of Object.entries(FIXTURE)) {
      fs.writeFileSync(path.join(tmpDir, rel), content);
    }
    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine });

    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const db = new Database(dbPath, { readonly: true });
    try {
      callEdges = db
        .prepare(
          `SELECT n1.name AS src, n2.name AS tgt
           FROM edges e
           JOIN nodes n1 ON e.source_id = n1.id
           JOIN nodes n2 ON e.target_id = n2.id
           WHERE e.kind = 'calls'
           ORDER BY n1.name, n2.name`,
        )
        .all() as Array<{ src: string; tgt: string }>;
    } finally {
      db.close();
    }
  }, 60_000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- func-prop resolution must still work ---

  it('emits obj.run → obj.helper (func-prop this-dispatch)', () => {
    const edge = callEdges.find((e) => e.src === 'obj.run' && e.tgt === 'obj.helper');
    expect(
      edge,
      `Expected obj.run → obj.helper edge.\nAll edges: ${JSON.stringify(callEdges, null, 2)}`,
    ).toBeDefined();
  });

  // --- class-method file must not emit cross-owner false edges ---

  it('does NOT emit Foo.bar → obj.helper (cross-owner false edge from over-scan)', () => {
    const edge = callEdges.find((e) => e.src === 'Foo.bar' && e.tgt === 'obj.helper');
    expect(
      edge,
      `Expected NO Foo.bar → obj.helper edge (class-method file should not be in re-parse set).\nAll edges: ${JSON.stringify(callEdges, null, 2)}`,
    ).toBeUndefined();
  });

  it('does NOT emit Foo.bar → obj.run (cross-owner false edge from over-scan)', () => {
    const edge = callEdges.find((e) => e.src === 'Foo.bar' && e.tgt === 'obj.run');
    expect(
      edge,
      `Expected NO Foo.bar → obj.run edge (class-method file should not be in re-parse set).\nAll edges: ${JSON.stringify(callEdges, null, 2)}`,
    ).toBeUndefined();
  });
});
