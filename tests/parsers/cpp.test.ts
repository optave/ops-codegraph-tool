import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractCppSymbols } from '../../src/domain/parser.js';

describe('C++ parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseCpp(code) {
    const parser = parsers.get('cpp');
    if (!parser) throw new Error('C++ parser not available');
    const tree = parser.parse(code);
    return extractCppSymbols(tree, 'test.cpp');
  }

  it('extracts class declarations', () => {
    const symbols = parseCpp(`class Animal { };`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Animal', kind: 'class', line: 1 }),
    );
  });

  it('extracts class with methods', () => {
    const symbols = parseCpp(`class Animal {
  void speak() { }
};`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Animal', kind: 'class' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Animal.speak', kind: 'method' }),
    );
  });

  it('extracts inheritance', () => {
    const symbols = parseCpp(`class Dog : public Animal { };`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'Dog', extends: 'Animal' }),
    );
  });

  it('extracts namespace', () => {
    const symbols = parseCpp(`namespace utils { void helper() { } }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'utils', kind: 'namespace' }),
    );
  });

  it('extracts struct', () => {
    const symbols = parseCpp(`struct Point { int x; int y; };`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Point', kind: 'struct' }),
    );
  });

  it('extracts enum', () => {
    const symbols = parseCpp(`enum Color { RED, GREEN, BLUE };`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Color', kind: 'enum' }),
    );
  });

  it('extracts includes', () => {
    const symbols = parseCpp(`#include <iostream>\n#include "mylib.h"`);
    expect(symbols.imports.length).toBe(2);
    expect(symbols.imports[0].source).toBe('iostream');
    expect(symbols.imports[0].cInclude).toBe(true);
  });

  it('extracts function calls', () => {
    const symbols = parseCpp(`void f() { std::cout << "hello"; bar(); }`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'bar' }));
  });
});
