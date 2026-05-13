import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractErlangSymbols } from '../../src/domain/parser.js';

describe('Erlang parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseErlang(code) {
    const parser = parsers.get('erlang');
    if (!parser) throw new Error('Erlang parser not available');
    const tree = parser.parse(code);
    return extractErlangSymbols(tree, 'test.erl');
  }

  it('extracts module declarations', () => {
    const symbols = parseErlang(`-module(mymodule).`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'mymodule', kind: 'module' }),
    );
  });

  it('extracts function definitions', () => {
    const symbols = parseErlang(`greet(Name) ->
    io:format("Hello ~s~n", [Name]).`);
    expect(symbols.definitions).toContainEqual(expect.objectContaining({ kind: 'function' }));
  });

  it('extracts record definitions', () => {
    const symbols = parseErlang(`-record(person, {name, age}).`);
    expect(symbols.definitions).toContainEqual(expect.objectContaining({ kind: 'record' }));
  });

  it('extracts import attributes', () => {
    const symbols = parseErlang(`-import(lists, [map/2, filter/2]).`);
    expect(symbols.imports.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts function calls', () => {
    const symbols = parseErlang(`start() ->
    io:format("Hello~n").`);
    expect(symbols.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps distinct arities for the same function name', () => {
    // Erlang overloads by arity; foo/1 and foo/2 are distinct definitions.
    const symbols = parseErlang(`foo(X) -> X.
foo(X, Y) -> X + Y.
foo(X, Y, Z) -> X + Y + Z.`);
    const fooDefs = symbols.definitions.filter((d) => d.name === 'foo' && d.kind === 'function');
    expect(fooDefs).toHaveLength(3);
    const arities = fooDefs.map((d) => d.children?.length ?? 0).sort();
    expect(arities).toEqual([1, 2, 3]);
  });

  it('counts complex pattern arguments as parameters', () => {
    // Tuple, list, and binary pattern arguments must still count toward arity.
    const symbols = parseErlang(`handle({ok, X}, [H | T]) -> {X, H, T}.`);
    const f = symbols.definitions.find((d) => d.name === 'handle' && d.kind === 'function');
    expect(f).toBeDefined();
    expect(f?.children?.length).toBe(2);
  });

  it('extracts -type aliases', () => {
    // Type-alias names are wrapped in a `type_name` node containing an atom in
    // the current grammar; the extractor handles both the wrapped form and a
    // direct atom fallback.
    const symbols = parseErlang(`-type id() :: integer().`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'id', kind: 'type' }),
    );
  });

  it('extracts -opaque types', () => {
    // -opaque uses the same `type_alias` node shape and must produce a type def.
    const symbols = parseErlang(`-opaque handle() :: reference().`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'handle', kind: 'type' }),
    );
  });

  it('extracts -define macros as variables', () => {
    const symbols = parseErlang(`-define(MAX_SIZE, 1024).`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'MAX_SIZE', kind: 'variable' }),
    );
  });

  it('extracts uppercase parametric macro names', () => {
    // Parametric macros wrap the name in `macro_lhs(name, args)`; the leading
    // child is the name (var for uppercase).
    const symbols = parseErlang(`-define(FOO(X), X + 1).`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'FOO', kind: 'variable' }),
    );
  });

  it('extracts lowercase parametric macro names without mislabeling on argument vars', () => {
    // For lowercase parametric macros, macro_lhs children are
    // `atom("foo"), '(', var("X"), ')'`. The macro name must come from the
    // atom, not from `findChild(.., 'var')` which would land on the argument.
    const symbols = parseErlang(`-define(foo(X), X + 1).`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'foo', kind: 'variable' }),
    );
    // Argument variable must not be recorded as the macro name.
    expect(symbols.definitions.some((d) => d.name === 'X')).toBe(false);
  });

  it('records -include with kind "include" so consumers resolve locally', () => {
    const symbols = parseErlang(`-include("foo.hrl").`);
    const imp = symbols.imports.find((i) => i.source === 'foo.hrl');
    expect(imp).toBeDefined();
    expect(imp?.names).toEqual(['include']);
  });

  it('records -include_lib with kind "include_lib" so consumers resolve against OTP paths', () => {
    const symbols = parseErlang(`-include_lib("kernel/include/file.hrl").`);
    const imp = symbols.imports.find((i) => i.source === 'kernel/include/file.hrl');
    expect(imp).toBeDefined();
    expect(imp?.names).toEqual(['include_lib']);
  });
});
