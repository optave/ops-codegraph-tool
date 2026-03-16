/**
 * Extended kind extraction tests (parameters, properties, constants).
 *
 * Validates that each language extractor populates the `children` array
 * on definitions with parameter, property, and constant entries.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createParsers,
  extractCSharpSymbols,
  extractGoSymbols,
  extractJavaSymbols,
  extractPHPSymbols,
  extractPythonSymbols,
  extractRubySymbols,
  extractRustSymbols,
  extractSymbols,
} from '../../src/domain/parser.js';

// ── JavaScript ──────────────────────────────────────────────────────────────

describe('JavaScript extended kinds', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseJS(code) {
    const parser = parsers.get('javascript');
    const tree = parser.parse(code);
    return extractSymbols(tree, 'test.js');
  }

  describe('parameter extraction', () => {
    it('extracts parameters from function declarations', () => {
      const symbols = parseJS('function greet(name, age) { }');
      const greet = symbols.definitions.find((d) => d.name === 'greet');
      expect(greet).toBeDefined();
      expect(greet.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'name', kind: 'parameter' }),
          expect.objectContaining({ name: 'age', kind: 'parameter' }),
        ]),
      );
    });

    it('extracts parameters from arrow functions', () => {
      const symbols = parseJS('const add = (a, b) => a + b;');
      const add = symbols.definitions.find((d) => d.name === 'add');
      expect(add).toBeDefined();
      expect(add.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'a', kind: 'parameter' }),
          expect.objectContaining({ name: 'b', kind: 'parameter' }),
        ]),
      );
    });

    it('extracts parameters from class methods', () => {
      const symbols = parseJS('class Foo { bar(x, y) {} }');
      const bar = symbols.definitions.find((d) => d.name === 'Foo.bar');
      expect(bar).toBeDefined();
      expect(bar.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'x', kind: 'parameter' }),
          expect.objectContaining({ name: 'y', kind: 'parameter' }),
        ]),
      );
    });
  });

  describe('property extraction', () => {
    it('extracts class field properties', () => {
      const symbols = parseJS('class User { name; age; greet() {} }');
      const user = symbols.definitions.find((d) => d.name === 'User');
      expect(user).toBeDefined();
      expect(user.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'name', kind: 'property' }),
          expect.objectContaining({ name: 'age', kind: 'property' }),
        ]),
      );
    });
  });

  describe('constant extraction', () => {
    it('extracts constant definitions from const declarations', () => {
      const symbols = parseJS('const MAX = 100;');
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'MAX', kind: 'constant' }),
      );
    });
  });
});

// ── Python ──────────────────────────────────────────────────────────────────

describe('Python extended kinds', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parsePython(code) {
    const parser = parsers.get('python');
    if (!parser) throw new Error('Python parser not available');
    const tree = parser.parse(code);
    return extractPythonSymbols(tree, 'test.py');
  }

  describe('parameter extraction', () => {
    it('extracts parameters from function definitions', () => {
      const symbols = parsePython('def greet(name, age=30):\n  pass');
      const greet = symbols.definitions.find((d) => d.name === 'greet');
      expect(greet).toBeDefined();
      expect(greet.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'name', kind: 'parameter' }),
          expect.objectContaining({ name: 'age', kind: 'parameter' }),
        ]),
      );
    });
  });

  describe('property extraction', () => {
    it('extracts properties from __init__ self assignments', () => {
      const symbols = parsePython(
        ['class User:', '  def __init__(self, x, y):', '    self.x = x', '    self.y = y'].join(
          '\n',
        ),
      );
      const user = symbols.definitions.find((d) => d.name === 'User');
      expect(user).toBeDefined();
      expect(user.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'x', kind: 'property' }),
          expect.objectContaining({ name: 'y', kind: 'property' }),
        ]),
      );
    });
  });

  describe('constant extraction', () => {
    it('extracts module-level UPPER_CASE constants', () => {
      const symbols = parsePython('MAX_RETRIES = 3');
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'MAX_RETRIES', kind: 'constant' }),
      );
    });
  });
});

// ── Go ──────────────────────────────────────────────────────────────────────

describe('Go extended kinds', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseGo(code) {
    const parser = parsers.get('go');
    if (!parser) throw new Error('Go parser not available');
    const tree = parser.parse(code);
    return extractGoSymbols(tree, 'test.go');
  }

  describe('parameter extraction', () => {
    it('extracts parameters from function declarations', () => {
      const symbols = parseGo('package main\nfunc add(a int, b int) int { return a + b }');
      const add = symbols.definitions.find((d) => d.name === 'add');
      expect(add).toBeDefined();
      expect(add.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'a', kind: 'parameter' }),
          expect.objectContaining({ name: 'b', kind: 'parameter' }),
        ]),
      );
    });
  });

  describe('property extraction', () => {
    it('extracts struct fields as properties', () => {
      const symbols = parseGo('package main\ntype User struct {\n  Name string\n  Age int\n}');
      const user = symbols.definitions.find((d) => d.name === 'User');
      expect(user).toBeDefined();
      expect(user.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Name', kind: 'property' }),
          expect.objectContaining({ name: 'Age', kind: 'property' }),
        ]),
      );
    });
  });

  describe('constant extraction', () => {
    it('extracts const declarations', () => {
      const symbols = parseGo('package main\nconst MaxRetries = 3');
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'MaxRetries', kind: 'constant' }),
      );
    });
  });
});

// ── Rust ─────────────────────────────────────────────────────────────────────

describe('Rust extended kinds', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseRust(code) {
    const parser = parsers.get('rust');
    if (!parser) throw new Error('Rust parser not available');
    const tree = parser.parse(code);
    return extractRustSymbols(tree, 'test.rs');
  }

  describe('parameter extraction', () => {
    it('extracts parameters from function declarations', () => {
      const symbols = parseRust('fn add(a: i32, b: i32) -> i32 { a + b }');
      const add = symbols.definitions.find((d) => d.name === 'add');
      expect(add).toBeDefined();
      expect(add.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'a', kind: 'parameter' }),
          expect.objectContaining({ name: 'b', kind: 'parameter' }),
        ]),
      );
    });
  });

  describe('property extraction', () => {
    it('extracts struct fields as properties', () => {
      const symbols = parseRust('struct User { name: String, age: u32 }');
      const user = symbols.definitions.find((d) => d.name === 'User');
      expect(user).toBeDefined();
      expect(user.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'name', kind: 'property' }),
          expect.objectContaining({ name: 'age', kind: 'property' }),
        ]),
      );
    });
  });

  describe('constant extraction', () => {
    it('extracts const item declarations', () => {
      const symbols = parseRust('const MAX: i32 = 100;');
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'MAX', kind: 'constant' }),
      );
    });

    it('extracts enum variants as constant children', () => {
      const symbols = parseRust('enum Color { Red, Green, Blue }');
      const color = symbols.definitions.find((d) => d.name === 'Color');
      expect(color).toBeDefined();
      expect(color.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Red', kind: 'constant' }),
          expect.objectContaining({ name: 'Green', kind: 'constant' }),
          expect.objectContaining({ name: 'Blue', kind: 'constant' }),
        ]),
      );
    });
  });
});

// ── Java ─────────────────────────────────────────────────────────────────────

describe('Java extended kinds', () => {
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

  describe('parameter extraction', () => {
    it('extracts method parameters', () => {
      const symbols = parseJava('class Foo { void bar(int x, String y) {} }');
      const bar = symbols.definitions.find((d) => d.name === 'Foo.bar');
      expect(bar).toBeDefined();
      expect(bar.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'x', kind: 'parameter' }),
          expect.objectContaining({ name: 'y', kind: 'parameter' }),
        ]),
      );
    });
  });

  describe('property extraction', () => {
    it('extracts class field declarations as properties', () => {
      const symbols = parseJava('class User { String name; int age; }');
      const user = symbols.definitions.find((d) => d.name === 'User');
      expect(user).toBeDefined();
      expect(user.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'name', kind: 'property' }),
          expect.objectContaining({ name: 'age', kind: 'property' }),
        ]),
      );
    });
  });

  describe('constant extraction', () => {
    it('extracts enum constants as children', () => {
      const symbols = parseJava('enum Status { ACTIVE, INACTIVE }');
      const status = symbols.definitions.find((d) => d.name === 'Status');
      expect(status).toBeDefined();
      expect(status.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'ACTIVE', kind: 'constant' }),
          expect.objectContaining({ name: 'INACTIVE', kind: 'constant' }),
        ]),
      );
    });
  });
});

// ── C# ──────────────────────────────────────────────────────────────────────

describe('C# extended kinds', () => {
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

  describe('parameter extraction', () => {
    it('extracts method parameters', () => {
      const symbols = parseCSharp('class Foo { void Bar(int x, string y) {} }');
      const bar = symbols.definitions.find((d) => d.name === 'Foo.Bar');
      expect(bar).toBeDefined();
      expect(bar.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'x', kind: 'parameter' }),
          expect.objectContaining({ name: 'y', kind: 'parameter' }),
        ]),
      );
    });
  });

  describe('property extraction', () => {
    it('extracts class field declarations as properties', () => {
      const symbols = parseCSharp('class User { string Name; int Age; }');
      const user = symbols.definitions.find((d) => d.name === 'User');
      expect(user).toBeDefined();
      expect(user.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Name', kind: 'property' }),
          expect.objectContaining({ name: 'Age', kind: 'property' }),
        ]),
      );
    });
  });

  describe('constant extraction', () => {
    it('extracts enum member declarations as constants', () => {
      const symbols = parseCSharp('enum Status { Active, Inactive }');
      const status = symbols.definitions.find((d) => d.name === 'Status');
      expect(status).toBeDefined();
      expect(status.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Active', kind: 'constant' }),
          expect.objectContaining({ name: 'Inactive', kind: 'constant' }),
        ]),
      );
    });
  });
});

// ── Ruby ─────────────────────────────────────────────────────────────────────

describe('Ruby extended kinds', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseRuby(code) {
    const parser = parsers.get('ruby');
    if (!parser) throw new Error('Ruby parser not available');
    const tree = parser.parse(code);
    return extractRubySymbols(tree, 'test.rb');
  }

  describe('parameter extraction', () => {
    it('extracts method parameters', () => {
      const symbols = parseRuby('def greet(name, age)\nend');
      const greet = symbols.definitions.find((d) => d.name === 'greet');
      expect(greet).toBeDefined();
      expect(greet.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'name', kind: 'parameter' }),
          expect.objectContaining({ name: 'age', kind: 'parameter' }),
        ]),
      );
    });
  });

  describe('property extraction', () => {
    it('extracts instance variable assignments as properties', () => {
      const symbols = parseRuby('class User\n  @name = nil\nend');
      const user = symbols.definitions.find((d) => d.name === 'User');
      expect(user).toBeDefined();
      expect(user.children).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: '@name', kind: 'property' })]),
      );
    });
  });

  describe('constant extraction', () => {
    it('extracts class-level constant assignments', () => {
      const symbols = parseRuby('class Foo\n  MAX = 100\nend');
      const foo = symbols.definitions.find((d) => d.name === 'Foo');
      expect(foo).toBeDefined();
      expect(foo.children).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'MAX', kind: 'constant' })]),
      );
    });
  });
});

// ── PHP ──────────────────────────────────────────────────────────────────────

describe('PHP extended kinds', () => {
  let parsers;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parsePHP(code) {
    const parser = parsers.get('php');
    if (!parser) throw new Error('PHP parser not available');
    const tree = parser.parse(code);
    return extractPHPSymbols(tree, 'test.php');
  }

  describe('parameter extraction', () => {
    it('extracts function parameters', () => {
      const symbols = parsePHP('<?php\nfunction greet($name, $age) {}');
      const greet = symbols.definitions.find((d) => d.name === 'greet');
      expect(greet).toBeDefined();
      expect(greet.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: '$name', kind: 'parameter' }),
          expect.objectContaining({ name: '$age', kind: 'parameter' }),
        ]),
      );
    });
  });

  describe('property extraction', () => {
    it('extracts class property declarations', () => {
      const symbols = parsePHP('<?php\nclass User { public $name; public $age; }');
      const user = symbols.definitions.find((d) => d.name === 'User');
      expect(user).toBeDefined();
      expect(user.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: '$name', kind: 'property' }),
          expect.objectContaining({ name: '$age', kind: 'property' }),
        ]),
      );
    });
  });

  describe('constant extraction', () => {
    it('extracts enum case declarations as constants', () => {
      const symbols = parsePHP('<?php\nenum Status { case Active; case Inactive; }');
      const status = symbols.definitions.find((d) => d.name === 'Status');
      expect(status).toBeDefined();
      expect(status.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Active', kind: 'constant' }),
          expect.objectContaining({ name: 'Inactive', kind: 'constant' }),
        ]),
      );
    });
  });
});
