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

  it('extracts parameterized struct base name', () => {
    // Parameterized struct names (e.g. `Vec{T}`) must record the base
    // identifier — not be silently dropped or include type-parameter text.
    const symbols = parseJulia(`struct Vec{T} <: AbstractArray{T,1}
    data::Vector{T}
end`);
    const names = symbols.definitions.map((d) => d.name);
    expect(names).toContain('Vec');
    expect(names.every((n) => !n.includes('{') && !n.includes('<'))).toBe(true);
    expect(symbols.classes).toHaveLength(1);
    expect(symbols.classes[0]).toMatchObject({ name: 'Vec', extends: 'AbstractArray' });
  });

  it('qualified short-form method does not double-prefix', () => {
    // `Foo.bar(x, y) = x + y` inside `module Outer` must record `Foo.bar`,
    // not `Outer.Foo.bar` — the scoped_identifier already carries the qualifier.
    const symbols = parseJulia(`module Outer
    Foo.bar(x, y) = x + y
end`);
    const names = symbols.definitions.map((d) => d.name);
    expect(names).toContain('Foo.bar');
    expect(names).not.toContain('Outer.Foo.bar');
  });

  it('qualified function def does not double-prefix', () => {
    // `function Base.show(io, x) ... end` inside `module Foo` must record
    // `Base.show`, not `Foo.Base.show`.
    const symbols = parseJulia(`module Foo
    function Base.show(io, x)
        println(io, x)
    end
end`);
    const names = symbols.definitions.map((d) => d.name);
    expect(names).toContain('Base.show');
    expect(names).not.toContain('Foo.Base.show');
  });

  it('extracts abstract type', () => {
    const symbols = parseJulia(`abstract type AbstractShape end`);
    const abs = symbols.definitions.find((d) => d.name === 'AbstractShape');
    expect(abs).toBeDefined();
    expect(abs).toMatchObject({ kind: 'type' });
  });

  it('extracts parameterized abstract type base name', () => {
    // Parameterized generics with a supertype must record only the base
    // identifier — never the raw `Name{T} <: Super{T,1}` text.
    const symbols = parseJulia(`abstract type AbstractVector{T} <: AbstractArray{T,1} end`);
    const names = symbols.definitions.map((d) => d.name);
    expect(names).toContain('AbstractVector');
    expect(names.every((n) => !n.includes('{') && !n.includes('<'))).toBe(true);
  });

  it('extracts macro definitions with correct name', () => {
    // `findChild(node, 'identifier')` would resolve to the body's `x` here,
    // recording the macro as `@x` instead of `@mymac`.
    const symbols = parseJulia(`macro mymac(x)
    x
end`);
    const names = symbols.definitions.map((d) => d.name);
    expect(names).toContain('@mymac');
    expect(names).not.toContain('@x');
  });

  it('does not record function signature as call', () => {
    // The signature's `call_expression` lives inside a `signature` node — a
    // naive `parent.type === 'function_definition'` guard misses it and
    // records `greet` as both a definition and a call.
    const symbols = parseJulia(`function greet(name)
    println(name)
end`);
    const callNames = symbols.calls.map((c) => c.name);
    expect(callNames).not.toContain('greet');
    expect(callNames).toContain('println');
  });

  it('selected_import handles qualified module', () => {
    // `import Foo.Bar: baz` — module is a scoped_identifier. The import
    // must record `Foo.Bar` as the source and `baz` as the imported name,
    // not the malformed `source="baz", names=["baz"]`.
    const symbols = parseJulia(`import LinearAlgebra.BLAS: gemm`);
    expect(symbols.imports).toHaveLength(1);
    expect(symbols.imports[0]).toMatchObject({
      source: 'LinearAlgebra.BLAS',
    });
    expect(symbols.imports[0].names).toContain('gemm');
    expect(symbols.imports[0].names).not.toContain('LinearAlgebra.BLAS');
  });
});
