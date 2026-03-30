import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractScalaSymbols } from '../../src/domain/parser.js';

describe('Scala parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseScala(code) {
    const parser = parsers.get('scala');
    if (!parser) throw new Error('Scala parser not available');
    const tree = parser.parse(code);
    return extractScalaSymbols(tree, 'Test.scala');
  }

  it('extracts function definitions', () => {
    const symbols = parseScala(`def greet(name: String): String = "Hello"`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function' }),
    );
  });

  it('extracts class definitions', () => {
    const symbols = parseScala(`class User { }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User', kind: 'class', line: 1 }),
    );
  });

  it('extracts class with methods', () => {
    const symbols = parseScala(`class User {
  def getName(): String = "Alice"
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User', kind: 'class' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User.getName', kind: 'method' }),
    );
  });

  it('extracts trait definitions', () => {
    const symbols = parseScala(`trait Serializable { def serialize(): String }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Serializable', kind: 'trait', line: 1 }),
    );
  });

  it('extracts object definitions', () => {
    const symbols = parseScala(`object Config { }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Config', kind: 'module', line: 1 }),
    );
  });

  it('extracts inheritance', () => {
    const symbols = parseScala(`class Admin extends User { }`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'Admin', extends: 'User' }),
    );
  });

  it('extracts imports', () => {
    const symbols = parseScala(`import scala.collection.mutable.Map
class Foo { }`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ scalaImport: true }),
    );
  });

  it('extracts function calls', () => {
    const symbols = parseScala(`def foo(): Unit = { println("hello"); bar() }`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'println' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'bar' }));
  });
});
