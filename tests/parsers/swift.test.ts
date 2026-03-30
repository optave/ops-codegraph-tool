import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractSwiftSymbols } from '../../src/domain/parser.js';

describe('Swift parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseSwift(code) {
    const parser = parsers.get('swift');
    if (!parser) throw new Error('Swift parser not available');
    const tree = parser.parse(code);
    return extractSwiftSymbols(tree, 'Test.swift');
  }

  it('extracts function declarations', () => {
    const symbols = parseSwift(`func greet(name: String) -> String { return "Hello" }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function' }),
    );
  });

  it('extracts class declarations', () => {
    const symbols = parseSwift(`class Animal { }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Animal', kind: 'class', line: 1 }),
    );
  });

  it('extracts class with methods', () => {
    const symbols = parseSwift(`class Animal {
  func speak() { }
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Animal', kind: 'class' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Animal.speak', kind: 'method' }),
    );
  });

  it('extracts struct declarations', () => {
    const symbols = parseSwift(`struct Point {
  var x: Int
  var y: Int
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Point', kind: 'struct', line: 1 }),
    );
  });

  it('extracts protocol declarations', () => {
    const symbols = parseSwift(`protocol Drawable { func draw() }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Drawable', kind: 'interface', line: 1 }),
    );
  });

  it('extracts enum declarations', () => {
    const symbols = parseSwift(`enum Direction {
  case north
  case south
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Direction', kind: 'enum', line: 1 }),
    );
  });

  it('extracts inheritance', () => {
    const symbols = parseSwift(`class Dog: Animal { }`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'Dog', extends: 'Animal' }),
    );
  });

  it('extracts imports', () => {
    const symbols = parseSwift(`import Foundation`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ swiftImport: true }),
    );
  });

  it('extracts function calls', () => {
    const symbols = parseSwift(`func foo() { print("hello"); bar() }`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'print' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'bar' }));
  });
});
