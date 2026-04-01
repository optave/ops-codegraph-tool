import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractFSharpSymbols } from '../../src/domain/parser.js';

describe('F# parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseFSharp(code) {
    const parser = parsers.get('fsharp');
    if (!parser) throw new Error('F# parser not available');
    const tree = parser.parse(code);
    return extractFSharpSymbols(tree, 'test.fs');
  }

  it('extracts module definitions', () => {
    const symbols = parseFSharp(`module MyApp.Utils

let add x y = x + y`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'MyApp.Utils', kind: 'module' }),
    );
  });

  it('extracts function definitions', () => {
    const symbols = parseFSharp(`let add x y = x + y`);
    expect(symbols.definitions).toContainEqual(expect.objectContaining({ kind: 'function' }));
  });

  it('extracts type definitions', () => {
    const symbols = parseFSharp(`type Color =
    | Red
    | Green
    | Blue`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ kind: expect.stringMatching(/type|enum/) }),
    );
  });

  it('extracts open directives as imports', () => {
    const symbols = parseFSharp(`open System
open System.IO`);
    expect(symbols.imports.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts function calls', () => {
    const symbols = parseFSharp(`let result = List.map (fun x -> x + 1) [1; 2; 3]`);
    expect(symbols.calls.length).toBeGreaterThanOrEqual(1);
  });
});
