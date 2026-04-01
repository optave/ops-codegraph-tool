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
});
