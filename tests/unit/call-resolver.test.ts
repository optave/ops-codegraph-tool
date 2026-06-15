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
