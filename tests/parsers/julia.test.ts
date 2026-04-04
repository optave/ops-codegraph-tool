import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractJuliaSymbols } from '../../src/domain/parser.js';

describe('Julia parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseJulia(code) {
    const parser = parsers.get('julia');
    if (!parser) throw new Error('Julia parser not available');
    const tree = parser.parse(code);
    return extractJuliaSymbols(tree, 'test.jl');
  }

  it('extracts function definitions', () => {
    const symbols = parseJulia(`function greet(name)
    println("Hello $name")
end`);
    expect(symbols.definitions).toContainEqual(expect.objectContaining({ kind: 'function' }));
  });

  it('extracts short function definitions', () => {
    const symbols = parseJulia(`add(x, y) = x + y`);
    expect(symbols.definitions).toContainEqual(expect.objectContaining({ kind: 'function' }));
  });

  it('extracts struct definitions', () => {
    const symbols = parseJulia(`struct Point
    x::Float64
    y::Float64
end`);
    expect(symbols.definitions).toContainEqual(expect.objectContaining({ kind: 'struct' }));
  });

  it('extracts module definitions', () => {
    const symbols = parseJulia(`module MyModule
    export greet
end`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'MyModule', kind: 'module' }),
    );
  });

  it('extracts import/using statements', () => {
    const symbols = parseJulia(`using LinearAlgebra
import Base: show`);
    expect(symbols.imports.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts function calls', () => {
    const symbols = parseJulia(`println("Hello")
push!(arr, 1)`);
    expect(symbols.calls.length).toBeGreaterThanOrEqual(1);
  });
});
