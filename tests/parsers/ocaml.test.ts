import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractOCamlSymbols } from '../../src/domain/parser.js';

describe('OCaml parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseOCaml(code: string) {
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

  it('extracts external declarations as functions', () => {
    const symbols = parseOCaml(
      `external unsafe_get : string -> int -> char = "%string_unsafe_get"`,
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'unsafe_get', kind: 'function' }),
    );
  });

  it('extracts exception definitions as types', () => {
    const symbols = parseOCaml(`exception Not_found`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Not_found', kind: 'type' }),
    );
  });

  it('extracts exception aliases as types', () => {
    const symbols = parseOCaml(`exception Foo = Bar`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Foo', kind: 'type' }),
    );
  });

  it('extracts module type definitions as interfaces', () => {
    const symbols = parseOCaml(`module type S = sig
  val x : int
end`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'S', kind: 'interface' }),
    );
  });
});

describe('OCaml interface parser (.mli)', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseOCamlInterface(code: string) {
    const parser = parsers.get('ocaml-interface');
    if (!parser) throw new Error('OCaml interface parser not available');
    const tree = parser.parse(code);
    return extractOCamlSymbols(tree, 'test.mli');
  }

  it('extracts val specifications as functions', () => {
    const symbols = parseOCamlInterface(`val greet : string -> string`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function' }),
    );
  });

  it('extracts val specifications without arrow as variables', () => {
    const symbols = parseOCamlInterface(`val pi : float`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'pi', kind: 'variable' }),
    );
  });

  it('extracts external declarations as functions', () => {
    const symbols = parseOCamlInterface(
      `external length : string -> int = "caml_ml_string_length"`,
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'length', kind: 'function' }),
    );
  });

  it('extracts module type definitions', () => {
    const symbols = parseOCamlInterface(`module type S = sig
  val x : int
end`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'S', kind: 'interface' }),
    );
  });

  it('extracts exception definitions', () => {
    const symbols = parseOCamlInterface(`exception Not_found`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Not_found', kind: 'type' }),
    );
  });

  it('extracts type definitions in interfaces', () => {
    const symbols = parseOCamlInterface(`type color = Red | Green | Blue`);
    expect(symbols.definitions).toContainEqual(expect.objectContaining({ kind: 'type' }));
  });

  it('extracts open statements in interfaces', () => {
    const symbols = parseOCamlInterface(`open Printf`);
    expect(symbols.imports).toContainEqual(expect.objectContaining({ source: 'Printf' }));
  });
});
