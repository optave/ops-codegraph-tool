import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractKotlinSymbols } from '../../src/domain/parser.js';

describe('Kotlin parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseKotlin(code) {
    const parser = parsers.get('kotlin');
    if (!parser) throw new Error('Kotlin parser not available');
    const tree = parser.parse(code);
    return extractKotlinSymbols(tree, 'Test.kt');
  }

  it('extracts function declarations', () => {
    const symbols = parseKotlin(`fun greet(name: String): String = "Hello"`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function' }),
    );
  });

  it('extracts class declarations', () => {
    const symbols = parseKotlin(`class User { }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User', kind: 'class', line: 1 }),
    );
  });

  it('extracts class with methods', () => {
    const symbols = parseKotlin(`class User {
  fun getName(): String = "Alice"
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User', kind: 'class' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User.getName', kind: 'method' }),
    );
  });

  it('extracts interface declarations', () => {
    const symbols = parseKotlin(`interface Serializable { fun serialize(): String }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Serializable', kind: 'interface', line: 1 }),
    );
  });

  it('extracts object declarations', () => {
    const symbols = parseKotlin(`object Config { }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Config', kind: 'module', line: 1 }),
    );
  });

  it('extracts inheritance', () => {
    const symbols = parseKotlin(`open class Animal\nclass Dog : Animal() { }`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'Dog', extends: 'Animal' }),
    );
  });

  it('extracts imports', () => {
    const symbols = parseKotlin(`import kotlin.collections.Map\nclass Foo { }`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ kotlinImport: true }),
    );
  });

  it('extracts function calls', () => {
    const symbols = parseKotlin(`fun foo() { println("hello"); bar() }`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'println' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'bar' }));
  });
});
