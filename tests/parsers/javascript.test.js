/**
 * JavaScript/TypeScript parser tests.
 *
 * NOTE: These tests require vitest and web-tree-sitter to be installed.
 * Run: npm install
 * Then: npm test
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createParsers, getParser, extractSymbols } from '../../src/parser.js';

describe('JavaScript parser', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseJS(code) {
    const parser = parsers.jsParser;
    const tree = parser.parse(code);
    return extractSymbols(tree, 'test.js');
  }

  it('extracts named function declarations', () => {
    const symbols = parseJS(`function greet(name) { return "hello " + name; }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function', line: 1 })
    );
  });

  it('extracts arrow function assignments', () => {
    const symbols = parseJS(`const add = (a, b) => a + b;`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'add', kind: 'function' })
    );
  });

  it('extracts class declarations', () => {
    const symbols = parseJS(`class Foo { bar() {} }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Foo', kind: 'class' })
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Foo.bar', kind: 'method' })
    );
  });

  it('extracts import statements', () => {
    const symbols = parseJS(`import { foo, bar } from './baz';`);
    expect(symbols.imports).toHaveLength(1);
    expect(symbols.imports[0].source).toBe('./baz');
    expect(symbols.imports[0].names).toContain('foo');
    expect(symbols.imports[0].names).toContain('bar');
  });

  it('extracts call expressions', () => {
    const symbols = parseJS(`import { foo } from './bar'; foo(); baz();`);
    expect(symbols.calls).toContainEqual(
      expect.objectContaining({ name: 'foo' })
    );
    expect(symbols.calls).toContainEqual(
      expect.objectContaining({ name: 'baz' })
    );
  });

  it('handles re-exports from barrel files', () => {
    const symbols = parseJS(`export { default as Widget } from './Widget';`);
    expect(symbols.imports).toHaveLength(1);
    expect(symbols.imports[0].reexport).toBe(true);
  });

  it('detects dynamic call patterns', () => {
    const symbols = parseJS(`fn.call(null, arg); obj.apply(undefined, args);`);
    const dynamicCalls = symbols.calls.filter(c => c.dynamic);
    expect(dynamicCalls.length).toBeGreaterThanOrEqual(1);
  });
});
