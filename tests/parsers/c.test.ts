import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractCSymbols } from '../../src/domain/parser.js';

describe('C parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseC(code) {
    const parser = parsers.get('c');
    if (!parser) throw new Error('C parser not available');
    const tree = parser.parse(code);
    return extractCSymbols(tree, 'test.c');
  }

  it('extracts function definitions', () => {
    const symbols = parseC(`int main(int argc, char **argv) { return 0; }`);
    const main = symbols.definitions.find((d) => d.name === 'main');
    expect(main).toBeDefined();
    expect(main.kind).toBe('function');
    expect(main.children).toBeDefined();
    expect(main.children.length).toBe(2);
    expect(main.children[0].name).toBe('argc');
    expect(main.children[0].kind).toBe('parameter');
  });

  it('extracts struct definitions', () => {
    const symbols = parseC(`struct Point { int x; int y; };`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Point', kind: 'struct' }),
    );
  });

  it('extracts enum definitions', () => {
    const symbols = parseC(`enum Color { RED, GREEN, BLUE };`);
    const color = symbols.definitions.find((d) => d.name === 'Color');
    expect(color).toBeDefined();
    expect(color.kind).toBe('enum');
    expect(color.children).toBeDefined();
    expect(color.children.length).toBe(3);
    expect(color.children[0].name).toBe('RED');
    expect(color.children[0].kind).toBe('constant');
  });

  it('extracts typedef', () => {
    const symbols = parseC(`typedef unsigned long size_t;`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'size_t', kind: 'type' }),
    );
  });

  it('extracts includes', () => {
    const symbols = parseC(`#include <stdio.h>\n#include "mylib.h"`);
    expect(symbols.imports.length).toBe(2);
    expect(symbols.imports[0].source).toBe('stdio.h');
    expect(symbols.imports[0].cInclude).toBe(true);
    expect(symbols.imports[1].source).toBe('mylib.h');
  });

  it('extracts function calls', () => {
    const symbols = parseC(`void f() { printf("hello"); }`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'printf' }));
  });

  it('extracts calls with receiver', () => {
    const symbols = parseC(`void f() { obj->method(); }`);
    const call = symbols.calls.find((c) => c.name === 'method');
    expect(call).toBeDefined();
    expect(call.receiver).toBe('obj');
  });
});
