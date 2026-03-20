import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractCSharpSymbols } from '../../src/domain/parser.js';

describe('C# parser', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseCSharp(code) {
    const parser = parsers.get('csharp');
    if (!parser) throw new Error('C# parser not available');
    const tree = parser.parse(code);
    return extractCSharpSymbols(tree, 'Test.cs');
  }

  it('extracts class declarations', () => {
    const symbols = parseCSharp(`public class User { }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User', kind: 'class', line: 1 }),
    );
  });

  it('extracts method declarations', () => {
    const symbols = parseCSharp(`public class Foo {
  public void Bar() {}
  private int Baz(string s) { return 0; }
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Foo.Bar', kind: 'method' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Foo.Baz', kind: 'method' }),
    );
  });

  it('extracts constructor declarations', () => {
    const symbols = parseCSharp(`public class User {
  public User(string name) {}
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User.User', kind: 'method' }),
    );
  });

  it('extracts interface declarations with methods', () => {
    const symbols = parseCSharp(`public interface ISerializable {
  void Serialize();
  string Deserialize();
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'ISerializable', kind: 'interface' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'ISerializable.Serialize', kind: 'method' }),
    );
  });

  it('extracts enum declarations', () => {
    const symbols = parseCSharp(`public enum Color { Red, Green, Blue }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Color', kind: 'enum' }),
    );
  });

  it('extracts struct declarations', () => {
    const symbols = parseCSharp(`public struct Point { public int X; public int Y; }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Point', kind: 'struct' }),
    );
  });

  it('extracts using directives', () => {
    const symbols = parseCSharp(`using System.Collections.Generic;
using System.IO;
public class Foo {}`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ source: 'System.Collections.Generic', names: ['Generic'] }),
    );
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ source: 'System.IO', names: ['IO'] }),
    );
  });

  it('extracts method invocations', () => {
    const symbols = parseCSharp(`public class Foo {
  void Run() {
    Console.WriteLine("hello");
    DoSomething();
    list.Add("item");
  }
}`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'WriteLine' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'DoSomething' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'Add' }));
  });

  it('extracts object creation expressions', () => {
    const symbols = parseCSharp(`public class Foo {
  void Run() { var u = new User("Alice"); }
}`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'User' }));
  });

  it('classifies same-file interface base types as implements', () => {
    const symbols = parseCSharp(`public interface ISerializable {
  void Serialize();
}
public class User : ISerializable {
  public void Serialize() {}
}`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'User', implements: 'ISerializable' }),
    );
    const extendsEntry = symbols.classes.find(
      (c) => c.name === 'User' && c.extends === 'ISerializable',
    );
    expect(extendsEntry).toBeUndefined();
  });

  it('keeps cross-file base types as extends', () => {
    const symbols = parseCSharp(`public class Admin : BaseUser {
  public void DoAdmin() {}
}`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'Admin', extends: 'BaseUser' }),
    );
  });

  it('handles mixed extends and implements', () => {
    const symbols = parseCSharp(`public interface IDisposable {
  void Dispose();
}
public class Service : BaseService, IDisposable {
  public void Dispose() {}
}`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'Service', implements: 'IDisposable' }),
    );
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'Service', extends: 'BaseService' }),
    );
  });

  it('extracts property declarations', () => {
    const symbols = parseCSharp(`public class User {
  public string Name { get; set; }
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User.Name', kind: 'property' }),
    );
  });
});
