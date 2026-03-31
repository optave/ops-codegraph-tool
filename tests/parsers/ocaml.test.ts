import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractOCamlSymbols } from '../../src/domain/parser.js';

describe('OCaml parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseOCaml(code) {
    const parser = parsers.get('ocaml');
    if (!parser) throw new Error('OCaml parser not available');
    const tree = parser.parse(code);
    return extractOCamlSymbols(tree, 'test.ml');
  }

  it('extracts let function definitions', () => {
    const symbols = parseOCaml(`let greet name = "Hello " ^ name`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function' }),
    );
  });

  it('extracts let value definitions', () => {
    const symbols = parseOCaml(`let pi = 3.14159`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'pi', kind: 'variable' }),
    );
  });

  it('extracts module definitions', () => {
    const symbols = parseOCaml(`module MyModule = struct
  let x = 1
end`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'MyModule', kind: 'module' }),
    );
  });

  it('extracts type definitions', () => {
    const symbols = parseOCaml(`type color = Red | Green | Blue`);
    expect(symbols.definitions).toContainEqual(expect.objectContaining({ kind: 'type' }));
  });

  it('extracts open statements as imports', () => {
    const symbols = parseOCaml(`open Printf`);
    expect(symbols.imports).toContainEqual(expect.objectContaining({ source: 'Printf' }));
  });

  it('extracts function applications as calls', () => {
    const symbols = parseOCaml(`let () = print_endline "Hello"`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'print_endline' }));
  });
});
