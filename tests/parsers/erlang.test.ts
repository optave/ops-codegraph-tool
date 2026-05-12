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
});
