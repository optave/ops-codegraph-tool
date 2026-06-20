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

  it('tags fn.call(ctx) as reflection kind', () => {
    const out = parseJS(`
      function test(ctx) { greet.call(ctx, 'world'); }
    `);
    const c = out.calls.find((c) => c.name === 'greet');
    expect(c).toBeDefined();
    expect(c?.dynamicKind).toBe('reflection');
    expect(c?.dynamic).toBe(true);
  });

  it('tags fn.apply(ctx, args) as reflection kind', () => {
    const out = parseJS(`
      function test(ctx) { greet.apply(ctx, ['world']); }
    `);
    const c = out.calls.find((c) => c.name === 'greet');
    expect(c).toBeDefined();
    expect(c?.dynamicKind).toBe('reflection');
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
});
