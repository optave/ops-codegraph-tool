import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractGleamSymbols } from '../../src/domain/parser.js';

describe('Gleam parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseGleam(code) {
    const parser = parsers.get('gleam');
    if (!parser) throw new Error('Gleam parser not available');
    const tree = parser.parse(code);
    return extractGleamSymbols(tree, 'test.gleam');
  }

  it('extracts public function definitions', () => {
    const symbols = parseGleam(`pub fn greet(name: String) -> String {
  "Hello " <> name
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function' }),
    );
  });

  it('extracts type definitions', () => {
    const symbols = parseGleam(`pub type Color {
  Red
  Green
  Blue
}`);
    expect(symbols.definitions).toContainEqual(expect.objectContaining({ kind: 'type' }));
  });

  it('extracts imports', () => {
    const symbols = parseGleam(`import gleam/io
import gleam/string`);
    expect(symbols.imports.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts function calls', () => {
    const symbols = parseGleam(`pub fn main() {
  io.println("Hello")
}`);
    expect(symbols.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts external function parameters as children', () => {
    const symbols = parseGleam(
      `pub external fn parse(input: String, base: Int) -> Int = "erlang_mod" "parse"`,
    );
    const parseFn = symbols.definitions.find((d) => d.name === 'parse');
    expect(parseFn).toBeDefined();
    expect(parseFn?.kind).toBe('function');
    expect(parseFn?.children).toBeDefined();
    const names = parseFn?.children?.map((c) => c.name) ?? [];
    expect(names).toContain('input');
    expect(names).toContain('base');
    expect(parseFn?.children?.every((c) => c.kind === 'parameter')).toBe(true);
  });

  it('omits children for external functions with type-only parameters', () => {
    // Type-only params: parameter nodes exist in the tree but lack a `name` field,
    // so extractParams returns an empty list and `children` is omitted.
    const symbols = parseGleam(`pub external fn random(Int, String) -> Int = "rand" "uniform"`);
    const randomFn = symbols.definitions.find((d) => d.name === 'random');
    expect(randomFn).toBeDefined();
    expect(randomFn?.children).toBeUndefined();
  });
});
