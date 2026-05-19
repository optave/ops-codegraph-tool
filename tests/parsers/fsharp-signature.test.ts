import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractFSharpSymbols } from '../../src/domain/parser.js';

describe('F# signature (.fsi) parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseFSi(code: string) {
    const parser = parsers.get('fsharp-signature');
    if (!parser) throw new Error('F# signature parser not available');
    const tree = parser.parse(code);
    return { tree, symbols: extractFSharpSymbols(tree, 'test.fsi') };
  }

  it('parses bare val declarations without ERROR nodes', () => {
    // The main F# grammar produces ERROR nodes for `val` declarations
    // (#1114); the signature grammar parses them as `value_definition`.
    const { tree, symbols } = parseFSi(
      `namespace MyApp.Domain\n\nval add : int -> int -> int\nval pi : float\n`,
    );
    expect(tree.rootNode.hasError).toBe(false);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'add', kind: 'function' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'pi', kind: 'variable' }),
    );
  });

  it('extracts bare top-level val declarations', () => {
    const { tree, symbols } = parseFSi(`val negate : int -> int\nval count : int\n`);
    expect(tree.rootNode.hasError).toBe(false);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'negate', kind: 'function' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'count', kind: 'variable' }),
    );
  });

  it('extracts val declarations nested inside a module signature', () => {
    // The WASM tree-sitter-fsharp 0.1.0 signature grammar does NOT produce a
    // `module_defn` for `module Foo = ...` — it emits ERROR nodes and the
    // `val` declarations float to the top level (so they're indexed as
    // `add`, not `Foo.add`). The cargo 0.3.0 grammar parses it correctly
    // and the Rust extractor qualifies as `Foo.add`. Grammar version skew
    // is tracked under #1161; once npm bumps to 0.3.0+ this test should
    // assert `Foo.add` to match the native engine.
    const { symbols } = parseFSi(`module Foo =\n  val add : int -> int\n`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'add', kind: 'function' }),
    );
  });

  it('does not crash when the grammar produces ERROR nodes for unsupported constructs', () => {
    // `open` at the namespace top level is not handled by the upstream
    // signature grammar v0.3.0 — it produces ERROR nodes but val
    // declarations still recover via the parser's error recovery.
    const { symbols } = parseFSi(`namespace X\n\nopen System\n\nval read : string -> string\n`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'read', kind: 'function' }),
    );
  });
});
