import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractHaskellSymbols } from '../../src/domain/parser.js';

describe('Haskell parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseHaskell(code) {
    const parser = parsers.get('haskell');
    if (!parser) throw new Error('Haskell parser not available');
    const tree = parser.parse(code);
    return extractHaskellSymbols(tree, 'Test.hs');
  }

  it('extracts function declarations', () => {
    const symbols = parseHaskell(`greet name = "Hello " ++ name`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function' }),
    );
  });

  it('extracts data type declarations', () => {
    const symbols = parseHaskell(`data Color = Red | Green | Blue`);
    expect(symbols.definitions).toContainEqual(expect.objectContaining({ kind: 'type' }));
  });

  it('extracts newtype declarations', () => {
    const symbols = parseHaskell(`newtype Name = Name String`);
    expect(symbols.definitions).toContainEqual(expect.objectContaining({ kind: 'type' }));
  });

  it('extracts type aliases', () => {
    const symbols = parseHaskell(`type Point = (Double, Double)`);
    expect(symbols.definitions).toContainEqual(expect.objectContaining({ kind: 'type' }));
  });

  it('extracts class declarations', () => {
    const symbols = parseHaskell(`class Printable a where
  prettyPrint :: a -> String`);
    expect(symbols.definitions).toContainEqual(expect.objectContaining({ kind: 'class' }));
  });

  it('extracts import statements', () => {
    const symbols = parseHaskell(`import Data.List
import qualified Data.Map as Map`);
    expect(symbols.imports.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts function applications as calls', () => {
    const symbols = parseHaskell(`main = putStrLn "Hello"`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'putStrLn' }));
  });
});
