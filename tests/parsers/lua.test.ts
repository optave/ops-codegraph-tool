import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractLuaSymbols } from '../../src/domain/parser.js';
import { LUA_BUILTIN_GLOBALS } from '../../src/extractors/lua.js';

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

  describe('builtin/global reassignment value-ref extraction (#1776)', () => {
    it('extracts a value-ref call for a function assigned to a builtin global', () => {
      const symbols = parseLua(`
        local function traced_require(modname)
          return modname
        end
        require = traced_require
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({
          name: 'traced_require',
          dynamic: true,
          dynamicKind: 'value-ref',
        }),
      );
    });

    it('extracts a value-ref call for the local-shadow form of the same pattern', () => {
      const symbols = parseLua(`
        local function traced_require(modname)
          return modname
        end
        local require = traced_require
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({
          name: 'traced_require',
          dynamic: true,
          dynamicKind: 'value-ref',
        }),
      );
    });

    it('does not extract a value-ref call when the LHS is not a recognized builtin', () => {
      const symbols = parseLua(`
        local function helper() end
        myCustomGlobal = helper
      `);
      expect(symbols.calls.filter((c) => c.dynamicKind === 'value-ref')).toHaveLength(0);
    });

    it('does not extract a value-ref call when the RHS is itself a builtin', () => {
      const symbols = parseLua(`print = tostring`);
      expect(symbols.calls.filter((c) => c.dynamicKind === 'value-ref')).toHaveLength(0);
    });

    it('does not extract a value-ref call for a local (non-builtin) alias', () => {
      const symbols = parseLua(`
        local function helper() end
        local orig_helper = helper
      `);
      expect(symbols.calls.filter((c) => c.dynamicKind === 'value-ref')).toHaveLength(0);
    });

    it('does not extract a value-ref call when the RHS is a call expression', () => {
      const symbols = parseLua(`require = wrapRequire(require)`);
      expect(symbols.calls.filter((c) => c.dynamicKind === 'value-ref')).toHaveLength(0);
    });

    it('does not extract a value-ref call when the RHS is a member expression', () => {
      const symbols = parseLua(`require = mymodule.customRequire`);
      expect(symbols.calls.filter((c) => c.dynamicKind === 'value-ref')).toHaveLength(0);
    });

    it('pairs multi-assignment positionally, matching Lua assignment semantics', () => {
      // `t.b` (a dot_index_expression, not a plain identifier) occupies
      // position 0 — pairing must not shift, or `require` (position 1)
      // would incorrectly pair with `helperA` (position 0) instead of
      // `helperB` (position 1).
      const symbols = parseLua(`
        local function helperA() end
        local function helperB() end
        t.b, require = helperA, helperB
      `);
      const valueRefs = symbols.calls.filter((c) => c.dynamicKind === 'value-ref');
      expect(valueRefs).toContainEqual(
        expect.objectContaining({ name: 'helperB', dynamicKind: 'value-ref' }),
      );
      expect(valueRefs.some((c) => c.name === 'helperA')).toBe(false);
    });

    it('extracts a value-ref call for a standard-library module table reassignment', () => {
      const symbols = parseLua(`
        local function fakeOs() end
        os = fakeOs
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'fakeOs', dynamic: true, dynamicKind: 'value-ref' }),
      );
    });
  });

  describe('eval/computed-key dynamic-call detection (#1909)', () => {
    it('classifies load(...) as a dynamic eval call', () => {
      const symbols = parseLua(`load(chunk)()`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: '<dynamic:eval>', dynamic: true, dynamicKind: 'eval' }),
      );
    });

    it('classifies loadstring(...) as a dynamic eval call', () => {
      const symbols = parseLua(`loadstring(code)()`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: '<dynamic:eval>', dynamic: true, dynamicKind: 'eval' }),
      );
    });

    it('classifies dofile(...) as a dynamic eval call', () => {
      const symbols = parseLua(`dofile("script.lua")`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: '<dynamic:eval>', dynamic: true, dynamicKind: 'eval' }),
      );
    });

    it('resolves a bracket-index call with a string-literal key directly', () => {
      const symbols = parseLua(`t["handler"]()`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'handler', receiver: 't' }),
      );
      expect(symbols.calls.some((c) => c.dynamicKind === 'computed-key')).toBe(false);
    });

    it('resolves a bracket-index call with a single-quoted string-literal key directly', () => {
      const symbols = parseLua(`t['handler']()`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'handler', receiver: 't' }),
      );
    });

    it('classifies a bracket-index call with a variable key as computed-key', () => {
      const symbols = parseLua(`t[k]()`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({
          name: '<dynamic:computed-key>',
          dynamic: true,
          dynamicKind: 'computed-key',
          keyExpr: 'k',
          receiver: 't',
        }),
      );
    });

    it('classifies a bracket-index call with an expression key as computed-key', () => {
      const symbols = parseLua(`handlers[eventName .. "Handler"]()`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({
          dynamic: true,
          dynamicKind: 'computed-key',
          receiver: 'handlers',
        }),
      );
    });
  });
});

describe('LUA_BUILTIN_GLOBALS cross-engine parity', () => {
  // Greptile follow-up (#1912): the allowlist is duplicated in lua.rs and
  // lua.ts with only a prose comment linking them. If one drifts, native and
  // WASM silently disagree on which reassignments produce a value-ref edge.
  // This reads the Rust list as text (it can't be imported into a JS test)
  // and diffs it against the real TS Set, so any future one-sided edit fails
  // CI instead of shipping a silent engine divergence.
  it('matches the Rust extractor allowlist exactly', () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const rustSource = fs.readFileSync(
      path.join(__dirname, '../../crates/codegraph-core/src/extractors/lua.rs'),
      'utf8',
    );
    const match = /const LUA_BUILTIN_GLOBALS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rustSource);
    expect(match, 'LUA_BUILTIN_GLOBALS array not found in lua.rs').not.toBeNull();

    const rustNames = [...match![1].matchAll(/"([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
    expect(
      rustNames.length,
      'regex extracted zero names from lua.rs — pattern likely stale',
    ).toBeGreaterThan(0);

    const rustSet = new Set(rustNames);
    expect(rustSet.size, 'lua.rs has duplicate entries').toBe(rustNames.length);

    const missingFromRust = [...LUA_BUILTIN_GLOBALS].filter((n) => !rustSet.has(n));
    const missingFromTs = rustNames.filter((n) => !LUA_BUILTIN_GLOBALS.has(n));
    expect(missingFromRust, 'present in lua.ts but missing from lua.rs').toEqual([]);
    expect(missingFromTs, 'present in lua.rs but missing from lua.ts').toEqual([]);
  });
});
