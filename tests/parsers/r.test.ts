import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractRSymbols } from '../../src/domain/parser.js';

describe('R parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseR(code) {
    const parser = parsers.get('r');
    if (!parser) throw new Error('R parser not available');
    const tree = parser.parse(code);
    return extractRSymbols(tree, 'test.R');
  }

  it('extracts function definitions', () => {
    const symbols = parseR(`greet <- function(name) {
  paste("Hello", name)
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function' }),
    );
  });

  it('extracts function definitions with = assignment', () => {
    const symbols = parseR(`add = function(x, y) {
  x + y
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'add', kind: 'function' }),
    );
  });

  it('extracts library imports', () => {
    const symbols = parseR(`library(dplyr)
require(ggplot2)`);
    expect(symbols.imports.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts function calls', () => {
    const symbols = parseR(`print("Hello")
mean(c(1, 2, 3))`);
    expect(symbols.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts the value (not the parameter name) for named library arguments', () => {
    // `library(package = dplyr)` is rare but valid R. The import source must
    // be `dplyr` (the value), not `package` (the parameter name). Keeps the
    // WASM and native extractors in parity.
    const symbols = parseR(`library(package = dplyr)`);
    expect(symbols.imports).toContainEqual(expect.objectContaining({ source: 'dplyr' }));
    expect(symbols.imports.some((i) => i.source === 'package')).toBe(false);
  });

  it('extracts source() imports', () => {
    // Parity guard: native produces an import with `source: "service.R"`.
    // The WASM extractor previously failed silently for the same reason as
    // setClass/setGeneric — it didn't unwrap the `argument` node.
    const symbols = parseR(`source("service.R")`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ source: 'service.R', names: ['source'] }),
    );
  });

  it('extracts a class definition from setClass', () => {
    // Parity guard: the native extractor produces a `class` definition for
    // `setClass(...)`; the WASM extractor previously failed silently because
    // it did not unwrap the `argument` node around the string literal.
    const symbols = parseR(`setClass("Person", representation(name = "character"))`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Person', kind: 'class' }),
    );
  });

  it('extracts a function definition from setGeneric', () => {
    // Same parity guard for setGeneric — was silently broken in WASM.
    const symbols = parseR(`setGeneric("doIt", function(x) standardGeneric("doIt"))`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'doIt', kind: 'function' }),
    );
  });

  it('does not duplicate the generic definition when setMethod is present', () => {
    // Idiomatic S4: a setGeneric followed by setMethod implementations.
    // Only setGeneric should emit a function definition — setMethod registers
    // an implementation, which we model as a call edge to the generic.
    const symbols = parseR(`
setGeneric("greet", function(x) standardGeneric("greet"))
setMethod("greet", "Person", function(x) paste("Hello", x@name))
setMethod("greet", "Animal", function(x) paste("Hi", x@species))
`);
    const greetDefs = symbols.definitions.filter((d) => d.name === 'greet');
    expect(greetDefs).toHaveLength(1);
    expect(greetDefs[0]).toMatchObject({ kind: 'function' });
  });

  it('emits a call to the generic for setMethod', () => {
    const symbols = parseR(`setMethod("greet", "Person", function(x) paste("Hello", x@name))`);
    const greetCalls = symbols.calls.filter((c) => c.name === 'greet');
    expect(greetCalls).toHaveLength(1);
  });

  it('still captures calls from inside the setMethod body', () => {
    // The recursive walk visits the anonymous function passed to setMethod,
    // so calls inside the method body must still appear in ctx.calls.
    const symbols = parseR(`setMethod("greet", "Person", function(x) { helper(x); validate(x) })`);
    const names = symbols.calls.map((c) => c.name);
    expect(names).toContain('helper');
    expect(names).toContain('validate');
  });
});
