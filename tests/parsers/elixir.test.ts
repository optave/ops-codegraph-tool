import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractElixirSymbols } from '../../src/domain/parser.js';

describe('Elixir parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseElixir(code) {
    const parser = parsers.get('elixir');
    if (!parser) throw new Error('Elixir parser not available');
    const tree = parser.parse(code);
    return extractElixirSymbols(tree, 'test.ex');
  }

  it('extracts module definitions', () => {
    const symbols = parseElixir(`defmodule MyApp.User do
end`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'MyApp.User', kind: 'module' }),
    );
  });

  it('extracts function definitions', () => {
    const symbols = parseElixir(`defmodule Greeter do
  def greet(name) do
    "Hello"
  end
end`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Greeter.greet', kind: 'function' }),
    );
  });

  it('extracts protocol definitions', () => {
    const symbols = parseElixir(`defprotocol Printable do
  def print(data)
end`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Printable', kind: 'interface' }),
    );
  });

  it('extracts imports (use/import/require)', () => {
    const symbols = parseElixir(`use GenServer
import Enum
require Logger`);
    expect(symbols.imports.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts function calls', () => {
    const symbols = parseElixir(`defmodule Foo do
  def bar do
    IO.puts("hello")
  end
end`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'puts', receiver: 'IO' }));
  });
});
