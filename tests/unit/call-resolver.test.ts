/**
 * Unit tests for resolveByMethodOrGlobal in call-resolver.ts.
 *
 * Covers the qualified callerName fix (#1385): when callerName has more than
 * one dot segment (e.g. 'Namespace.ClassName.method'), the same-class dispatch
 * must use only the segment immediately before the method name ('ClassName'),
 * not the full qualified prefix ('Namespace.ClassName').
 *
 * Also covers the static receiver confidence filter (#1398): the direct qualified
 * method fallback must apply computeConfidence >= 0.5 to avoid false edges from
 * distant files in a polyglot project.
 *
 * Also covers the bare-call JS/TS module-scope guard (#1422/#1424): bare `foo()` calls
 * (no receiver) inside a JS/TS class method must NOT fall through to the same-class
 * lookup, because bare calls in those languages are module-scoped, not class-scoped.
 */
import { describe, expect, it } from 'vitest';
import type { CallNodeLookup } from '../../src/domain/graph/builder/call-resolver.js';
import {
  resolveByMethodOrGlobal,
  resolveCallTargets,
  resolveDefinePropertyAccessorTarget,
  resolveReceiverEdge,
} from '../../src/domain/graph/builder/call-resolver.js';

function makeLookup(
  methodMap: Record<string, Array<{ id: number; file: string; kind: string }>>,
): CallNodeLookup {
  return {
    byName(name) {
      return methodMap[name] ?? [];
    },
    byNameAndFile() {
      return [];
    },
    isBarrel() {
      return false;
    },
    resolveBarrel() {
      return null;
    },
    nodeId() {
      return undefined;
    },
  };
}

describe('resolveByMethodOrGlobal — same-class this-dispatch with qualified callerName (#1385)', () => {
  const method = { id: 42, file: 'shapes.js', kind: 'method' };

  it('resolves this.area() inside ClassName.describe using bare ClassName', () => {
    const lookup = makeLookup({ 'Shape.area': [method] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'area', receiver: 'this' },
      'shapes.js',
      new Map(),
      'Shape.describe',
    );
    expect(result).toEqual([method]);
  });

  it('resolves this.area() inside Namespace.ClassName.describe using bare ClassName only', () => {
    // Symbols are stored as 'Shape.area', not 'Namespace.Shape.area'.
    // Before the fix, callerClass was 'Namespace.Shape' → lookup failed.
    const lookup = makeLookup({ 'Shape.area': [method] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'area', receiver: 'this' },
      'shapes.js',
      new Map(),
      'Namespace.Shape.describe',
    );
    expect(result).toEqual([method]);
  });

  it('does not resolve when callerName has no dot (bare function)', () => {
    const lookup = makeLookup({ 'Shape.area': [method] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'area', receiver: 'this' },
      'shapes.js',
      new Map(),
      'describe',
    );
    // No dot → no class prefix → falls through to exact bare-name lookup
    expect(result).toEqual([]);
  });

  it('does not match namespace-qualified DB key when callerName has multiple dots', () => {
    // Only a wrong key exists in the DB; the correct lookup should not find it.
    const lookup = makeLookup({ 'Namespace.Shape.area': [method] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'area', receiver: 'this' },
      'shapes.js',
      new Map(),
      'Namespace.Shape.describe',
    );
    // callerClass should be 'Shape', so 'Shape.area' is tried — which is absent.
    expect(result).toEqual([]);
  });
});

describe('resolveByMethodOrGlobal — static receiver confidence filter (#1398)', () => {
  it('returns same-directory static target (confidence 0.7 >= 0.5)', () => {
    const target = { id: 1, file: 'app/Validators.cs', kind: 'method' };
    const lookup = makeLookup({ 'Validators.IsValidEmail': [target] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'IsValidEmail', receiver: 'Validators' },
      'app/Program.cs',
      new Map(),
    );
    expect(result).toEqual([target]);
  });

  it('filters out distant static target (confidence 0.3 < 0.5)', () => {
    const target = { id: 2, file: 'lib/util/Validators.cs', kind: 'method' };
    const lookup = makeLookup({ 'Validators.IsValidEmail': [target] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'IsValidEmail', receiver: 'Validators' },
      'app/main/Program.cs',
      new Map(),
    );
    expect(result).toEqual([]);
  });
});

describe('resolveByMethodOrGlobal — typeName branch confidence filter (#1398)', () => {
  it('returns same-directory typed method target (confidence 0.7 >= 0.5)', () => {
    const target = { id: 3, file: 'app/Foo.cs', kind: 'method' };
    const lookup = makeLookup({ 'Foo.bar': [target] });
    // typeMap entry: 'f' -> 'Foo' (e.g. from `let f = new Foo()`)
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'bar', receiver: 'f' },
      'app/Main.cs',
      new Map([['f', 'Foo']]),
    );
    expect(result).toEqual([target]);
  });

  it('filters out distant typed method target (confidence 0.3 < 0.5)', () => {
    const target = { id: 4, file: 'lib/util/Foo.cs', kind: 'method' };
    const lookup = makeLookup({ 'Foo.bar': [target] });
    // typeMap entry: 'f' -> 'Foo' — but the definition lives in a distant subtree
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'bar', receiver: 'f' },
      'app/main/Main.cs',
      new Map([['f', 'Foo']]),
    );
    expect(result).toEqual([]);
  });
});

describe('resolveByMethodOrGlobal — bare-call JS/TS module-scope guard (#1407)', () => {
  // `flush()` inside `Processor.run` — no receiver, JS/TS file.
  // Must NOT resolve to `Processor.flush` (class-scoped lookup is incorrect for JS/TS).
  const flushMethod = { id: 10, file: 'processor.ts', kind: 'method' };

  it('does NOT resolve bare call to same-class method in a .ts file', () => {
    const lookup = makeLookup({ 'Processor.flush': [flushMethod] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'flush', receiver: null },
      'processor.ts',
      new Map(),
      'Processor.run',
    );
    // bare call + .ts → module-scoped language → same-class fallback skipped
    expect(result).toEqual([]);
  });

  it('does NOT resolve bare call to same-class method in a .js file', () => {
    const lookup = makeLookup({ 'Processor.flush': [flushMethod] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'flush', receiver: null },
      'processor.js',
      new Map(),
      'Processor.run',
    );
    expect(result).toEqual([]);
  });

  it('DOES resolve this.flush() in a .ts file (receiver present — not a bare call)', () => {
    const lookup = makeLookup({ 'Processor.flush': [flushMethod] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'flush', receiver: 'this' },
      'processor.ts',
      new Map(),
      'Processor.run',
    );
    // this.flush() has a receiver → not a bare call → same-class fallback runs
    expect(result).toEqual([flushMethod]);
  });

  it('DOES resolve bare call to same-class method in a .cs file (C# is not module-scoped)', () => {
    const csMethod = { id: 20, file: 'Processor.cs', kind: 'method' };
    const lookup = makeLookup({ 'Processor.Flush': [csMethod] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'Flush', receiver: null },
      'Processor.cs',
      new Map(),
      'Processor.Run',
    );
    // C# is not module-scoped → same-class fallback runs → Processor.Flush found
    expect(result).toEqual([csMethod]);
  });
});

describe('resolveByMethodOrGlobal — cross-language global fallback rejection (#1783)', () => {
  // Mirrors the #1783 repro: ruby-tracer.rb's bare `Kernel#load` call has no
  // static relationship to loader-hooks.mjs's unrelated `load` export, even
  // though both files live in the same directory (which would otherwise
  // score confidence 0.7 — well above the resolver's 0.5 threshold).
  it('does not resolve a bare call to a same-directory, same-named symbol in a different language', () => {
    const jsExport = { id: 1, file: 'tracer/loader-hooks.mjs', kind: 'function' };
    const lookup = makeLookup({ load: [jsExport] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'load', receiver: null },
      'tracer/ruby-tracer.rb',
      new Map(),
    );
    expect(result).toEqual([]);
  });

  it('still resolves a bare call to a same-directory, same-named symbol in the SAME language', () => {
    const rbTarget = { id: 2, file: 'tracer/other-tracer.rb', kind: 'function' };
    const lookup = makeLookup({ load: [rbTarget] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'load', receiver: null },
      'tracer/ruby-tracer.rb',
      new Map(),
    );
    expect(result).toEqual([rbTarget]);
  });

  it('does not resolve a typed-method lookup to a same-named type in a different language', () => {
    // receiver 'w' typed to 'Widget' via typeMap; a same-directory JS 'Widget.render'
    // method must not satisfy a Python caller's 'w.render()' call.
    const jsMethod = { id: 3, file: 'lib/widget.js', kind: 'method' };
    const lookup = makeLookup({ 'Widget.render': [jsMethod] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'render', receiver: 'w' },
      'lib/widget.py',
      new Map([['w', 'Widget']]),
    );
    expect(result).toEqual([]);
  });
});

describe('resolveByMethodOrGlobal — resolveByGlobal exact-name fan-out (#1863)', () => {
  // Mirrors the exact #1863 repro: several object-literal `close() {}` methods
  // scattered under sibling directories two levels below the caller all score
  // the same 0.5 "grandparent proximity" confidence, so a bare `close()` call
  // must not fan out into a `calls` edge to every one of them.
  it('does not resolve a bare call when multiple candidates tie at the same confidence', () => {
    const t1 = { id: 1, file: 'src/db/connection.ts', kind: 'function' };
    const t2 = { id: 2, file: 'src/domain/target2.ts', kind: 'function' };
    const t3 = { id: 3, file: 'src/features/target3.ts', kind: 'function' };
    const lookup = makeLookup({ close: [t1, t2, t3] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'close', receiver: null },
      'src/presentation/caller.ts',
      new Map(),
    );
    expect(result).toEqual([]);
  });

  it('resolves to the single unambiguous highest-confidence candidate among several', () => {
    // t1 lives in the SAME directory as the caller (confidence 0.7); t2 and t3
    // are two directories away (confidence 0.5, tied with each other but not
    // with t1). The clear single winner must not be dropped by the ambiguity
    // guard — only genuine top-confidence ties are treated as unresolved.
    const t1 = { id: 1, file: 'src/presentation/sibling.ts', kind: 'function' };
    const t2 = { id: 2, file: 'src/domain/target2.ts', kind: 'function' };
    const t3 = { id: 3, file: 'src/features/target3.ts', kind: 'function' };
    const lookup = makeLookup({ close: [t1, t2, t3] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'close', receiver: null },
      'src/presentation/caller.ts',
      new Map(),
    );
    expect(result).toEqual([t1]);
  });

  it('still resolves a bare call with exactly one same-named candidate', () => {
    const t1 = { id: 1, file: 'src/db/connection.ts', kind: 'function' };
    const lookup = makeLookup({ close: [t1] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'close', receiver: null },
      'src/presentation/caller.ts',
      new Map(),
    );
    expect(result).toEqual([t1]);
  });

  it('falls through to the same-class sibling fallback when the exact match is ambiguous', () => {
    // The bare exact-name lookup ties across two unrelated files, so it must
    // yield nothing — but the caller is a qualified class method, so the
    // narrower same-class-sibling fallback (`Shape.area`) still applies.
    const unrelated1 = { id: 1, file: 'src/domain/target1.ts', kind: 'function' };
    const unrelated2 = { id: 2, file: 'src/features/target2.ts', kind: 'function' };
    const method = { id: 3, file: 'shapes.js', kind: 'method' };
    const lookup = makeLookup({ area: [unrelated1, unrelated2], 'Shape.area': [method] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'area', receiver: 'this' },
      'shapes.js',
      new Map(),
      'Shape.describe',
    );
    expect(result).toEqual([method]);
  });
});

describe('resolveByMethodOrGlobal — resolveByGlobal exact-name kind filter (#1888)', () => {
  // this.bar() is logically "invoke a member of the current instance" — a
  // class declaration can never satisfy that, so an unrelated same-named
  // class must not win the exact-global-match tier just because no
  // function/method candidate exists.
  it('does not resolve this.bar() to a same-named global class', () => {
    const cls = { id: 1, file: 'a.js', kind: 'class' };
    const lookup = makeLookup({ bar: [cls] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'bar', receiver: 'this' },
      'a.js',
      new Map(),
      'getter',
    );
    expect(result).toEqual([]);
  });

  it('still resolves this.bar() to a same-named global function/method', () => {
    const fn = { id: 2, file: 'a.js', kind: 'function' };
    const lookup = makeLookup({ bar: [fn] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'bar', receiver: 'this' },
      'a.js',
      new Map(),
      'getter',
    );
    expect(result).toEqual([fn]);
  });

  it('still resolves a genuinely bare call (no receiver at all) to a same-named class', () => {
    // A bare `Registry()` call is indistinguishable, at this layer, from a
    // `new Registry()` constructor invocation — kind-filtering it would break
    // constructor-call resolution, so it stays unfiltered.
    const cls = { id: 3, file: 'a.js', kind: 'class' };
    const lookup = makeLookup({ Registry: [cls] });
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'Registry', receiver: null },
      'a.js',
      new Map(),
      null,
    );
    expect(result).toEqual([cls]);
  });
});

// ── resolveReceiverEdge ──────────────────────────────────────────────────────

/**
 * Build a CallNodeLookup where:
 *  - `sameFile` is keyed by `"name:file"` and returned by `byNameAndFile`
 *  - `global` is keyed by `"name"` and returned by `byName`
 */
function makeReceiverLookup(
  sameFile: Record<string, Array<{ id: number; file: string; kind: string }>>,
  global: Record<string, Array<{ id: number; file: string; kind: string }>>,
): CallNodeLookup {
  return {
    byNameAndFile(name, file) {
      return sameFile[`${name}:${file}`] ?? [];
    },
    byName(name) {
      return global[name] ?? [];
    },
    isBarrel() {
      return false;
    },
    resolveBarrel() {
      return null;
    },
    nodeId() {
      return undefined;
    },
  };
}

describe('resolveReceiverEdge — local function constructor blocks global class (#1539)', () => {
  // Scenario: file "a.ts" defines `function Cache(){}` (kind='function').
  // File "b.ts" has a class `Cache` (kind='class').
  // A call in "a.ts" uses `new Cache()` — the same-file function constructor must
  // win; the cross-file class must NOT become the receiver edge target.
  const localFn = { id: 1, file: 'a.ts', kind: 'function' };
  const globalClass = { id: 2, file: 'b.ts', kind: 'class' };

  it('local function constructor blocks cross-file class when not an import artifact', () => {
    const lookup = makeReceiverLookup(
      { 'Cache:a.ts': [localFn] },
      { Cache: [localFn, globalClass] },
    );
    const result = resolveReceiverEdge(
      lookup,
      { name: 'get', receiver: 'Cache' },
      { id: 99 },
      'a.ts',
      new Map(),
      new Set(),
      new Map(), // Cache is NOT in importedNames — it is locally defined
    );
    // isLocalDefinition=true → candidates = sameFileCandidates filtered by RECEIVER_KINDS
    // localFn.kind='function' is not in RECEIVER_KINDS → candidates empty → null
    expect(result).toBeNull();
  });

  it('cross-file class wins when same-file node is an import artifact', () => {
    // `Cache` appears in `a.ts` only because of `const { Cache } = require('./b')`
    // — it seeds a kind='function' node in the importer. importedNames records it.
    const lookup = makeReceiverLookup({ 'Cache:a.ts': [localFn] }, { Cache: [globalClass] });
    const result = resolveReceiverEdge(
      lookup,
      { name: 'get', receiver: 'Cache' },
      { id: 99 },
      'a.ts',
      new Map(),
      new Set(),
      new Map([['Cache', './b']]), // Cache IS in importedNames — it is an import artifact
    );
    // isLocalDefinition=false → candidates = global byName filtered by RECEIVER_KINDS
    // globalClass.kind='class' IS in RECEIVER_KINDS → edge to id=2
    expect(result).not.toBeNull();
    expect(result?.receiverId).toBe(2);
  });
});

describe('resolveReceiverEdge — cross-language global fallback rejection (#1783)', () => {
  // The global (cross-file) receiver-resolution branch used no confidence or
  // language check at all, so `new Widget()` in one language could resolve
  // to an unrelated same-named class declared in a completely different
  // language. Only the global branch needs the check — sameFileCandidates
  // are already scoped to the caller's own file (trivially same-language).
  it('does not resolve a receiver to a same-named class in a different language', () => {
    const jsClass = { id: 1, file: 'lib/Widget.js', kind: 'class' };
    const lookup = makeReceiverLookup({}, { Widget: [jsClass] });
    const result = resolveReceiverEdge(
      lookup,
      { name: 'render', receiver: 'Widget' },
      { id: 99 },
      'lib/widget.py',
      new Map(),
      new Set(),
      new Map(),
    );
    expect(result).toBeNull();
  });

  it('still resolves a receiver to a same-named class in the SAME language', () => {
    const pyClass = { id: 2, file: 'lib/widget_impl.py', kind: 'class' };
    const lookup = makeReceiverLookup({}, { Widget: [pyClass] });
    const result = resolveReceiverEdge(
      lookup,
      { name: 'render', receiver: 'Widget' },
      { id: 99 },
      'lib/widget.py',
      new Map(),
      new Set(),
      new Map(),
    );
    expect(result).not.toBeNull();
    expect(result?.receiverId).toBe(2);
  });
});

// ── resolveDefinePropertyAccessorTarget ───────────────────────────────────

/**
 * Regression tests for #1766: the full-build path's `Object.defineProperty`
 * accessor fallback (`resolveDefinePropertyAccessorFallback` in
 * stages/build-edges.ts, plus its native-engine post-pass) and the incremental
 * path's (`applyCallFallbacks` in incremental.ts) used to diverge in their
 * final same-file fallback tier: full-build returned ANY same-file node named
 * `call.name` (unfiltered by kind), while incremental filtered to
 * function/method kinds only. Both paths now share this single function.
 *
 * A getter/setter registered via Object.defineProperty always dispatches to
 * callable code — never a class or variable — so an unrelated same-named
 * class or variable declared in the same file must never win. (In a full
 * pipeline run this same-file collision is normally already caught upstream
 * by resolveCallTargets's own unqualified lookup before this fallback is
 * ever reached; these tests exercise the fallback directly to pin down its
 * standalone kind-filtering contract regardless of caller.)
 */
describe('resolveDefinePropertyAccessorTarget — kind filter parity (#1766)', () => {
  const receivers = new Map([['getter', 'obj']]);

  it('resolves to the function, ignoring an unrelated same-named class in the same file', () => {
    const fn = { id: 1, file: 'a.js', kind: 'function' };
    const unrelatedClass = { id: 2, file: 'a.js', kind: 'class' };
    const lookup = makeReceiverLookup({ 'bar:a.js': [unrelatedClass, fn] }, {});
    const result = resolveDefinePropertyAccessorTarget(
      'bar',
      'getter',
      'a.js',
      new Map(), // no typeMap entry for 'obj' — plain object literal, not a typed instance
      lookup,
      receivers,
    );
    expect(result).toEqual([fn]);
  });

  it('resolves to a method, ignoring an unrelated same-named variable in the same file', () => {
    const method = { id: 3, file: 'a.js', kind: 'method' };
    const unrelatedVar = { id: 4, file: 'a.js', kind: 'variable' };
    const lookup = makeReceiverLookup({ 'bar:a.js': [unrelatedVar, method] }, {});
    const result = resolveDefinePropertyAccessorTarget(
      'bar',
      'getter',
      'a.js',
      new Map(),
      lookup,
      receivers,
    );
    expect(result).toEqual([method]);
  });

  it('returns nothing when only a same-named class/variable exists (no function/method)', () => {
    const unrelatedClass = { id: 5, file: 'a.js', kind: 'class' };
    const lookup = makeReceiverLookup({ 'bar:a.js': [unrelatedClass] }, {});
    const result = resolveDefinePropertyAccessorTarget(
      'bar',
      'getter',
      'a.js',
      new Map(),
      lookup,
      receivers,
    );
    expect(result).toEqual([]);
  });

  it('returns [] when callerName has no entry in definePropertyReceivers', () => {
    const fn = { id: 6, file: 'a.js', kind: 'function' };
    const lookup = makeReceiverLookup({ 'bar:a.js': [fn] }, {});
    const result = resolveDefinePropertyAccessorTarget(
      'bar',
      'unregisteredGetter',
      'a.js',
      new Map(),
      lookup,
      receivers,
    );
    expect(result).toEqual([]);
  });

  it('prefers the typeName-qualified method when the receiver has a resolvable type', () => {
    const qualifiedMethod = { id: 7, file: 'a.js', kind: 'method' };
    const bareFn = { id: 8, file: 'a.js', kind: 'function' };
    const lookup = makeReceiverLookup(
      { 'Registry.bar:a.js': [qualifiedMethod], 'bar:a.js': [bareFn] },
      {},
    );
    const result = resolveDefinePropertyAccessorTarget(
      'bar',
      'getter',
      'a.js',
      new Map([['obj', 'Registry']]),
      lookup,
      receivers,
    );
    expect(result).toEqual([qualifiedMethod]);
  });
});

describe('resolveByMethodOrGlobal — self.field receiver parity with this.field (#1876)', () => {
  const method = { id: 9, file: 'service.rs', kind: 'method' };

  it('resolves self.repo.find_by_id() via the class-scoped struct-field type map', () => {
    // Mirrors the Rust extractor's `${StructName}.${fieldName}` typeMap seeding
    // for `struct UserService { repo: UserRepository }`.
    const lookup = makeLookup({ 'UserRepository.find_by_id': [method] });
    const typeMap = new Map([['UserService.repo', { type: 'UserRepository', confidence: 0.9 }]]);
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'find_by_id', receiver: 'self.repo' },
      'service.rs',
      typeMap,
      'UserService.get_user',
    );
    expect(result).toEqual([method]);
  });

  it('does not resolve self.repo.find_by_id() when only an unrelated class owns the field name', () => {
    // The class-scoped key must be consulted — an unscoped 'repo' key belonging
    // to a different struct must not leak across classes (mirrors #1323/#1458
    // for `this.field`).
    const lookup = makeLookup({ 'UserRepository.find_by_id': [method] });
    const typeMap = new Map([['OtherService.repo', { type: 'UserRepository', confidence: 0.9 }]]);
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'find_by_id', receiver: 'self.repo' },
      'service.rs',
      typeMap,
      'UserService.get_user',
    );
    expect(result).toEqual([]);
  });

  it('still resolves this.field.method() unaffected by the self. addition', () => {
    const tsMethod = { id: 10, file: 'service.ts', kind: 'method' };
    const lookup = makeLookup({ 'Repository.findById': [tsMethod] });
    const typeMap = new Map([['Service.repo', { type: 'Repository', confidence: 0.9 }]]);
    const result = resolveByMethodOrGlobal(
      lookup,
      { name: 'findById', receiver: 'this.repo' },
      'service.ts',
      typeMap,
      'Service.getUser',
    );
    expect(result).toEqual([tsMethod]);
  });
});

// ── resolveCallTargets ─────────────────────────────────────────────────────

/**
 * Regression tests for #1888: the same-file bare-name lookup
 * (`lookup.byNameAndFile(call.name, relPath)`) in `resolveCallTargets` ran
 * unconditionally for every call, unfiltered by kind. A call with a receiver
 * (`this.bar()`, `obj.bar()`) is logically "invoke a member of some
 * instance" — a same-file class/interface/struct/etc. that merely shares the
 * call's bare name could win outright, before any more specific resolution
 * tier (receiver typing, the Object.defineProperty accessor fallback, etc.)
 * ever got a chance to run.
 *
 * The literal repro from the issue: `this.bar()` inside a function `getter`
 * resolved to a same-file `class bar {}` instead of the correctly-typed
 * `Registry.bar` method reachable via the Object.defineProperty accessor
 * fallback (see `issue-1888-same-file-bare-name-kind-filter.test.ts` for the
 * full end-to-end reproduction on both engines).
 *
 * A genuinely bare call (no receiver at all) must stay unfiltered: at this
 * layer it is indistinguishable from a `new ClassName()` constructor
 * invocation, which legitimately targets a class-kind definition.
 */
describe('resolveCallTargets — same-file bare-name lookup kind filter (#1888)', () => {
  it('does not resolve this.bar() to an unrelated same-file class', () => {
    const unrelatedClass = { id: 1, file: 'a.js', kind: 'class' };
    const lookup = makeReceiverLookup({ 'bar:a.js': [unrelatedClass] }, {});
    const { targets } = resolveCallTargets(
      lookup,
      { name: 'bar', receiver: 'this' },
      'a.js',
      new Map(),
      new Map(),
      'getter',
    );
    expect(targets).toEqual([]);
  });

  it('still resolves this.bar() to a same-file function/method when both exist', () => {
    const unrelatedClass = { id: 1, file: 'a.js', kind: 'class' };
    const fn = { id: 2, file: 'a.js', kind: 'function' };
    const lookup = makeReceiverLookup({ 'bar:a.js': [unrelatedClass, fn] }, {});
    const { targets } = resolveCallTargets(
      lookup,
      { name: 'bar', receiver: 'this' },
      'a.js',
      new Map(),
      new Map(),
      'getter',
    );
    expect(targets).toEqual([fn]);
  });

  it('does not resolve obj.bar() to an unrelated same-file class', () => {
    const unrelatedClass = { id: 3, file: 'a.js', kind: 'class' };
    const lookup = makeReceiverLookup({ 'bar:a.js': [unrelatedClass] }, {});
    const { targets } = resolveCallTargets(
      lookup,
      { name: 'bar', receiver: 'obj' },
      'a.js',
      new Map(),
      new Map(),
      null,
    );
    expect(targets).toEqual([]);
  });

  it('still resolves a genuinely bare call (no receiver) to a same-file class — constructor calls', () => {
    // `new Registry()` is captured as a bare call with no receiver, so it
    // must still be able to resolve to the class definition.
    const cls = { id: 4, file: 'a.js', kind: 'class' };
    const lookup = makeReceiverLookup({ 'Registry:a.js': [cls] }, {});
    const { targets } = resolveCallTargets(
      lookup,
      { name: 'Registry', receiver: undefined },
      'a.js',
      new Map(),
      new Map(),
      null,
    );
    expect(targets).toEqual([cls]);
  });
});

/**
 * Regression test for #1892's barrel-rename gap (flagged in PR #2028 review):
 * `attachConstructorTargets` must key its qualified `ClassName.ctorLocalName`
 * lookup on the name truly declared in the target's own file, not the call
 * site's (possibly barrel-aliased) name. `export { Foo as Bar } from './foo'`
 * means `new Bar()` resolves the class node via `lookup.resolveBarrel`,
 * which reports `{ file: 'foo.ts', name: 'Foo' }` — the constructor lookup
 * must use that reported 'Foo', not the caller's 'Bar', or it builds a
 * `Bar.constructor` key that can never match the stored `Foo.constructor`.
 */
describe('resolveCallTargets — constructor attribution through a renaming barrel (#1892)', () => {
  function makeBarrelLookup(
    sameFile: Record<string, Array<{ id: number; file: string; kind: string }>>,
    barrelFiles: Set<string>,
    barrelExports: Record<string, { file: string; name: string }>,
  ): CallNodeLookup {
    return {
      byNameAndFile(name, file) {
        return sameFile[`${name}:${file}`] ?? [];
      },
      byName() {
        return [];
      },
      isBarrel(file) {
        return barrelFiles.has(file);
      },
      resolveBarrel(barrelFile, symbolName) {
        return barrelExports[`${symbolName}:${barrelFile}`] ?? null;
      },
      nodeId() {
        return undefined;
      },
    };
  }

  it('attributes new Bar() to Foo.constructor when the barrel renames Foo to Bar', () => {
    const classFoo = { id: 10, file: 'foo.ts', kind: 'class' };
    const ctorFoo = { id: 11, file: 'foo.ts', kind: 'method' };
    const lookup = makeBarrelLookup(
      {
        'Foo:foo.ts': [classFoo],
        'Foo.constructor:foo.ts': [ctorFoo],
      },
      new Set(['barrel.ts']),
      { 'Bar:barrel.ts': { file: 'foo.ts', name: 'Foo' } },
    );
    const importedNames = new Map([['Bar', 'barrel.ts']]);
    const { targets } = resolveCallTargets(
      lookup,
      { name: 'Bar', receiver: undefined },
      'caller.ts',
      importedNames,
      new Map(),
      null,
    );
    expect(targets).toEqual([classFoo, ctorFoo]);
  });

  it('does not fabricate a constructor edge when the barrel-renamed class has no explicit constructor', () => {
    const classBaz = { id: 20, file: 'baz.ts', kind: 'class' };
    const lookup = makeBarrelLookup({ 'Baz:baz.ts': [classBaz] }, new Set(['barrel.ts']), {
      'Qux:barrel.ts': { file: 'baz.ts', name: 'Baz' },
    });
    const importedNames = new Map([['Qux', 'barrel.ts']]);
    const { targets } = resolveCallTargets(
      lookup,
      { name: 'Qux', receiver: undefined },
      'caller.ts',
      importedNames,
      new Map(),
      null,
    );
    expect(targets).toEqual([classBaz]);
  });
});
