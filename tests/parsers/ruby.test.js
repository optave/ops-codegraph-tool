import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractRubySymbols } from '../../src/parser.js';

describe('Ruby parser', () => {
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

  it('extracts class declarations', () => {
    const symbols = parseRuby(`class User
end`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'User', kind: 'class', line: 1 }),
    );
  });

  it('extracts method declarations', () => {
    const symbols = parseRuby(`class Foo
  def bar
  end

  def baz(x)
  end
end`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Foo.bar', kind: 'method' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Foo.baz', kind: 'method' }),
    );
  });

  it('extracts standalone methods', () => {
    const symbols = parseRuby(`def greet(name)
  "hello #{name}"
end`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'method' }),
    );
  });

  it('extracts class methods (self.)', () => {
    const symbols = parseRuby(`class Foo
  def self.create
  end
end`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Foo.create', kind: 'function' }),
    );
  });

  it('extracts module declarations', () => {
    const symbols = parseRuby(`module Serializable
  def serialize
  end
end`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Serializable', kind: 'module' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Serializable.serialize', kind: 'method' }),
    );
  });

  it('extracts class inheritance', () => {
    const symbols = parseRuby(`class Admin < User
end`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'Admin', extends: 'User' }),
    );
  });

  it('extracts require statements as imports', () => {
    const symbols = parseRuby(`require 'json'
require_relative 'helpers/utils'`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ source: 'json', names: ['json'] }),
    );
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ source: 'helpers/utils', names: ['utils'] }),
    );
  });

  it('extracts method calls', () => {
    const symbols = parseRuby(`class Foo
  def run
    puts "hello"
    bar.do_something
  end
end`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'puts' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'do_something' }));
  });

  it('extracts module include as implements', () => {
    const symbols = parseRuby(`class User
  include Comparable
  extend ClassMethods
end`);
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'User', implements: 'Comparable' }),
    );
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'User', implements: 'ClassMethods' }),
    );
  });
});
