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
});
