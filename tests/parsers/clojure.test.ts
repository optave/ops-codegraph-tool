import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractClojureSymbols } from '../../src/domain/parser.js';

describe('Clojure parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseClojure(code) {
    const parser = parsers.get('clojure');
    if (!parser) throw new Error('Clojure parser not available');
    const tree = parser.parse(code);
    return extractClojureSymbols(tree, 'test.clj');
  }

  it('extracts namespace definitions', () => {
    const symbols = parseClojure(`(ns myapp.core
  (:require [clojure.string :as str]))`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'myapp.core', kind: 'module' }),
    );
  });

  it('extracts function definitions', () => {
    const symbols = parseClojure(`(defn greet [name]
  (str "Hello " name))`);
    expect(symbols.definitions).toContainEqual(expect.objectContaining({ kind: 'function' }));
  });

  it('extracts protocol definitions', () => {
    const symbols = parseClojure(`(defprotocol Printable
  (print-it [this]))`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Printable', kind: 'interface' }),
    );
  });

  it('extracts imports from ns form', () => {
    const symbols = parseClojure(`(ns myapp.core
  (:require [clojure.string :as str]
            [clojure.set]))`);
    expect(symbols.imports.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts function calls', () => {
    const symbols = parseClojure(`(println "Hello")
(map inc [1 2 3])`);
    expect(symbols.calls.length).toBeGreaterThanOrEqual(1);
  });
});
