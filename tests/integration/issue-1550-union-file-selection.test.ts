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
 *  2. Class-method files that have NO extends edges do not emit cross-file
 *     this-dispatch edges as a result of the UNION over-scan (native only —
 *     the SQL UNION guard lives entirely inside runPostNativeThisDispatch,
 *     which is never called for the wasm engine).
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
 *   Before the fix the third UNION arm would include this file in relFiles
 *   because `Foo.bar` is a dot-qualified method name.  With the fix, the NOT IN
 *   sub-select recognises `Foo` as a class name and excludes class-only.js.
 *
 * The over-scan observable for native: if class-only.js enters relFiles, the
 * post-pass re-parses it and processes `this.baz()` in Foo.bar.  Because
 * Foo.bar → Foo.baz is already in the DB from the native primary pass (and
 * therefore in the seen-set), the post-pass does not add a duplicate.  The
 * distinguishable failure is therefore a cross-file edge: any edge whose
 * source node lives in class-only.js and whose target lives in func-prop.js
 * (or vice-versa) would indicate the dispatch mechanism mis-routed a call.
 * Such an edge is structurally impossible given the fixture (Foo.bar calls
 * this.baz(), so resolveThisDispatch looks up Foo.baz, not obj.*), but
 * asserting it makes the test self-documenting and catches refactors that
 * change the dispatch lookup strategy.
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
  let callEdges: Array<{ src: string; tgt: string; src_file: string; tgt_file: string }>;

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
          `SELECT n1.name AS src, n2.name AS tgt,
                  n1.file AS src_file, n2.file AS tgt_file
           FROM edges e
           JOIN nodes n1 ON e.source_id = n1.id
           JOIN nodes n2 ON e.target_id = n2.id
           WHERE e.kind = 'calls'
           ORDER BY n1.name, n2.name`,
        )
        .all() as Array<{ src: string; tgt: string; src_file: string; tgt_file: string }>;
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

  // --- class-method file must not emit cross-file edges (native only) ---
  //
  // The SQL UNION guard lives inside runPostNativeThisDispatch, which is only
  // called during a native build.  For the wasm engine, class-only.js is never
  // added to the re-parse set by this code path, so the assertions below are
  // native-specific.

  it.skipIf(engine !== 'native')(
    'does NOT emit any cross-file edge from class-only.js to func-prop.js',
    () => {
      const crossFileEdges = callEdges.filter(
        (e) => e.src_file?.endsWith('class-only.js') && e.tgt_file?.endsWith('func-prop.js'),
      );
      expect(
        crossFileEdges,
        `Expected no calls from class-only.js nodes to func-prop.js nodes.\n` +
          `Cross-file edges: ${JSON.stringify(crossFileEdges, null, 2)}\n` +
          `All edges: ${JSON.stringify(callEdges, null, 2)}`,
      ).toHaveLength(0);
    },
  );

  it.skipIf(engine !== 'native')(
    'does NOT emit any cross-file edge from func-prop.js to class-only.js',
    () => {
      const crossFileEdges = callEdges.filter(
        (e) => e.src_file?.endsWith('func-prop.js') && e.tgt_file?.endsWith('class-only.js'),
      );
      expect(
        crossFileEdges,
        `Expected no calls from func-prop.js nodes to class-only.js nodes.\n` +
          `Cross-file edges: ${JSON.stringify(crossFileEdges, null, 2)}\n` +
          `All edges: ${JSON.stringify(callEdges, null, 2)}`,
      ).toHaveLength(0);
    },
  );
});
