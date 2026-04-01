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
});
