import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractRustSymbols } from '../../src/parser.js';

describe('Rust parser', () => {
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

  it('extracts function declarations', () => {
    const symbols = parseRust(`fn greet(name: &str) -> String { format!("hello {}", name) }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function', line: 1 }),
    );
  });

  it('extracts struct declarations', () => {
    const symbols = parseRust(`struct User { name: String, age: u32 }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User', kind: 'class' }),
    );
  });

  it('extracts enum declarations', () => {
    const symbols = parseRust(`enum Color { Red, Green, Blue }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Color', kind: 'class' }),
    );
  });

  it('extracts trait declarations', () => {
    const symbols = parseRust(`trait Drawable { fn draw(&self); fn area(&self) -> f64; }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Drawable', kind: 'interface' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Drawable.draw', kind: 'method' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Drawable.area', kind: 'method' }),
    );
  });

  it('extracts impl methods', () => {
    const symbols = parseRust(`
struct Server {}
impl Server {
    fn new() -> Self { Server {} }
    fn start(&self) {}
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Server.new', kind: 'method' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Server.start', kind: 'method' }),
    );
  });

  it('extracts trait impl as implements edge', () => {
    const symbols = parseRust(`
trait Display {}
struct Foo {}
impl Display for Foo {}`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'Foo', implements: 'Display' }),
    );
  });

  it('extracts use declarations', () => {
    const symbols = parseRust(`use std::io::Read;`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ source: 'std::io::Read', names: ['Read'] }),
    );
  });

  it('extracts grouped use declarations', () => {
    const symbols = parseRust(`use std::collections::{HashMap, HashSet};`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({
        source: 'std::collections',
        names: expect.arrayContaining(['HashMap', 'HashSet']),
      }),
    );
  });

  it('extracts call expressions', () => {
    const symbols = parseRust(`fn main() { let v = Vec::new(); v.push(1); greet("hi"); }`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'new' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'push' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'greet' }));
  });

  it('extracts macro invocations', () => {
    const symbols = parseRust(`fn main() { println!("hello"); vec![1, 2, 3]; }`);
    const macros = symbols.calls.filter((c) => c.name.endsWith('!'));
    expect(macros.length).toBeGreaterThanOrEqual(1);
    expect(macros).toContainEqual(expect.objectContaining({ name: 'println!' }));
  });
});
