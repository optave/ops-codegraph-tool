import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractLuaSymbols } from '../../src/domain/parser.js';

describe('Lua parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseLua(code) {
    const parser = parsers.get('lua');
    if (!parser) throw new Error('Lua parser not available');
    const tree = parser.parse(code);
    return extractLuaSymbols(tree, 'test.lua');
  }

  it('extracts function declarations', () => {
    const symbols = parseLua(`function greet(name)
  return "Hello " .. name
end`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function' }),
    );
  });

  it('extracts local function declarations', () => {
    const symbols = parseLua(`local function helper(x)
  return x + 1
end`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'helper', kind: 'function' }),
    );
  });

  it('extracts method declarations (colon syntax)', () => {
    const symbols = parseLua(`function MyClass:init(name)
  self.name = name
end`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'MyClass.init', kind: 'method' }),
    );
  });

  it('extracts require calls as imports', () => {
    const symbols = parseLua(`local json = require("cjson")`);
    expect(symbols.imports).toContainEqual(expect.objectContaining({ source: 'cjson' }));
  });

  it('extracts function calls', () => {
    const symbols = parseLua(`print("hello")
string.format("%s", name)`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'print' }));
  });
});
