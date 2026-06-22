/**
 * FFI field round-trip test for dynamic call classification.
 *
 * Verifies that dynamicKind and keyExpr fields are correctly set by the
 * JS/WASM extractor and survive the ExtractorOutput → Call pipeline.
 * Guards against silent drops at the Worker thread serialization seam
 * (wasm-worker-protocol.ts passes calls wholesale, so this mainly tests extractor logic).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractSymbols, getParser } from '../../src/domain/parser.js';

let parsers: Awaited<ReturnType<typeof createParsers>>;

describe('dynamic call classification — dynamicKind and keyExpr fields', () => {
  beforeAll(async () => {
    parsers = await createParsers();
  }, 30_000);

  function parseJS(code: string) {
    const parser = getParser(parsers, 'test.js');
    if (!parser) throw new Error('JS parser not available');
    const tree = parser.parse(code);
    return extractSymbols(tree, 'test.js');
  }

  it('tags eval() as eval kind with keyExpr captured for string literal', () => {
    const out = parseJS(`
      function test() { eval("console.log('hi')"); }
    `);
    const c = out.calls.find((c) => c.name === '<dynamic:eval>');
    expect(c).toBeDefined();
    expect(c?.dynamicKind).toBe('eval');
    expect(c?.dynamic).toBe(true);
    expect(c?.keyExpr).toContain('console.log');
  });

  it('tags new Function() as eval kind', () => {
    const out = parseJS(`
      function test() { const fn = new Function('return 42'); }
    `);
    const c = out.calls.find((c) => c.name === '<dynamic:eval>');
    expect(c).toBeDefined();
    expect(c?.dynamicKind).toBe('eval');
  });

  it("tags obj['method']() as computed-literal kind", () => {
    const out = parseJS(`
      function test(obj) { obj['greet']('world'); }
    `);
    const c = out.calls.find((c) => c.name === 'greet');
    expect(c).toBeDefined();
    expect(c?.dynamicKind).toBe('computed-literal');
    expect(c?.dynamic).toBe(true);
  });

  it('tags obj[key]() as computed-key kind with keyExpr', () => {
    const out = parseJS(`
      function test(handlers, key) { handlers[key]('arg'); }
    `);
    const c = out.calls.find((c) => c.name === '<dynamic:computed-key>');
    expect(c).toBeDefined();
    expect(c?.dynamicKind).toBe('computed-key');
    expect(c?.keyExpr).toBe('key');
    expect(c?.dynamic).toBe(true);
  });

  it('resolves fn.call(ctx) as a static call — no dynamic flag (#1687)', () => {
    // `greet.call(ctx, 'world')` — plain-identifier receiver; target is statically known.
    // We emit a static call (no dynamic, no dynamicKind) to match native Rust parity and
    // prevent the dynZeroEdgeRows upgrade from promoting a prior dyn=0 edge to dyn=1.
    const out = parseJS(`
      function test(ctx) { greet.call(ctx, 'world'); }
    `);
    const c = out.calls.find((c) => c.name === 'greet');
    expect(c).toBeDefined();
    expect(c?.dynamic).toBeFalsy();
    expect(c?.dynamicKind).toBeUndefined();
  });

  it('resolves fn.apply(ctx, args) as a static call — no dynamic flag (#1687)', () => {
    // Same as .call(): plain-identifier receiver → static call.
    const out = parseJS(`
      function test(ctx) { greet.apply(ctx, ['world']); }
    `);
    const c = out.calls.find((c) => c.name === 'greet');
    expect(c).toBeDefined();
    expect(c?.dynamic).toBeFalsy();
    expect(c?.dynamicKind).toBeUndefined();
  });

  it('tags obj[a + b]() as unresolved-dynamic kind', () => {
    const out = parseJS(`
      function test(handlers, a, b) { handlers[a + b]('arg'); }
    `);
    const c = out.calls.find((c) => c.name === '<dynamic:unresolved>');
    expect(c).toBeDefined();
    expect(c?.dynamicKind).toBe('unresolved-dynamic');
    expect(c?.dynamic).toBe(true);
  });

  it('does not set dynamicKind on normal function calls', () => {
    const out = parseJS(`
      function test() { greet('world'); }
    `);
    const c = out.calls.find((c) => c.name === 'greet');
    expect(c).toBeDefined();
    expect(c?.dynamicKind).toBeUndefined();
    expect(c?.dynamic).toBeUndefined();
  });

  // ── Phase 1: Reflect.* and decorator patterns ──────────────────────────

  it('Reflect.apply(fn, ctx, args) extracts fn as reflection kind', () => {
    const out = parseJS(`
      function test(fn, ctx) { Reflect.apply(fn, ctx, []); }
    `);
    const c = out.calls.find((c) => c.name === 'fn');
    expect(c).toBeDefined();
    expect(c?.dynamicKind).toBe('reflection');
    expect(c?.dynamic).toBe(true);
  });

  it('Reflect.construct(Cls, args) extracts Cls as reflection kind', () => {
    const out = parseJS(`
      function test(Cls) { Reflect.construct(Cls, []); }
    `);
    const c = out.calls.find((c) => c.name === 'Cls');
    expect(c).toBeDefined();
    expect(c?.dynamicKind).toBe('reflection');
    expect(c?.dynamic).toBe(true);
  });

  it("Reflect.get(target, 'prop') extracts as computed-literal with keyExpr", () => {
    const out = parseJS(`
      function test(target) { Reflect.get(target, 'greet'); }
    `);
    const c = out.calls.find((c) => c.name === 'greet');
    expect(c).toBeDefined();
    expect(c?.dynamicKind).toBe('computed-literal');
    expect(c?.keyExpr).toContain('greet');
    expect(c?.dynamic).toBe(true);
  });

  it('Reflect.get(target, key) with variable key extracts as computed-key', () => {
    const out = parseJS(`
      function test(target, key) { Reflect.get(target, key); }
    `);
    const c = out.calls.find((c) => c.name === '<dynamic:computed-key>');
    expect(c).toBeDefined();
    expect(c?.dynamicKind).toBe('computed-key');
    expect(c?.keyExpr).toBe('key');
  });
});

describe('Phase 1: TypeScript decorator detection', () => {
  let parsers: Awaited<ReturnType<typeof createParsers>>;

  beforeAll(async () => {
    parsers = await createParsers();
  }, 30_000);

  function parseTS(code: string) {
    const parser = getParser(parsers, 'test.ts');
    if (!parser) throw new Error('TS parser not available');
    const tree = parser.parse(code);
    return extractSymbols(tree, 'test.ts');
  }

  it('@Foo decorator extracts Foo as reflection kind', () => {
    const out = parseTS(`
      function Foo(target: any) {}
      @Foo
      class MyClass {}
    `);
    const c = out.calls.find((c) => c.name === 'Foo');
    expect(c).toBeDefined();
    expect(c?.dynamicKind).toBe('reflection');
    expect(c?.dynamic).toBe(true);
  });

  it('@Foo.bar decorator extracts bar with reflection kind', () => {
    const out = parseTS(`
      const decorators = { log: (t: any) => {} };
      @decorators.log
      class MyClass {}
    `);
    const c = out.calls.find((c) => c.name === 'log');
    expect(c).toBeDefined();
    expect(c?.dynamicKind).toBe('reflection');
  });
});
