import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractJavaSymbols } from '../../src/parser.js';

describe('Java parser', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseJava(code) {
    const parser = parsers.get('java');
    if (!parser) throw new Error('Java parser not available');
    const tree = parser.parse(code);
    return extractJavaSymbols(tree, 'Test.java');
  }

  it('extracts class declarations', () => {
    const symbols = parseJava(`public class User { }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User', kind: 'class', line: 1 }),
    );
  });

  it('extracts method declarations', () => {
    const symbols = parseJava(`public class Foo {
  public void bar() {}
  private int baz(String s) { return 0; }
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Foo.bar', kind: 'method' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Foo.baz', kind: 'method' }),
    );
  });

  it('extracts constructor declarations', () => {
    const symbols = parseJava(`public class User {
  public User(String name) {}
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User.User', kind: 'method' }),
    );
  });

  it('extracts interface declarations', () => {
    const symbols = parseJava(`public interface Serializable {
  void serialize();
  String deserialize();
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Serializable', kind: 'interface' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Serializable.serialize', kind: 'method' }),
    );
  });

  it('extracts enum declarations', () => {
    const symbols = parseJava(`public enum Color { RED, GREEN, BLUE }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Color', kind: 'enum' }),
    );
  });

  it('extracts extends relationship', () => {
    const symbols = parseJava(`public class Admin extends User { }`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'Admin', extends: 'User' }),
    );
  });

  it('extracts implements relationship', () => {
    const symbols = parseJava(`public class UserService implements Serializable { }`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'UserService', implements: 'Serializable' }),
    );
  });

  it('extracts import declarations', () => {
    const symbols = parseJava(`import java.util.List;
import java.io.IOException;
public class Foo {}`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ source: 'java.util.List', names: ['List'] }),
    );
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ source: 'java.io.IOException', names: ['IOException'] }),
    );
  });

  it('extracts method invocations', () => {
    const symbols = parseJava(`public class Foo {
  void run() {
    System.out.println("hello");
    doSomething();
    list.add("item");
  }
}`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'println' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'doSomething' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'add' }));
  });

  it('extracts object creation expressions', () => {
    const symbols = parseJava(`public class Foo {
  void run() { User u = new User("Alice"); }
}`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'User' }));
  });
});
