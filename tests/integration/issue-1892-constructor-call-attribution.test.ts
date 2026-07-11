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
 * A class with no explicit constructor (`Bar`/`Qux`/`Corge`/`Garply`/`Fred`/
 * `Xyzzy` below) must still resolve only to the class node — there is no
 * method to attribute the call to, and the fix must not fabricate one.
 *
 * Covers all three constructor-naming families named in
 * `CONSTRUCTOR_LOCAL_NAME_BY_EXTENSION` (strategy.ts): keyword-fixed
 * (JS/TS `constructor`, Python `__init__`, PHP `__construct`) and
 * class-name-identical (Java, Dart, Groovy — C# is covered by the shared
 * benchmark fixtures, see resolution-benchmark.test.ts).
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

// PHP's constructor keyword (__construct) is a fixed identifier unlike Java's
// "same as class name" convention — a typo in CONSTRUCTOR_LOCAL_NAME_BY_EXTENSION
// or a mismatch between the TS and Rust arms would go undetected without this.
const PHP_FIXTURE = `<?php

class Grault {
  public function __construct() {
  }
}

class Garply {
}

function makeGrault() {
  return new Grault();
}

function makeGarply() {
  return new Garply();
}
`;

// Dart is one of the "same as class name" languages (with Java/C#/Groovy) —
// covers the family beyond Java alone.
// Three deliberate departures from the JS/Python/Java fixtures above, all
// working around pre-existing Dart extractor gaps unrelated to constructor
// attribution — tracked as a follow-up (#2082), not fixed here:
//  1. Uses explicit `new` rather than the keyword-less `Waldo()` construction
//     modern Dart also permits — bare (keyword-less) calls, constructor or
//     plain function, are not extracted as a Call at all currently.
//  2. Wrapper functions use an arrow (`=>`) body rather than a `{ ... }`
//     block spanning multiple lines — a block-bodied function/method's
//     `endLine` is currently truncated to its signature line, which makes
//     any call in its body (on a later line) fall outside the recorded
//     [line, endLine] span and get attributed to the file instead of the
//     enclosing function during graph build.
//  3. Waldo's constructor has an (empty) `{ }` block body rather than the
//     semicolon-only `Waldo();` short form the benchmark fixtures use
//     elsewhere — a bodyless constructor isn't extracted as a definition
//     at all currently, so it would never be found for attribution.
const DART_FIXTURE = `
class Waldo {
  Waldo() {
  }
}

class Fred {
}

Waldo makeWaldo() => new Waldo();

Fred makeFred() => new Fred();
`;

// Groovy is also "same as class name". Constructions wrapped in a method
// (mirroring the Java Wrapper.run() fixture) rather than a bare top-level
// function — Groovy scripts conventionally scope executable statements inside
// a class method (see the resolution-benchmark Main.groovy fixture).
const GROOVY_FIXTURE = `
class Plugh {
  Plugh() {
  }
}

class Xyzzy {
}

class GroovyWrapper {
  void run() {
    def plugh = new Plugh()
    def xyzzy = new Xyzzy()
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
      fs.writeFileSync(path.join(dir, 'repro.php'), PHP_FIXTURE);
      fs.writeFileSync(path.join(dir, 'repro.dart'), DART_FIXTURE);
      fs.writeFileSync(path.join(dir, 'repro.groovy'), GROOVY_FIXTURE);
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

    it('PHP: new Grault() resolves to both Grault (class) and Grault.__construct (method)', () => {
      expect(edges).toContainEqual({
        src: 'makeGrault',
        srcKind: 'function',
        tgt: 'Grault',
        tgtKind: 'class',
      });
      expect(edges).toContainEqual({
        src: 'makeGrault',
        srcKind: 'function',
        tgt: 'Grault.__construct',
        tgtKind: 'method',
      });
    });

    it('PHP: new Garply() resolves only to Garply (class) — no explicit __construct to attribute to', () => {
      expect(edges).toContainEqual({
        src: 'makeGarply',
        srcKind: 'function',
        tgt: 'Garply',
        tgtKind: 'class',
      });
      expect(edges.some((e) => e.src === 'makeGarply' && e.tgt === 'Garply.__construct')).toBe(
        false,
      );
    });

    it('Dart: Waldo() resolves to both Waldo (class) and Waldo.Waldo (constructor method)', () => {
      expect(edges).toContainEqual({
        src: 'makeWaldo',
        srcKind: 'function',
        tgt: 'Waldo',
        tgtKind: 'class',
      });
      expect(edges).toContainEqual({
        src: 'makeWaldo',
        srcKind: 'function',
        tgt: 'Waldo.Waldo',
        tgtKind: 'method',
      });
    });

    it('Dart: Fred() resolves only to Fred (class) — no explicit constructor to attribute to', () => {
      expect(edges).toContainEqual({
        src: 'makeFred',
        srcKind: 'function',
        tgt: 'Fred',
        tgtKind: 'class',
      });
      expect(edges.some((e) => e.src === 'makeFred' && e.tgt === 'Fred.Fred')).toBe(false);
    });

    it('Groovy: new Plugh() resolves to both Plugh (class) and Plugh.Plugh (constructor method)', () => {
      expect(edges).toContainEqual({
        src: 'GroovyWrapper.run',
        srcKind: 'method',
        tgt: 'Plugh',
        tgtKind: 'class',
      });
      expect(edges).toContainEqual({
        src: 'GroovyWrapper.run',
        srcKind: 'method',
        tgt: 'Plugh.Plugh',
        tgtKind: 'method',
      });
    });

    it('Groovy: new Xyzzy() resolves only to Xyzzy (class) — no explicit constructor to attribute to', () => {
      expect(edges).toContainEqual({
        src: 'GroovyWrapper.run',
        srcKind: 'method',
        tgt: 'Xyzzy',
        tgtKind: 'class',
      });
      expect(edges.some((e) => e.src === 'GroovyWrapper.run' && e.tgt === 'Xyzzy.Xyzzy')).toBe(
        false,
      );
    });
  });
}

runScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runScenario('native');
});
