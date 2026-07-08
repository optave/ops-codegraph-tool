/**
 * Regression test for #1892: `new ClassName()` (and bare `ClassName()` for
 * languages with no `new` keyword) resolved only to the class declaration
 * node, never to the class's own constructor **method** — even when the
 * class declares one explicitly. `fn-impact`/`roles --role dead` therefore
 * always reported 0 dependents / role `dead` for every constructor in the
 * codebase, no matter how many call sites actually constructed the class.
 *
 * Root cause: the bare-name call site (`{ name: 'Foo' }`, no receiver) always
 * matched the class node (stored under the bare name `Foo`), never the
 * constructor method (stored under a language-specific qualified name —
 * `Foo.constructor` for JS/TS, `Foo.__init__` for Python, `Foo.Foo` for
 * Java/C#/Dart/Groovy, whose constructor identifier equals the class name).
 *
 * Fix: `resolveCallTargets` (call-resolver.ts) / `resolve_call_targets`
 * (build_edges.rs) now additionally resolve the class's own constructor
 * method and, when found, emit a second `calls` edge to it alongside the
 * pre-existing class-node edge (`attachConstructorTargets` /
 * `attach_constructor_targets`). The class-node edge is intentionally kept —
 * `buildChaContextFromDb`'s RTA fallback (incremental rebuilds) reads
 * instantiation evidence from `calls` edges targeting class-kind nodes.
 *
 * A class with no explicit constructor (`Bar`/`Baz`/`Qux` below) must still
 * resolve only to the class node — there is no method to attribute the call
 * to, and the fix must not fabricate one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';
import type { EngineMode } from '../../src/types.js';

const JS_FIXTURE = `
class Foo {
  constructor() {
    this.value = 1;
  }
}

class Bar {}

const foo = new Foo();
const bar = new Bar();
`;

// Each construction is wrapped in its own top-level function rather than a
// bare module-level assignment: two SCREAMING_CASE module constants without
// individual endLine bounds collide in findEnclosingBinding's widest-span
// tie-break (see #2027, filed separately — unrelated to this fix), which
// would make this fixture assert the wrong caller name.
const PY_FIXTURE = `
class Baz:
    def __init__(self):
        self.value = 1

class Qux:
    pass

def make_baz():
    return Baz()

def make_qux():
    return Qux()
`;

const JAVA_FIXTURE = `
class Quux {
  Quux() {
  }
}

class Corge {
}

class Wrapper {
  void run() {
    Quux quux = new Quux();
    Corge corge = new Corge();
  }
}
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
  describe(`constructor-call attribution (#1892) — ${engine}`, () => {
    let dir: string;
    let edges: CallEdgeRow[];

    beforeAll(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1892-${engine}-`));
      fs.writeFileSync(path.join(dir, 'repro.js'), JS_FIXTURE);
      fs.writeFileSync(path.join(dir, 'repro.py'), PY_FIXTURE);
      fs.writeFileSync(path.join(dir, 'Repro.java'), JAVA_FIXTURE);
      await buildGraph(dir, { engine, incremental: false, skipRegistry: true });
      edges = readCallEdges(path.join(dir, '.codegraph', 'graph.db'));
    }, 30_000);

    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('JS/TS: new Foo() resolves to both Foo (class) and Foo.constructor (method)', () => {
      expect(edges).toContainEqual({
        src: 'foo',
        srcKind: 'constant',
        tgt: 'Foo',
        tgtKind: 'class',
      });
      expect(edges).toContainEqual({
        src: 'foo',
        srcKind: 'constant',
        tgt: 'Foo.constructor',
        tgtKind: 'method',
      });
    });

    it('JS/TS: new Bar() resolves only to Bar (class) — no explicit constructor to attribute to', () => {
      expect(edges).toContainEqual({
        src: 'bar',
        srcKind: 'constant',
        tgt: 'Bar',
        tgtKind: 'class',
      });
      expect(edges.some((e) => e.src === 'bar' && e.tgt === 'Bar.constructor')).toBe(false);
    });

    it('Python: Baz() resolves to both Baz (class) and Baz.__init__ (method)', () => {
      expect(edges).toContainEqual({
        src: 'make_baz',
        srcKind: 'function',
        tgt: 'Baz',
        tgtKind: 'class',
      });
      expect(edges).toContainEqual({
        src: 'make_baz',
        srcKind: 'function',
        tgt: 'Baz.__init__',
        tgtKind: 'method',
      });
    });

    it('Python: Qux() resolves only to Qux (class) — no explicit __init__ to attribute to', () => {
      expect(edges).toContainEqual({
        src: 'make_qux',
        srcKind: 'function',
        tgt: 'Qux',
        tgtKind: 'class',
      });
      expect(edges.some((e) => e.src === 'make_qux' && e.tgt === 'Qux.__init__')).toBe(false);
    });

    it('Java: new Quux() resolves to both Quux (class) and Quux.Quux (constructor method)', () => {
      expect(edges).toContainEqual({
        src: 'Wrapper.run',
        srcKind: 'method',
        tgt: 'Quux',
        tgtKind: 'class',
      });
      expect(edges).toContainEqual({
        src: 'Wrapper.run',
        srcKind: 'method',
        tgt: 'Quux.Quux',
        tgtKind: 'method',
      });
    });

    it('Java: new Corge() resolves only to Corge (class) — no explicit constructor to attribute to', () => {
      expect(edges).toContainEqual({
        src: 'Wrapper.run',
        srcKind: 'method',
        tgt: 'Corge',
        tgtKind: 'class',
      });
      expect(edges.some((e) => e.src === 'Wrapper.run' && e.tgt === 'Corge.Corge')).toBe(false);
    });
  });
}

runScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runScenario('native');
});
