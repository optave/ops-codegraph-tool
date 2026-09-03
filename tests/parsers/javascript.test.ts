/**
 * JavaScript/TypeScript parser tests.
 *
 * NOTE: These tests require vitest and web-tree-sitter to be installed.
 * Run: npm install
 * Then: npm test
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractSymbols } from '../../src/domain/parser.js';
import { setTypeMapEntry } from '../../src/extractors/helpers.js';

describe('JavaScript parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseJS(code) {
    const parser = parsers.get('javascript');
    const tree = parser.parse(code);
    return extractSymbols(tree, 'test.js');
  }

  it('extracts named function declarations', () => {
    const symbols = parseJS(`function greet(name) { return "hello " + name; }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'greet', kind: 'function', line: 1 }),
    );
  });

  it('extracts arrow function assignments', () => {
    const symbols = parseJS(`const add = (a, b) => a + b;`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'add', kind: 'function' }),
    );
  });

  it('extracts generator function declarations', () => {
    const symbols = parseJS(`function* gen() { yield 1; }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'gen', kind: 'function' }),
    );
  });

  it('extracts variable-declared generator functions', () => {
    const symbols = parseJS(`const gen = function*() { yield 1; };`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'gen', kind: 'function' }),
    );
  });

  it('attributes calls inside generator body to the generator', () => {
    // Use multi-line generators so line ranges are non-overlapping and the
    // attribution can be verified by line number containment.
    const symbols = parseJS(
      'function* gen9() {\n  yield* gen8();\n}\nfunction* gen8() { yield 1; }',
    );
    const gen9Def = symbols.definitions.find((d) => d.name === 'gen9');
    const gen8Def = symbols.definitions.find((d) => d.name === 'gen8');
    expect(gen9Def).toBeDefined();
    expect(gen8Def).toBeDefined();

    // The call to gen8 must exist.
    const gen8Call = symbols.calls.find((c) => c.name === 'gen8');
    expect(gen8Call).toBeDefined();

    // The call's line must fall within gen9's range — proving it is attributed
    // to gen9's body, not to file level or to gen8 itself.
    expect(gen8Call!.line).toBeGreaterThanOrEqual(gen9Def!.line);
    expect(gen8Call!.line).toBeLessThanOrEqual(gen9Def!.endLine!);

    // Negative: the call must NOT fall within gen8's own range (not self-attributed).
    const callIsInsideGen8 =
      gen8Call!.line >= gen8Def!.line && gen8Call!.line <= (gen8Def!.endLine ?? gen8Def!.line);
    expect(callIsInsideGen8).toBe(false);
  });

  it('captures calls inside yield* expressions', () => {
    const symbols = parseJS(`function* delegator() { yield* inner(); }`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'inner' }));
  });

  it('extracts class declarations', () => {
    const symbols = parseJS(`class Foo { bar() {} }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Foo', kind: 'class' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Foo.bar', kind: 'method' }),
    );
  });

  it('extracts class field definitions with initializers as method definitions', () => {
    const symbols = parseJS(`class C1 { f8 = () => { return 1; } }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'C1.f8', kind: 'method' }),
    );
  });

  it('extracts static class field definitions as method definitions', () => {
    const symbols = parseJS(`class C6 { static staticProperty = function() {}; }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'C6.staticProperty', kind: 'method' }),
    );
  });

  it('does not extract scalar static field definitions as method definitions', () => {
    const symbols = parseJS(`class C7 { static x = 42; }`);
    const names = symbols.definitions.map((d: { name: string }) => d.name);
    expect(names).not.toContain('C7.x');
  });

  it('extracts static blocks as method definitions with unique names', () => {
    const symbols = parseJS(`class C6 { static { f1(); } static { f2(); } }`);
    // Each static block gets a unique name with line:column suffix to avoid collisions
    const staticDefs = symbols.definitions.filter((d) => d.name.startsWith('C6.<static:'));
    expect(staticDefs).toHaveLength(2);
    expect(staticDefs[0]).toMatchObject({ kind: 'method' });
    expect(staticDefs[1]).toMatchObject({ kind: 'method' });
    // Names must be distinct even on the same line
    expect(staticDefs[0].name).not.toBe(staticDefs[1].name);
  });

  it('extracts import statements', () => {
    const symbols = parseJS(`import { foo, bar } from './baz';`);
    expect(symbols.imports).toHaveLength(1);
    expect(symbols.imports[0].source).toBe('./baz');
    expect(symbols.imports[0].names).toContain('foo');
    expect(symbols.imports[0].names).toContain('bar');
  });

  // Regression coverage for #1730: `import { X as Y }` must record the local
  // binding (Y) — what call sites actually reference — in `names`, plus the
  // `{ local, imported }` rename pair so call-edge resolution can recover the
  // original exported symbol (X) when a call site uses the local alias.
  describe('renamed import specifiers (#1730)', () => {
    it('records the local alias, not the source name, in imports[].names', () => {
      const symbols = parseJS(`import { collectFiles as collectFilesUtil } from './helpers';`);
      expect(symbols.imports).toHaveLength(1);
      expect(symbols.imports[0].names).toEqual(['collectFilesUtil']);
    });

    it('records the local -> original rename pair in renamedImports', () => {
      const symbols = parseJS(`import { collectFiles as collectFilesUtil } from './helpers';`);
      expect(symbols.imports[0].renamedImports).toEqual([
        { local: 'collectFilesUtil', imported: 'collectFiles' },
      ]);
    });

    it('does not set renamedImports for non-renamed specifiers', () => {
      const symbols = parseJS(`import { foo, bar } from './baz';`);
      expect(symbols.imports[0].renamedImports).toBeUndefined();
    });

    it('handles a mix of renamed and non-renamed specifiers in one statement', () => {
      const symbols = parseJS(
        `import { foo, collectFiles as collectFilesUtil, bar } from './mixed';`,
      );
      expect(symbols.imports[0].names).toEqual(['foo', 'collectFilesUtil', 'bar']);
      expect(symbols.imports[0].renamedImports).toEqual([
        { local: 'collectFilesUtil', imported: 'collectFiles' },
      ]);
    });

    it('records the external-alias -> declared-name rename pair for export_specifier (reexport) statements (#1823)', () => {
      // export_specifier semantics differ from import_specifier (name = local
      // declaration being re-exported, alias = external name a consumer of
      // this barrel imports), so `names` keeps recording the declared name
      // (collectFiles) — barrel/reexport tracing keys off it (see
      // resolveBarrelExport). renamedImports separately records the
      // { local: externalAlias, imported: declaredName } pair so barrel
      // resolution can translate a consumer's requested external name back
      // to the declared name.
      const symbols = parseJS(`export { collectFiles as friendlyName } from './helpers';`);
      expect(symbols.imports).toHaveLength(1);
      expect(symbols.imports[0].reexport).toBe(true);
      expect(symbols.imports[0].names).toEqual(['collectFiles']);
      expect(symbols.imports[0].renamedImports).toEqual([
        { local: 'friendlyName', imported: 'collectFiles' },
      ]);
    });

    it('does not set renamedImports for non-renamed export_specifier (reexport) statements', () => {
      const symbols = parseJS(`export { collectFiles } from './helpers';`);
      expect(symbols.imports[0].renamedImports).toBeUndefined();
    });
  });

  describe('inline per-specifier type-only import modifier (#1813)', () => {
    function parseTS(code) {
      const parser = parsers.get('typescript');
      const tree = parser.parse(code);
      return extractSymbols(tree, 'test.ts');
    }

    it('records the type-only specifier in typeOnlyNames for a mixed statement', () => {
      const symbols = parseTS(`import { openRepo, type Repository } from './db';`);
      expect(symbols.imports[0].names).toEqual(['openRepo', 'Repository']);
      expect(symbols.imports[0].typeOnly).toBe(false);
      expect(symbols.imports[0].typeOnlyNames).toEqual(['Repository']);
    });

    it('records the type-only specifier regardless of its position in the statement', () => {
      const symbols = parseTS(`import { type Repository, openRepo } from './db';`);
      expect(symbols.imports[0].typeOnlyNames).toEqual(['Repository']);
    });

    it('records every type-only name when multiple specifiers use the inline modifier', () => {
      const symbols = parseTS(`import { type A, type B, value } from './mixed';`);
      expect(symbols.imports[0].typeOnlyNames).toEqual(['A', 'B']);
    });

    it('recognizes the `typeof` modifier as well as `type`', () => {
      const symbols = parseTS(`import { typeof Z, value } from './mixed';`);
      expect(symbols.imports[0].typeOnlyNames).toEqual(['Z']);
    });

    it('does not set typeOnlyNames when no specifier uses the inline modifier', () => {
      const symbols = parseTS(`import { foo, bar } from './baz';`);
      expect(symbols.imports[0].typeOnlyNames).toBeUndefined();
    });

    it('does not set typeOnlyNames for a whole-statement `import type` (already covered by typeOnly)', () => {
      const symbols = parseTS(`import type { Foo, Bar } from './types';`);
      expect(symbols.imports[0].typeOnly).toBe(true);
      expect(symbols.imports[0].typeOnlyNames).toBeUndefined();
    });

    it('records the local alias, not the source name, for a renamed type-only specifier', () => {
      const symbols = parseTS(`import { type Repository as Repo, openRepo } from './db';`);
      expect(symbols.imports[0].names).toEqual(['Repo', 'openRepo']);
      expect(symbols.imports[0].typeOnlyNames).toEqual(['Repo']);
      expect(symbols.imports[0].renamedImports).toEqual([
        { local: 'Repo', imported: 'Repository' },
      ]);
    });
  });

  describe('dynamic import() destructuring through parens/as-cast wrappers (#1781)', () => {
    function parseTS(code) {
      const parser = parsers.get('typescript');
      const tree = parser.parse(code);
      return extractSymbols(tree, 'test.ts');
    }

    // Before the fix, extractDynamicImportNames walked up from the import()
    // call through at most one optional await_expression before requiring the
    // immediate parent to be a variable_declarator. Wrapping the awaited call
    // in redundant parens and/or a TS `as {...}` cast — exactly the pattern
    // used throughout native-orchestrator.ts — inserted extra
    // parenthesized_expression/as_expression layers that broke the walk-up,
    // so `names` came back empty and the destructured bindings never got
    // credited as real consumers of the target module's exports (#1781).

    it('extracts destructured names from a bare dynamic import (no wrapper)', () => {
      const symbols = parseJS(`const { a, b } = await import('./foo.js');`);
      expect(symbols.imports).toHaveLength(1);
      expect(symbols.imports[0].names).toEqual(['a', 'b']);
      expect(symbols.imports[0].dynamicImport).toBe(true);
    });

    it('extracts destructured names when the awaited import is wrapped in redundant parens', () => {
      const symbols = parseTS(`const { a, b } = (await import('./foo.js'));`);
      expect(symbols.imports).toHaveLength(1);
      expect(symbols.imports[0].names).toEqual(['a', 'b']);
    });

    it('extracts destructured names through a TypeScript `as {...}` type assertion (no parens)', () => {
      const symbols = parseTS(`const { a, b } = await import('./foo.js') as { a: Fn; b: Fn };`);
      expect(symbols.imports).toHaveLength(1);
      expect(symbols.imports[0].names).toEqual(['a', 'b']);
    });

    it('extracts destructured names through a TypeScript `satisfies {...}` assertion', () => {
      // TS 4.9+ `satisfies` is structurally identical to `as` here (Greptile
      // follow-up to #1781) — same walk-up gap would otherwise reproduce.
      const symbols = parseTS(
        `const { a, b } = await import('./foo.js') satisfies { a: Fn; b: Fn };`,
      );
      expect(symbols.imports).toHaveLength(1);
      expect(symbols.imports[0].names).toEqual(['a', 'b']);
    });

    it('extracts destructured names through parens + `as`-cast combined (exact repro shape)', () => {
      // Matches native-orchestrator.ts's actual production pattern:
      //   const { X, Y } = (await import('./mod.js')) as { X: Fn; Y: Fn };
      const symbols = parseTS(`
        const { buildDataflowVerticesFromMap, buildDataflowEdges } =
          (await import('../../../../features/dataflow.js')) as {
            buildDataflowVerticesFromMap: (db: unknown) => number;
            buildDataflowEdges: (db: unknown) => Promise<void>;
          };
      `);
      expect(symbols.imports).toHaveLength(1);
      expect(symbols.imports[0].source).toBe('../../../../features/dataflow.js');
      expect(symbols.imports[0].names).toEqual([
        'buildDataflowVerticesFromMap',
        'buildDataflowEdges',
      ]);
      expect(symbols.imports[0].dynamicImport).toBe(true);
    });

    it('still extracts a single namespace-style binding through parens + as-cast', () => {
      const symbols = parseTS(`const mod = (await import('./foo.js')) as { a: number };`);
      expect(symbols.imports).toHaveLength(1);
      expect(symbols.imports[0].names).toEqual(['mod']);
    });
  });

  describe('dynamic import() destructuring rename (#1824)', () => {
    function parseTS(code) {
      const parser = parsers.get('typescript');
      const tree = parser.parse(code);
      return extractSymbols(tree, 'test.ts');
    }

    // `extractDynamicImportNames`'s pair_pattern branch preferred the
    // tree-sitter `key` field (the name exported by the target module) over
    // `value` (the local binding actually referenced by call sites) — the
    // same class of bug fixed for static `import { X as Y }` specifiers in
    // #1730. `names` must carry the local alias, with the local -> original
    // mapping recorded in `renamedImports` so call-edge resolution can still
    // find the target module's real export.

    it('records the local alias, not the exported name, for a renamed destructure', () => {
      const symbols = parseJS(`const { a: b } = await import('./mod.js');`);
      expect(symbols.imports).toHaveLength(1);
      expect(symbols.imports[0].names).toEqual(['b']);
      expect(symbols.imports[0].renamedImports).toEqual([{ local: 'b', imported: 'a' }]);
    });

    it('handles a mix of renamed and plain destructured bindings', () => {
      const symbols = parseJS(`const { a, realName: alias, c } = await import('./mod.js');`);
      expect(symbols.imports).toHaveLength(1);
      expect(symbols.imports[0].names).toEqual(['a', 'alias', 'c']);
      expect(symbols.imports[0].renamedImports).toEqual([{ local: 'alias', imported: 'realName' }]);
    });

    it('does not record renamedImports when no specifier is renamed', () => {
      const symbols = parseJS(`const { a, b } = await import('./mod.js');`);
      expect(symbols.imports[0].names).toEqual(['a', 'b']);
      expect(symbols.imports[0].renamedImports).toBeUndefined();
    });

    it('records the local alias through a default value on a renamed destructure', () => {
      const symbols = parseJS(`const { a: b = null } = await import('./mod.js');`);
      expect(symbols.imports[0].names).toEqual(['b']);
      expect(symbols.imports[0].renamedImports).toEqual([{ local: 'b', imported: 'a' }]);
    });

    it('records the rename through parens + as-cast wrappers', () => {
      const symbols = parseTS(
        `const { realName: alias } = (await import('./mod.js')) as { realName: Fn };`,
      );
      expect(symbols.imports).toHaveLength(1);
      expect(symbols.imports[0].names).toEqual(['alias']);
      expect(symbols.imports[0].renamedImports).toEqual([{ local: 'alias', imported: 'realName' }]);
    });

    it('strips quotes from a string-literal destructuring key (Greptile follow-up)', () => {
      // `{ 'foo-bar': local }` — the key's raw text includes quotes; using it
      // verbatim as `imported` would make the resolver look for an export
      // literally named `'foo-bar'`, which never matches.
      const symbols = parseJS(`const { 'foo-bar': local } = await import('./mod.js');`);
      expect(symbols.imports[0].names).toEqual(['local']);
      expect(symbols.imports[0].renamedImports).toEqual([{ local: 'local', imported: 'foo-bar' }]);
    });

    it('unwraps a computed string-literal destructuring key the same way', () => {
      const symbols = parseJS(`const { ['foo-bar']: local } = await import('./mod.js');`);
      expect(symbols.imports[0].names).toEqual(['local']);
      expect(symbols.imports[0].renamedImports).toEqual([{ local: 'local', imported: 'foo-bar' }]);
    });

    it('still tracks the local binding for a non-string computed key, without a rename pair', () => {
      // `[Symbol()]` has no statically resolvable export name — the local
      // binding must still be tracked, just without a renamedImports entry.
      const symbols = parseJS(`const { [Symbol()]: local } = await import('./mod.js');`);
      expect(symbols.imports[0].names).toEqual(['local']);
      expect(symbols.imports[0].renamedImports).toBeUndefined();
    });
  });

  describe('dynamic import() destructuring rest/default bindings (#1920)', () => {
    // `extractDynamicImportNames`'s object_pattern branch only recognized
    // shorthand_property_identifier_pattern and pair_pattern children, so a
    // rest element (`...rest`) was silently dropped entirely and a shorthand
    // default (`{ a = 1 }`) produced no name at all (#1920).

    it('extracts a rest binding alongside plain destructured names', () => {
      const symbols = parseJS(`const { a, ...rest } = await import('./mod.js');`);
      expect(symbols.imports).toHaveLength(1);
      expect(symbols.imports[0].names).toEqual(['a', 'rest']);
    });

    it('extracts a shorthand default-value binding', () => {
      const symbols = parseJS(`const { a = 1 } = await import('./mod.js');`);
      expect(symbols.imports).toHaveLength(1);
      expect(symbols.imports[0].names).toEqual(['a']);
    });

    it('extracts a mix of plain, renamed, default, and rest bindings', () => {
      const symbols = parseJS(`const { a, b: alias, c = 1, ...rest } = await import('./mod.js');`);
      expect(symbols.imports).toHaveLength(1);
      expect(symbols.imports[0].names).toEqual(['a', 'alias', 'c', 'rest']);
      expect(symbols.imports[0].renamedImports).toEqual([{ local: 'alias', imported: 'b' }]);
    });

    it('extracts a rest binding from an array-pattern destructure', () => {
      const symbols = parseJS(`const [a, ...rest] = await import('./mod.js');`);
      expect(symbols.imports).toHaveLength(1);
      expect(symbols.imports[0].names).toEqual(['a', 'rest']);
    });
  });

  describe('CJS require() destructuring rest binding (#2037)', () => {
    // `extractCjsRequireBinding`'s object-pattern loop only recognized
    // shorthand_property_identifier_pattern and pair_pattern children, so a
    // rest element (`...rest`) was silently dropped from the CJS-require
    // import-artifact classification (#1661) — a parity gap with Rust's
    // collect_object_pattern_names, which the native require() path already
    // reuses correctly (#2037).

    it('includes the rest binding in cjsRequireBindings alongside plain names', () => {
      const symbols: any = parseJS(`const { a, ...rest } = require('./mod');`);
      expect(symbols.cjsRequireBindings).toEqual([{ names: ['a', 'rest'], source: './mod' }]);
    });

    it('includes a rest binding mixed with a renamed pair', () => {
      const symbols: any = parseJS(`const { a: b, ...rest } = require('./mod');`);
      expect(symbols.cjsRequireBindings).toEqual([{ names: ['b', 'rest'], source: './mod' }]);
    });
  });

  describe('CJS require() array-pattern destructuring (#2268)', () => {
    // `extractCjsRequireBinding` only ever recognized an object_pattern
    // destructure of the require() result — `const [a, b] = require(...)`
    // never got recorded as a CJS-require import artifact at all, in either
    // engine, unlike the object-pattern shape.

    it('records a plain array-pattern require destructure', () => {
      const symbols: any = parseJS(`const [a, b] = require('./mod');`);
      expect(symbols.cjsRequireBindings).toEqual([{ names: ['a', 'b'], source: './mod' }]);
    });

    it('includes a rest binding in an array-pattern require destructure', () => {
      const symbols: any = parseJS(`const [a, ...rest] = require('./mod');`);
      expect(symbols.cjsRequireBindings).toEqual([{ names: ['a', 'rest'], source: './mod' }]);
    });
  });

  it('extracts call expressions', () => {
    const symbols = parseJS(`import { foo } from './bar'; foo(); baz();`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'foo' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'baz' }));
  });

  it('extracts class instantiation as calls', () => {
    const symbols = parseJS(`
      const e = new CodegraphError("msg");
      new Foo();
      throw new ParseError("x");
      const bar = new ns.Bar();
    `);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'CodegraphError' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'Foo' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'ParseError' }));
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'Bar', receiver: 'ns' }));
  });

  it('handles re-exports from barrel files', () => {
    const symbols = parseJS(`export { default as Widget } from './Widget';`);
    expect(symbols.imports).toHaveLength(1);
    expect(symbols.imports[0].reexport).toBe(true);
  });

  it('tags .call()/.apply() on plain identifiers as dynamic/reflection (#1778)', () => {
    // `fn.call(null, arg)` — plain-identifier receiver; the wrapped function is the
    // real callee, but invoking it via .call/.apply is a genuinely reflective
    // mechanism, so it's tagged dynamic/reflection — matching the native Rust engine
    // (Option A of #1778; the WASM extractor previously stripped this tag for
    // identifier receivers only, to work around a dedup-collision bug now fixed
    // narrowly in build-edges.ts's emitDirectCallEdgesForCall, see #1687/#1778).
    const symbols = parseJS(`fn.call(null, arg); obj.apply(undefined, args);`);
    const fnCall = symbols.calls.find((c) => c.name === 'fn');
    expect(fnCall).toBeDefined();
    expect(fnCall.dynamic).toBe(true);
    expect(fnCall.dynamicKind).toBe('reflection');
    const objCall = symbols.calls.find((c) => c.name === 'obj');
    expect(objCall).toBeDefined();
    expect(objCall.dynamic).toBe(true);
    expect(objCall.dynamicKind).toBe('reflection');
  });

  it('captures receiver for method calls', () => {
    const symbols = parseJS(`
      obj.method();
      standalone();
      this.foo();
      arr[0].bar();
      a.b.c();
    `);
    const method = symbols.calls.find((c) => c.name === 'method');
    expect(method).toBeDefined();
    expect(method.receiver).toBe('obj');

    const standalone = symbols.calls.find((c) => c.name === 'standalone');
    expect(standalone).toBeDefined();
    expect(standalone.receiver).toBeUndefined();

    const foo = symbols.calls.find((c) => c.name === 'foo');
    expect(foo).toBeDefined();
    expect(foo.receiver).toBe('this');

    const c = symbols.calls.find((c) => c.name === 'c');
    expect(c).toBeDefined();
    expect(c.receiver).toBe('a.b');
  });

  describe('typeMap extraction', () => {
    function parseTS(code) {
      const parser = parsers.get('typescript');
      const tree = parser.parse(code);
      return extractSymbols(tree, 'test.ts');
    }

    it('extracts typeMap from type annotations with confidence 0.9', () => {
      const symbols = parseTS(`const x: Router = express.Router();`);
      expect(symbols.typeMap).toBeInstanceOf(Map);
      expect(symbols.typeMap.get('x')).toEqual({ type: 'Router', confidence: 0.9 });
    });

    it('extracts typeMap from generic types', () => {
      const symbols = parseTS(`const m: Map<string, number> = new Map();`);
      expect(symbols.typeMap.get('m')).toEqual(
        expect.objectContaining({ type: 'Map', confidence: 1.0 }),
      );
    });

    it('infers type from new expressions with confidence 1.0', () => {
      const symbols = parseTS(`const r = new Router();`);
      expect(symbols.typeMap.get('r')).toEqual({ type: 'Router', confidence: 1.0 });
    });

    it('extracts parameter types into typeMap with confidence 0.9', () => {
      const symbols = parseTS(`function process(req: Request, res: Response) {}`);
      expect(symbols.typeMap.get('req')).toEqual({ type: 'Request', confidence: 0.9 });
      expect(symbols.typeMap.get('res')).toEqual({ type: 'Response', confidence: 0.9 });
    });

    it('extracts class field annotations into class-scoped typeMap key (issue #1458)', () => {
      const symbols = parseTS(`
        class UserService {
          private repo: Repository;
          run() { this.repo.save(); }
        }
      `);
      // Primary: class-scoped key at 0.9 — prevents cross-class collision.
      expect(symbols.typeMap.get('UserService.repo')).toEqual({
        type: 'Repository',
        confidence: 0.9,
      });
      // Fallback bare keys at lower confidence for single-class files.
      expect(symbols.typeMap.get('repo')).toEqual({ type: 'Repository', confidence: 0.6 });
      expect(symbols.typeMap.get('this.repo')).toEqual({ type: 'Repository', confidence: 0.6 });
    });

    it('prevents cross-class collision for same-named fields (issue #1458)', () => {
      const symbols = parseTS(`
        class OrderService {
          private repo: OrderRepository;
        }
        class UserService {
          private repo: UserRepository;
        }
      `);
      // Each class gets its own scoped key — no collision.
      expect(symbols.typeMap.get('OrderService.repo')).toEqual({
        type: 'OrderRepository',
        confidence: 0.9,
      });
      expect(symbols.typeMap.get('UserService.repo')).toEqual({
        type: 'UserRepository',
        confidence: 0.9,
      });
      // Bare "repo" key should hold the first class's type at 0.6 (second write is same confidence, no overwrite).
      expect(symbols.typeMap.get('repo')?.confidence).toBe(0.6);
    });

    it('class expression (None path) seeds bare keys at 0.9, not a class-scoped key (issue #1500)', () => {
      // `const Foo = class { ... }` is a class expression — tree-sitter emits
      // a `class` node (not `class_declaration`), so enclosing_type_map_class /
      // typeMapClass returns null/None and the None branch fires.
      const symbols = parseTS(`
        const Foo = class {
          private repo: Repo;
          run() { this.repo.save(); }
        };
      `);
      // None path: bare keys at full confidence (0.9), no class-scoped key.
      expect(symbols.typeMap.get('repo')).toEqual({ type: 'Repo', confidence: 0.9 });
      expect(symbols.typeMap.get('this.repo')).toEqual({ type: 'Repo', confidence: 0.9 });
      // Must NOT produce a class-scoped key (no class name is available).
      expect(symbols.typeMap.has('Foo.repo')).toBe(false);
    });

    it('seeds a function-scoped key alongside the bare key for a typed parameter (issue #2235)', () => {
      const symbols = parseTS(`function processOrder(db: OrderDb) {}`);
      expect(symbols.typeMap.get('db')).toEqual({ type: 'OrderDb', confidence: 0.9 });
      expect(symbols.typeMap.get('processOrder::db')).toEqual({
        type: 'OrderDb',
        confidence: 0.9,
      });
    });

    it('seeds a function-scoped key alongside the bare key for a typed local (issue #2235)', () => {
      const symbols = parseTS(`function makeOrder() { const db: OrderDb = getDb(); }`);
      expect(symbols.typeMap.get('db')).toEqual({ type: 'OrderDb', confidence: 0.9 });
      expect(symbols.typeMap.get('makeOrder::db')).toEqual({
        type: 'OrderDb',
        confidence: 0.9,
      });
    });

    it('prevents cross-function collision for same-named parameters (issue #2235)', () => {
      const symbols = parseTS(`
        function processOrder(db: OrderDb) { db.commit(); }
        function processUser(db: UserDb) { db.commit(); }
      `);
      // Each function gets its own scoped key — no collision.
      expect(symbols.typeMap.get('processOrder::db')).toEqual({
        type: 'OrderDb',
        confidence: 0.9,
      });
      expect(symbols.typeMap.get('processUser::db')).toEqual({
        type: 'UserDb',
        confidence: 0.9,
      });
      // Bare "db" key holds the first function's type (second write is same
      // confidence, no overwrite) — exactly why the scoped key is needed.
      expect(symbols.typeMap.get('db')).toEqual({ type: 'OrderDb', confidence: 0.9 });
    });

    it('prevents cross-function collision for same-named constructor-typed locals (issue #2235)', () => {
      const symbols = parseTS(`
        function makeOrderConn() { const conn = new OrderDb(); conn.commit(); }
        function makeUserConn() { const conn = new UserDb(); conn.commit(); }
      `);
      expect(symbols.typeMap.get('makeOrderConn::conn')).toEqual({
        type: 'OrderDb',
        confidence: 1.0,
      });
      expect(symbols.typeMap.get('makeUserConn::conn')).toEqual({
        type: 'UserDb',
        confidence: 1.0,
      });
    });

    it('does not seed a typeMap entry for opaque generic type-transform wrappers (issue #2235)', () => {
      // ReturnType<typeof fn>/InstanceType<typeof Ctor>/Parameters<typeof fn>/
      // ConstructorParameters<typeof Ctor> transform their argument into an
      // unrelated type — the wrapper's own name is never a legitimate receiver
      // type, unlike an ordinary generic (`Map<string, number>` → `Map`, still
      // extracted above).
      const symbols = parseTS(`
        function processOrder(db: ReturnType<typeof makeConn>) {}
        function processInstance(x: InstanceType<typeof Ctor>) {}
        function processArgs(a: Parameters<typeof fn>) {}
        function processCtorArgs(a: ConstructorParameters<typeof Ctor>) {}
      `);
      expect(symbols.typeMap.has('db')).toBe(false);
      expect(symbols.typeMap.has('x')).toBe(false);
      expect(symbols.typeMap.has('a')).toBe(false);
    });

    it('opaque generic wrapper on one function does not poison a same-named parameter elsewhere (issue #2235)', () => {
      const symbols = parseTS(`
        function processOrder(db: ReturnType<typeof makeConn>) { db.commit(); }
        function processUser(db: UserDb) { db.commit(); }
      `);
      // processOrder's bogus annotation seeds nothing, so processUser's bare
      // "db" entry is uncontested.
      expect(symbols.typeMap.get('db')).toEqual({ type: 'UserDb', confidence: 0.9 });
      expect(symbols.typeMap.get('processUser::db')).toEqual({
        type: 'UserDb',
        confidence: 0.9,
      });
      expect(symbols.typeMap.has('processOrder::db')).toBe(false);
    });

    it('returns empty typeMap when no annotations', () => {
      const symbols = parseJS(`const x = 42; function foo(a, b) {}`);
      expect(symbols.typeMap).toBeInstanceOf(Map);
      expect(symbols.typeMap.size).toBe(0);
    });

    it('skips union and intersection types', () => {
      const symbols = parseTS(`const x: string | number = 42;`);
      expect(symbols.typeMap.has('x')).toBe(false);
    });

    it('handles let/var declarations with type annotations', () => {
      const symbols = parseTS(`let app: Express = createApp();`);
      expect(symbols.typeMap.get('app')).toEqual({ type: 'Express', confidence: 0.9 });
    });

    it('prefers constructor over annotation on the same declaration', () => {
      const symbols = parseTS(`const x: Base = new Derived();`);
      // Constructor on same declaration wins (confidence 1.0) because the runtime type
      // is what matters for call resolution: x.render() → Derived.render, not Base.render.
      // Cross-scope pollution is prevented by setTypeMapEntry's higher-confidence gate.
      expect(symbols.typeMap.get('x')).toEqual({ type: 'Derived', confidence: 1.0 });
    });

    // Issue #2397: `as`-cast target must seed the typeMap directly, at the
    // source, rather than leaving `db` unresolvable and dependent on
    // fragile bare-key propagation from an unrelated function in the file.
    it('extracts the target type from a single as-cast at confidence 0.9', () => {
      const symbols = parseTS(`const db = new Database(path) as BetterSqlite3Database;`);
      expect(symbols.typeMap.get('db')).toEqual({
        type: 'BetterSqlite3Database',
        confidence: 0.9,
      });
    });

    it('extracts the FINAL target type from a chained "as unknown as X" cast', () => {
      const symbols = parseTS(`const db = new Database(path) as unknown as BetterSqlite3Database;`);
      expect(symbols.typeMap.get('db')).toEqual({
        type: 'BetterSqlite3Database',
        confidence: 0.9,
      });
    });

    it('does not seed anything for a bare "as unknown" cast with no further cast', () => {
      const symbols = parseTS(`const db = new Database(path) as unknown;`);
      expect(symbols.typeMap.has('db')).toBe(false);
    });

    it('as-cast wins over a same-declaration type annotation', () => {
      const symbols = parseTS(`const db: RawHandle = new Database(path) as BetterSqlite3Database;`);
      expect(symbols.typeMap.get('db')).toEqual({
        type: 'BetterSqlite3Database',
        confidence: 0.9,
      });
    });

    it('does not mistake a bare-identifier cast input for the target type', () => {
      // Regression guard: extractAsExpressionTypeName must scan for
      // type_identifier specifically, not identifier, or `raw` (the cast's
      // INPUT, an ordinary identifier) would be wrongly returned instead of
      // the actual target type `Handle`.
      const symbols = parseTS(`const db = raw as Handle;`);
      expect(symbols.typeMap.get('db')).toEqual({ type: 'Handle', confidence: 0.9 });
    });

    it('extracts factory method patterns with confidence 0.7', () => {
      const symbols = parseJS(`const client = HttpClient.create();`);
      expect(symbols.typeMap.get('client')).toEqual({ type: 'HttpClient', confidence: 0.7 });
    });

    it('ignores lowercase factory calls', () => {
      const symbols = parseJS(`const result = utils.create();`);
      expect(symbols.typeMap.has('result')).toBe(false);
    });

    it('ignores built-in globals like Math, JSON, Promise', () => {
      const symbols = parseJS(`
        const r = Math.random();
        const d = JSON.parse('{}');
        const p = Promise.resolve(42);
      `);
      expect(symbols.typeMap.has('r')).toBe(false);
      expect(symbols.typeMap.has('d')).toBe(false);
      expect(symbols.typeMap.has('p')).toBe(false);
    });

    // Regression: GH #964 — tree-sitter can produce partial/corrupted trees in
    // which an identifier node has empty `text`. Previously the factory path
    // crashed with "Cannot read properties of undefined (reading 'toLowerCase')"
    // because `objName[0]` is undefined for an empty string. The guard now
    // mirrors the Python extractor's short-circuit check.
    it('does not crash when factory call has an empty-text identifier', () => {
      // Build a mock tree that mimics `const x = <empty-identifier>.create()`.
      // The walk path calls handleVarDeclaratorTypeMap → factory branch, which
      // reads `obj.text` ("") and would previously call "".toLowerCase() via
      // `objName[0]!.toLowerCase()`. The fix's `objName[0] &&` guard short-circuits.
      const pos = { row: 0, column: 0 };
      const makeNode = (
        type: string,
        text = '',
        fields: Record<string, any> = {},
        children: any[] = [],
      ) => {
        const node: any = {
          type,
          text,
          startPosition: pos,
          endPosition: pos,
          childCount: children.length,
          child: (i: number) => children[i] ?? null,
          childForFieldName: (name: string) => fields[name] ?? null,
          parent: null,
        };
        for (const c of children) {
          c.parent = node;
        }
        return node;
      };

      const emptyIdentifier = makeNode('identifier', '');
      const createName = makeNode('property_identifier', 'create');
      const memberExpr = makeNode(
        'member_expression',
        '.create',
        {
          object: emptyIdentifier,
          property: createName,
        },
        [emptyIdentifier, createName],
      );
      const callExpr = makeNode(
        'call_expression',
        '.create()',
        {
          function: memberExpr,
        },
        [memberExpr],
      );
      const nameIdent = makeNode('identifier', 'x');
      const declarator = makeNode(
        'variable_declarator',
        'x = .create()',
        {
          name: nameIdent,
          value: callExpr,
        },
        [nameIdent, callExpr],
      );
      const lexDecl = makeNode('lexical_declaration', 'const x = .create();', {}, [declarator]);
      const root = makeNode('program', '', {}, [lexDecl]);
      const fakeTree: any = { rootNode: root };

      // Before the fix this would throw TypeError. Now it should complete and
      // simply leave `x` out of the typeMap (empty identifier is ignored).
      expect(() => extractSymbols(fakeTree, 'test.js')).not.toThrow();
      const symbols = extractSymbols(fakeTree, 'test.js');
      expect(symbols.typeMap.has('x')).toBe(false);
    });
  });

  describe('Phase 8.3d: property write pts tracking', () => {
    function parseJS(code) {
      const parser = parsers.get('javascript');
      const tree = parser.parse(code);
      return extractSymbols(tree, 'test.js');
    }

    it('seeds typeMap with composite key for obj.prop = identifier', () => {
      const symbols = parseJS(`
        const handlers = {};
        handlers.auth = authMiddleware;
      `);
      expect(symbols.typeMap.get('handlers.auth')).toEqual({
        type: 'authMiddleware',
        confidence: 0.85,
      });
    });

    it('ignores chained writes (a.b.c = x)', () => {
      const symbols = parseJS(`a.b.c = handler;`);
      expect(symbols.typeMap.has('a.b.c')).toBe(false);
      expect(symbols.typeMap.has('b.c')).toBe(false);
    });

    it('seeds typeMap for this.prop = new ClassName() using class-scoped key', () => {
      const symbols = parseJS(`
        class UserService {
          constructor() {
            this.logger = new Logger('UserService');
          }
        }
      `);
      expect(symbols.typeMap.get('UserService.logger')).toEqual({
        type: 'Logger',
        confidence: 1.0,
      });
      expect(symbols.typeMap.has('this.logger')).toBe(false);
    });

    it('uses this.prop key when no enclosing class is present', () => {
      const symbols = parseJS(`
        function setup() {
          this.logger = new Logger();
        }
      `);
      expect(symbols.typeMap.get('this.logger')).toEqual({ type: 'Logger', confidence: 1.0 });
    });

    it('scopes this.prop typeMap key to enclosing class — no collision across classes', () => {
      const symbols = parseJS(`
        class ClassA {
          constructor() { this.service = new ServiceA(); }
        }
        class ClassB {
          constructor() { this.service = new ServiceB(); }
        }
      `);
      expect(symbols.typeMap.get('ClassA.service')).toEqual({ type: 'ServiceA', confidence: 1.0 });
      expect(symbols.typeMap.get('ClassB.service')).toEqual({ type: 'ServiceB', confidence: 1.0 });
      expect(symbols.typeMap.has('this.service')).toBe(false);
    });

    it('uses this.prop fallback for named class expressions (expression name not resolver-visible)', () => {
      // `const Foo = class Bar { ... }` — the resolver derives callerClass from the
      // binding name `Foo`, never from the expression name `Bar`. Storing as `Bar.x`
      // would produce an unreachable key, so we fall back to `this.x` instead.
      const symbols = parseJS(`
        const Foo = class Bar {
          constructor() { this.x = new X(); }
        };
      `);
      expect(symbols.typeMap.get('this.x')).toEqual({ type: 'X', confidence: 1.0 });
      expect(symbols.typeMap.has('Bar.x')).toBe(false);
    });

    it('does not seed typeMap for this.prop = identifier (only new expressions)', () => {
      const symbols = parseJS(`
        class Foo {
          init(logger) { this.logger = logger; }
        }
      `);
      expect(symbols.typeMap.has('this.logger')).toBe(false);
      expect(symbols.typeMap.has('Foo.logger')).toBe(false);
    });

    it('ignores non-identifier RHS (a.prop = obj.method)', () => {
      const symbols = parseJS(`router.use = obj.method;`);
      expect(symbols.typeMap.has('router.use')).toBe(false);
    });

    it('ignores BUILTIN_GLOBALS as object names', () => {
      const symbols = parseJS(`
        console.warn = customWarn;
        Object.assign = myAssign;
        process.on = myHandler;
        window.onload = myHandler;
        document.ready = myHandler;
        globalThis.fetch = myFetch;
      `);
      expect(symbols.typeMap.has('console.warn')).toBe(false);
      expect(symbols.typeMap.has('Object.assign')).toBe(false);
      expect(symbols.typeMap.has('process.on')).toBe(false);
      expect(symbols.typeMap.has('window.onload')).toBe(false);
      expect(symbols.typeMap.has('document.ready')).toBe(false);
      expect(symbols.typeMap.has('globalThis.fetch')).toBe(false);
    });

    it('first-write wins when same key appears twice at equal confidence', () => {
      const parser = parsers.get('typescript');
      const tree = parser.parse(`
        handlers.auth = firstMiddleware;
        handlers.auth = secondMiddleware;
      `);
      const symbols = extractSymbols(tree, 'test.ts');
      // Both writes are at 0.85; first-write wins (equal confidence does not promote)
      expect(symbols.typeMap.get('handlers.auth')?.type).toBe('firstMiddleware');
    });

    it('higher-confidence entry promotes over lower-confidence entry (setTypeMapEntry)', () => {
      const typeMap = new Map<string, { type: string; confidence: number }>();
      // Seed with a low-confidence write (property-write confidence: 0.85)
      setTypeMapEntry(typeMap, 'handlers.auth', 'firstMiddleware', 0.85);
      // A higher-confidence annotation (0.9) should overwrite
      setTypeMapEntry(typeMap, 'handlers.auth', 'AnnotatedHandler', 0.9);
      expect(typeMap.get('handlers.auth')).toEqual({ type: 'AnnotatedHandler', confidence: 0.9 });
    });
  });

  describe('Phase 8.2: inter-procedural return-type propagation', () => {
    function parseTS(code) {
      const parser = parsers.get('typescript');
      const tree = parser.parse(code);
      return extractSymbols(tree, 'test.ts');
    }

    describe('returnTypeMap extraction', () => {
      it('records explicit TS return type annotation with confidence 1.0', () => {
        const symbols = parseTS(`function createUser(): User { return new User(); }`);
        expect(symbols.returnTypeMap).toBeInstanceOf(Map);
        expect(symbols.returnTypeMap.get('createUser')).toEqual({ type: 'User', confidence: 1.0 });
      });

      it('infers return type from return new Constructor() with confidence 0.85', () => {
        const symbols = parseTS(`function buildRouter() { return new Router(); }`);
        expect(symbols.returnTypeMap.get('buildRouter')).toEqual({
          type: 'Router',
          confidence: 0.85,
        });
      });

      it('prefers annotation over inferred return type', () => {
        const symbols = parseTS(`function create(): Service { return new OtherService(); }`);
        expect(symbols.returnTypeMap.get('create')).toEqual({ type: 'Service', confidence: 1.0 });
      });

      it('qualifies method return types with class name', () => {
        const symbols = parseTS(`
          class UserService {
            getUser(): User { return new User(); }
          }
        `);
        expect(symbols.returnTypeMap.get('UserService.getUser')).toEqual({
          type: 'User',
          confidence: 1.0,
        });
      });

      it('records arrow function return type from variable declarator', () => {
        const symbols = parseTS(`const createRepo = (): Repo => new Repo();`);
        expect(symbols.returnTypeMap.get('createRepo')).toEqual({ type: 'Repo', confidence: 1.0 });
      });

      it('does not record constructor methods', () => {
        const symbols = parseTS(`class Foo { constructor() {} }`);
        expect(symbols.returnTypeMap.has('Foo.constructor')).toBe(false);
      });
    });

    describe('intra-file propagation via returnTypeMap', () => {
      it('propagates return type of annotated function — confidence 0.9 (1.0 - 0.1 × hop 1)', () => {
        const symbols = parseTS(`
          function createUser(): User { return new User(); }
          const u = createUser();
        `);
        expect(symbols.typeMap.get('u')).toEqual({ type: 'User', confidence: 0.9 });
      });

      it('propagates return type inferred from return new — confidence 0.75 (0.85 - 0.1)', () => {
        const symbols = parseTS(`
          function buildRouter() { return new Router(); }
          const r = buildRouter();
        `);
        expect(symbols.typeMap.get('r')).toEqual({ type: 'Router', confidence: 0.75 });
      });

      it('propagates return type via method call on typed receiver', () => {
        const symbols = parseTS(`
          class UserService {
            getUser(): User { return new User(); }
          }
          const svc: UserService = new UserService();
          const u = svc.getUser();
        `);
        expect(symbols.typeMap.get('u')).toEqual({ type: 'User', confidence: 0.9 });
      });

      it('resolves one-hop method chain — getService().getRepo()', () => {
        const symbols = parseTS(`
          function getService(): UserService { return new UserService(); }
          class UserService {
            getRepo(): Repo { return new Repo(); }
          }
          const repo = getService().getRepo();
        `);
        expect(symbols.typeMap.get('repo')).toEqual({ type: 'Repo', confidence: 0.8 });
      });

      it('does not override higher-confidence annotation with propagated type', () => {
        const symbols = parseTS(`
          function createUser(): User { return new User(); }
          const u: Admin = createUser();
        `);
        // Annotation (0.9) wins over propagated (0.9) — setTypeMapEntry keeps first seen
        expect(symbols.typeMap.get('u')?.type).toBe('Admin');
      });

      it('does not propagate for plain function calls with no return type info', () => {
        const symbols = parseTS(`
          function doSomething() { return 42; }
          const x = doSomething();
        `);
        expect(symbols.typeMap.has('x')).toBe(false);
      });
    });
  });

  it('does not set receiver for .call()/.apply()/.bind() unwrapped calls', () => {
    const symbols = parseJS(`fn.call(null, arg);`);
    const fnCall = symbols.calls.find((c) => c.name === 'fn');
    expect(fnCall).toBeDefined();
    expect(fnCall.receiver).toBeUndefined();
  });

  it('tags f.call({}) as dynamic/reflection even alongside a direct f() call (#1687/#1778)', () => {
    // `f(); f.call({})` — at the PARSER level, each call site is classified on its
    // own terms: the direct `f()` call is static, and `f.call({})` is tagged
    // dynamic/reflection regardless of the sibling direct call, matching native.
    // The #1687 dedup-collision (collapsing these two call sites into a single
    // graph edge without letting the reflection tag wrongly flip an
    // already-recorded dyn=0 edge) is a build-edges.ts concern, verified at the
    // graph level in tests/integration/issue-1778-reflection-dynamic-kind-parity.test.ts
    // — not here, since the parser has no visibility into sibling call sites.
    const symbols = parseJS(`const f = function () {}.bind({}); f(); f.call({});`);
    const fCallCalls = symbols.calls.filter((c) => c.name === 'f');
    expect(fCallCalls.length).toBe(2);
    expect(fCallCalls[0].dynamic).toBeFalsy(); // f() — direct call
    expect(fCallCalls[1].dynamic).toBe(true); // f.call({}) — reflection
    expect(fCallCalls[1].dynamicKind).toBe('reflection');
  });

  it('still emits dynamic/reflection for .call on member-expression object', () => {
    // `obj.method.call({})` — inner callee requires a resolution hop; stays dynamic.
    const symbols = parseJS(`obj.method.call({});`);
    const methodCall = symbols.calls.find((c) => c.name === 'method');
    expect(methodCall).toBeDefined();
    expect(methodCall.dynamic).toBe(true);
    expect(methodCall.dynamicKind).toBe('reflection');
  });

  it('does not embed the function source as receiver for .bind() on an inline function expression (#2321)', () => {
    // The exact repro from the issue: `.bind()` invoked directly on an inline
    // function_expression, not a named reference. Before the fix, this fell
    // through to the generic tail of extractMemberExprCallInfo, which set
    // `receiver` to the ENTIRE function body's source text via
    // extractReceiverName's raw-text fallback.
    const symbols = parseJS(
      `class Session {
        isReady() { return true; }
        checkBound() {
          setTimeout(function () {
            return this.isReady();
          }.bind(this), 100);
        }
      }`,
    );
    const bindCall = symbols.calls.find((c) => c.name === 'bind');
    expect(bindCall).toBeDefined();
    expect(bindCall.receiver).toBeUndefined();
    expect(bindCall.dynamic).toBe(true);
    expect(bindCall.dynamicKind).toBe('reflection');
  });

  it('does not embed the arrow function source as receiver for .call()', () => {
    const symbols = parseJS(`(() => { doWork(); }).call(ctx);`);
    const callCall = symbols.calls.find((c) => c.name === 'call');
    expect(callCall).toBeDefined();
    expect(callCall.receiver).toBeUndefined();
    expect(callCall.dynamic).toBe(true);
    expect(callCall.dynamicKind).toBe('reflection');
  });

  it('does not embed the generator function source as receiver for .apply()', () => {
    const symbols = parseJS(`(function* () { yield 1; }).apply(ctx, args);`);
    const applyCall = symbols.calls.find((c) => c.name === 'apply');
    expect(applyCall).toBeDefined();
    expect(applyCall.receiver).toBeUndefined();
    expect(applyCall.dynamic).toBe(true);
    expect(applyCall.dynamicKind).toBe('reflection');
  });

  describe('callback pattern extraction', () => {
    // Commander patterns
    it('extracts Commander .command().action() with arrow function', () => {
      const symbols = parseJS(
        `program.command('build [dir]').action(async (dir, opts) => { run(); });`,
      );
      const def = symbols.definitions.find((d) => d.name === 'command:build');
      expect(def).toBeDefined();
      expect(def.kind).toBe('function');
    });

    it('extracts Commander command with angle-bracket arg', () => {
      const symbols = parseJS(`program.command('query <name>').action(() => { search(); });`);
      const def = symbols.definitions.find((d) => d.name === 'command:query');
      expect(def).toBeDefined();
      expect(def.kind).toBe('function');
    });

    it('does not extract Commander action with named handler', () => {
      const symbols = parseJS(`program.command('test').action(handleTest);`);
      const defs = symbols.definitions.filter((d) => d.name.startsWith('command:'));
      expect(defs).toHaveLength(0);
    });

    it('still extracts calls inside Commander callback body', () => {
      const symbols = parseJS(
        `program.command('build [dir]').action(async (dir) => { buildGraph(dir); });`,
      );
      expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'buildGraph' }));
    });

    // Express patterns
    it('extracts Express app.get route', () => {
      const symbols = parseJS(`app.get('/api/users', (req, res) => { res.json([]); });`);
      const def = symbols.definitions.find((d) => d.name === 'route:GET /api/users');
      expect(def).toBeDefined();
      expect(def.kind).toBe('function');
    });

    it('extracts Express router.post route', () => {
      const symbols = parseJS(`router.post('/api/items', async (req, res) => { save(); });`);
      const def = symbols.definitions.find((d) => d.name === 'route:POST /api/items');
      expect(def).toBeDefined();
      expect(def.kind).toBe('function');
    });

    it('does not extract Map.get as Express route', () => {
      const symbols = parseJS(`myMap.get('someKey');`);
      const defs = symbols.definitions.filter((d) => d.name.startsWith('route:'));
      expect(defs).toHaveLength(0);
    });

    // Event patterns
    it('extracts emitter.on event callback', () => {
      const symbols = parseJS(`emitter.on('data', (chunk) => { process(chunk); });`);
      const def = symbols.definitions.find((d) => d.name === 'event:data');
      expect(def).toBeDefined();
      expect(def.kind).toBe('function');
    });

    it('extracts server.once event callback', () => {
      const symbols = parseJS(`server.once('listening', () => { log(); });`);
      const def = symbols.definitions.find((d) => d.name === 'event:listening');
      expect(def).toBeDefined();
      expect(def.kind).toBe('function');
    });

    it('does not extract event with named handler as definition', () => {
      const symbols = parseJS(`emitter.on('data', handleData);`);
      const defs = symbols.definitions.filter((d) => d.name.startsWith('event:'));
      expect(defs).toHaveLength(0);
      // But we DO get a call edge to the named handler
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'handleData', dynamic: true }),
      );
    });

    // Callback reference calls (named functions passed as arguments)
    it('extracts named middleware in router.use()', () => {
      const symbols = parseJS(`router.use(handleToken);`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'handleToken', dynamic: true }),
      );
    });

    it('extracts multiple named middleware arguments', () => {
      const symbols = parseJS(`app.get('/api', authenticate, validate, handler);`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'authenticate', dynamic: true }),
      );
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'validate', dynamic: true }),
      );
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'handler', dynamic: true }),
      );
    });

    it('extracts member expression callbacks (auth.validate)', () => {
      const symbols = parseJS(`app.use(auth.validate);`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'validate', receiver: 'auth', dynamic: true }),
      );
    });

    it('extracts callback in array methods (.map, .filter)', () => {
      const symbols = parseJS(`items.map(transform);`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'transform', dynamic: true }),
      );
    });

    it('extracts callback in Promise .then/.catch', () => {
      const symbols = parseJS(`promise.then(onSuccess).catch(onError);`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'onSuccess', dynamic: true }),
      );
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'onError', dynamic: true }),
      );
    });

    it('does not create dynamic calls for string/number/object arguments', () => {
      const symbols = parseJS(`app.get('/path', {key: 1}, [], 42);`);
      const dynamicCalls = symbols.calls.filter((c) => c.dynamic);
      expect(dynamicCalls).toHaveLength(0);
    });

    it('does not treat member_expression args as callbacks for non-allowlisted callees', () => {
      // `store.set(user.id, user)` — `user.id` is a property read passed as a
      // value (map key), NOT a callback. Only allowlisted callees (use, then,
      // map, addEventListener, etc.) get member_expression args emitted as
      // dynamic calls. See issue #971.
      const symbols = parseJS(`store.set(user.id, user);`);
      const dynamicMemberCalls = symbols.calls.filter((c) => c.dynamic && c.name === 'id');
      expect(dynamicMemberCalls).toHaveLength(0);
    });

    it('still emits member_expression args for allowlisted callees (regression guard)', () => {
      // Positive companion to the test above: `app.use(auth.validate)` and
      // `promise.then(handlers.onSuccess)` must still produce dynamic calls,
      // because `use` and `then` are callback-accepting APIs.
      const useSymbols = parseJS(`app.use(auth.validate);`);
      expect(useSymbols.calls).toContainEqual(
        expect.objectContaining({ name: 'validate', receiver: 'auth', dynamic: true }),
      );
      const thenSymbols = parseJS(`promise.then(handlers.onSuccess);`);
      expect(thenSymbols.calls).toContainEqual(
        expect.objectContaining({ name: 'onSuccess', receiver: 'handlers', dynamic: true }),
      );
    });

    it('does not treat cache/Map .get/.put as callback-accepting (HTTP-verb guard)', () => {
      // `cache.get(user.id)` shares the verb name `get` with Express routes,
      // but has no string-literal route path first arg — so member-expr args
      // must not be emitted as dynamic calls. Same for `repo.put`, `map.delete`.
      const cacheSymbols = parseJS(`cache.get(user.id);`);
      expect(cacheSymbols.calls.filter((c) => c.dynamic && c.name === 'id')).toHaveLength(0);
      const repoSymbols = parseJS(`repo.put(record.key, value);`);
      expect(repoSymbols.calls.filter((c) => c.dynamic && c.name === 'key')).toHaveLength(0);
      const mapSymbols = parseJS(`map.delete(entry.id);`);
      expect(mapSymbols.calls.filter((c) => c.dynamic && c.name === 'id')).toHaveLength(0);
    });

    it('still emits member-expr args for Express HTTP routes with string path', () => {
      // Positive regression guard: HTTP-verb calls with a string-literal
      // first arg (Express route signature) must still emit member-expr args.
      const routerSymbols = parseJS(`router.get('/users/:id', auth.check);`);
      expect(routerSymbols.calls).toContainEqual(
        expect.objectContaining({ name: 'check', receiver: 'auth', dynamic: true }),
      );
      const templateSymbols = parseJS('app.post(`/api`, handlers.create);');
      expect(templateSymbols.calls).toContainEqual(
        expect.objectContaining({ name: 'create', receiver: 'handlers', dynamic: true }),
      );
    });

    it('handles optional-chaining callees in allowlist (obj?.on)', () => {
      // `obj?.on(event, handler.fn)` — tree-sitter-javascript/typescript
      // represent `obj?.on` as a `member_expression` with an `optional_chain`
      // child, so `extractCalleeName` still returns `on` and the allowlist
      // gate works. Guards against a previously-flagged false-negative class.
      const symbols = parseJS(`emitter?.on('tick', handlers.fn);`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'fn', receiver: 'handlers', dynamic: true }),
      );
    });

    it('does not treat identifier args as callbacks for non-allowlisted callees (issue #1741)', () => {
      // Regression guard for #1741: `findMergeCandidates(communities)` and
      // `analyzeDrift(communities, communityDirs)` pass `communities` as a
      // plain DATA argument, not a callback reference. `findMergeCandidates`
      // and `analyzeDrift` are not callback-accepting callees, so identifier
      // args must be gated exactly like member_expression args — otherwise
      // the global-fallback resolver can bind the identifier to an unrelated
      // same-named function elsewhere in the repo, fabricating a call edge
      // (and, transitively, a phantom cycle — see codegraph's own
      // src/features/communities.ts vs src/presentation/communities.ts).
      const symbols = parseJS(`findMergeCandidates(communities);`);
      expect(symbols.calls.filter((c) => c.dynamic && c.name === 'communities')).toHaveLength(0);

      const symbols2 = parseJS(`analyzeDrift(communities, communityDirs);`);
      expect(symbols2.calls.filter((c) => c.dynamic)).toHaveLength(0);
    });

    it('still emits identifier args for allowlisted callees (regression guard)', () => {
      // Positive companion to the #1741 fix: identifier args passed to a
      // genuine callback-accepting callee must still be resolved, e.g.
      // `arr.forEach(myNamedCallback)` — the exact pattern the original
      // "identifier args are always emitted" trade-off existed to preserve.
      const symbols = parseJS(`arr.forEach(myNamedCallback);`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'myNamedCallback', dynamic: true }),
      );
    });

    it('does not treat identifier args to cache/Map .get/.put as callback-accepting (HTTP-verb guard)', () => {
      // Identifier-arg counterpart to the existing member-expression HTTP-verb
      // guard: `cache.get(someKey)` shares the verb name `get` with Express
      // routes but has no string-literal route path first arg, so the
      // identifier arg must not be emitted as a dynamic call either.
      const symbols = parseJS(`cache.get(someKey);`);
      expect(symbols.calls.filter((c) => c.dynamic && c.name === 'someKey')).toHaveLength(0);
    });

    it('emits Array.from mapFn (index 1) but not arrayLike (index 0)', () => {
      // Regression guard for #1741 follow-up: `Array.from(arrayLike, mapFn)` is a
      // well-known stdlib callback pattern (also every TypedArray.from), but the
      // callback is the SECOND positional argument, not the first. Emitting
      // `arrayLike` too would reintroduce the exact name-collision false-positive
      // class #1741 fixes for the data argument; only `mapFn` should resolve.
      const symbols = parseJS(`Array.from(arr, mapCallback);`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'mapCallback', dynamic: true }),
      );
      expect(symbols.calls.filter((c) => c.dynamic && c.name === 'arr')).toHaveLength(0);
    });

    it('emits only the index-1 mapFn for Array.from with a thisArg (index 2)', () => {
      // `Array.from(arrayLike, mapFn, thisArg)` — thisArg (index 2) is a `this`
      // binding context, not a callback, and must not be emitted either.
      const symbols = parseJS(`Array.from(arr, mapCallback, thisArg);`);
      const dynamicNames = symbols.calls.filter((c) => c.dynamic).map((c) => c.name);
      expect(dynamicNames).toEqual(['mapCallback']);
    });

    it('applies the same Array.from positional gate to TypedArray constructors', () => {
      // Every TypedArray constructor (Uint8Array, Int32Array, etc.) mirrors
      // Array.from's (arrayLike, mapFn, thisArg) signature; the gate is
      // name-based on the property `from`, not receiver-typed, so it applies
      // uniformly.
      const symbols = parseJS(`Uint8Array.from(arr, mapCallback);`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'mapCallback', dynamic: true }),
      );
      expect(symbols.calls.filter((c) => c.dynamic && c.name === 'arr')).toHaveLength(0);
    });

    it('applies the Array.from positional gate to member_expression args too', () => {
      // Greptile follow-up: the old member_expression guard was an explicit
      // `&& memberExprArgsAllowed` inline check; the positional restructuring
      // moved that responsibility to the shared early-return above the loop.
      // `Array.from(arr, obj.mapper)` exercises that a member_expression at
      // the positional index (1) is still emitted with its receiver, while
      // one at index 0 is not — guarding against a future refactor that
      // re-adds an inline guard on member_expression only.
      const symbols = parseJS(`Array.from(arr, obj.mapper);`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'mapper', receiver: 'obj', dynamic: true }),
      );
      expect(symbols.calls.filter((c) => c.dynamic && c.name === 'arr')).toHaveLength(0);

      const symbols2 = parseJS(`Array.from(obj.arrayLike, mapCallback);`);
      expect(symbols2.calls.filter((c) => c.dynamic && c.name === 'arrayLike')).toHaveLength(0);
      expect(symbols2.calls).toContainEqual(
        expect.objectContaining({ name: 'mapCallback', dynamic: true }),
      );
    });

    it('extracts callback in plain function calls like setTimeout', () => {
      const symbols = parseJS(`setTimeout(tick, 1000);`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'tick', dynamic: true }),
      );
    });

    it('does not duplicate call for call-expression arguments', () => {
      const symbols = parseJS(`router.use(checkPermissions(['admin']));`);
      const cpCalls = symbols.calls.filter((c) => c.name === 'checkPermissions');
      expect(cpCalls).toHaveLength(1);
    });

    describe('identifier args to user-defined higher-order functions via parameter type (#1845)', () => {
      function parseTS(code) {
        const parser = parsers.get('typescript');
        const tree = parser.parse(code);
        return extractSymbols(tree, 'test.ts');
      }

      it('recognizes an identifier arg passed to a same-file function whose parameter is a function-shaped type alias', () => {
        const symbols = parseTS(`
type UserProcessor = (user: string) => void;
function processEach(users: string[], fn: UserProcessor): void {
  for (const user of users) fn(user);
}
function logUser(user: string): void { console.log(user); }
function runDemo(users: string[]): void {
  processEach(users, logUser);
}
`);
        expect(symbols.calls).toContainEqual(
          expect.objectContaining({ name: 'logUser', dynamic: true }),
        );
      });

      it('recognizes an identifier arg passed to a parameter with an inline arrow-function type', () => {
        const symbols = parseTS(`
function processEach(users: string[], fn: (user: string) => void): void {
  for (const user of users) fn(user);
}
function logUser(user: string): void {}
function runDemo(users: string[]): void {
  processEach(users, logUser);
}
`);
        expect(symbols.calls).toContainEqual(
          expect.objectContaining({ name: 'logUser', dynamic: true }),
        );
      });

      it('recognizes an identifier arg passed to a Function-typed parameter', () => {
        const symbols = parseTS(`
function runWith(fn: Function): void { fn(); }
function handler(): void {}
function runDemo(): void {
  runWith(handler);
}
`);
        expect(symbols.calls).toContainEqual(
          expect.objectContaining({ name: 'handler', dynamic: true }),
        );
      });

      it('does not treat an identifier arg as a callback when the callee parameter is not function-shaped (issue #1741 regression guard)', () => {
        const symbols = parseTS(`
function findMergeCandidates(communities: string[]): void {}
function runDemo(communities: string[]): void {
  findMergeCandidates(communities);
}
`);
        expect(symbols.calls.filter((c) => c.dynamic && c.name === 'communities')).toHaveLength(0);
      });

      it('only recognizes the function-shaped parameter position, not sibling data parameters', () => {
        const symbols = parseTS(`
type UserPredicate = (user: string) => boolean;
type UserProcessor = (user: string) => void;
function filterThen(users: string[], pred: UserPredicate, fn: UserProcessor): void {}
function hasEmail(user: string): boolean { return true; }
function logUser(user: string): void {}
function runDemo(users: string[]): void {
  filterThen(users, hasEmail, logUser);
}
`);
        const dynamicNames = symbols.calls.filter((c) => c.dynamic).map((c) => c.name);
        expect(dynamicNames).toEqual(expect.arrayContaining(['hasEmail', 'logUser']));
        expect(dynamicNames).not.toContain('users');
      });

      it('resolves one level of type-alias indirection', () => {
        const symbols = parseTS(`
type Handler = (user: string) => void;
type UserProcessor = Handler;
function processEach(users: string[], fn: UserProcessor): void {}
function logUser(user: string): void {}
function runDemo(users: string[]): void {
  processEach(users, logUser);
}
`);
        expect(symbols.calls).toContainEqual(
          expect.objectContaining({ name: 'logUser', dynamic: true }),
        );
      });

      it('recognizes function-shaped parameters on class methods, keyed by bare method name', () => {
        const symbols = parseTS(`
class Runner {
  processEach(users: string[], fn: (user: string) => void): void {}
}
function logUser(user: string): void {}
function runDemo(runner: Runner, users: string[]): void {
  runner.processEach(users, logUser);
}
`);
        expect(symbols.calls).toContainEqual(
          expect.objectContaining({ name: 'logUser', dynamic: true }),
        );
      });

      it('does not misalign parameter indices when the callee declares an explicit this parameter', () => {
        const symbols = parseTS(`
function processEach(this: void, users: string[], fn: (user: string) => void): void {}
function logUser(user: string): void {}
function runDemo(users: string[]): void {
  processEach(users, logUser);
}
`);
        expect(symbols.calls).toContainEqual(
          expect.objectContaining({ name: 'logUser', dynamic: true }),
        );
      });

      it('recognizes an identifier arg passed to a same-file arrow-function higher-order function', () => {
        const symbols = parseTS(`
type UserProcessor = (user: string) => void;
const processEach = (users: string[], fn: UserProcessor): void => {
  for (const user of users) fn(user);
};
function logUser(user: string): void {}
function runDemo(users: string[]): void {
  processEach(users, logUser);
}
`);
        expect(symbols.calls).toContainEqual(
          expect.objectContaining({ name: 'logUser', dynamic: true }),
        );
      });

      it('recognizes an identifier arg passed to a same-file function-expression higher-order function', () => {
        const symbols = parseTS(`
type UserProcessor = (user: string) => void;
const processEach = function (users: string[], fn: UserProcessor): void {
  for (const user of users) fn(user);
};
function logUser(user: string): void {}
function runDemo(users: string[]): void {
  processEach(users, logUser);
}
`);
        expect(symbols.calls).toContainEqual(
          expect.objectContaining({ name: 'logUser', dynamic: true }),
        );
      });

      it('does not merge callback shapes across two unrelated same-named methods (false-positive guard)', () => {
        const symbols = parseTS(`
class Uploader {
  process(data: string, cb: (result: string) => void): void {}
}
class Reporter {
  process(users: string[]): void {}
}
function runDemo(reporter: Reporter, users: string[]): void {
  reporter.process(users);
}
`);
        expect(symbols.calls.filter((c) => c.dynamic && c.name === 'users')).toHaveLength(0);
      });
    });

    // Destructured bindings
    it('extracts definitions from destructured const bindings', () => {
      // kind is 'constant' (#1773), not 'function' — matches the plain
      // `const x = <literal>` and array-pattern destructuring convention.
      // Destructured names remain resolvable as call targets regardless of
      // kind (call-target resolution is kind-agnostic), so callback-style
      // destructured bindings like `handleToken` still resolve when called.
      const symbols = parseJS(`const { handleToken, checkPermissions } = initAuth(config);`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'handleToken', kind: 'constant' }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'checkPermissions', kind: 'constant' }),
      );
    });

    it('extracts definitions from exported destructured const bindings', () => {
      const symbols = parseJS(`export const { handleToken, checkPermissions } = initAuth(config);`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'handleToken', kind: 'constant' }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'checkPermissions', kind: 'constant' }),
      );
    });

    it('marks exported destructured object-pattern bindings as exports (#2070)', () => {
      // Regression guard for #2070: collectExportedDeclarations used to skip
      // any declarator whose name field wasn't a plain identifier, so
      // `export const { a, b } = value` produced Definitions for a/b (above)
      // but no matching Export entries at all — the exported=1 UPDATE never
      // fired, leaving genuinely exported destructured bindings unmarked.
      const symbols = parseJS(`export const { handleToken, checkPermissions } = initAuth(config);`);
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'handleToken', kind: 'constant', line: 1 }),
      );
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'checkPermissions', kind: 'constant', line: 1 }),
      );
    });

    it('marks exported destructured array-pattern bindings as exports (#2070)', () => {
      const symbols = parseJS(`export const [a, b] = computePair();`);
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'a', kind: 'constant', line: 1 }),
      );
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'b', kind: 'constant', line: 1 }),
      );
    });

    it('marks exported nested array-pattern rest bindings as exports (#2070)', () => {
      // Greptile review on the PR for #2070: a rest element that itself nests
      // another array pattern (`...[a, b]`) must have its recursive names
      // reach the Export side too, not just the Definition side (see
      // "extracts nested array_pattern rest bindings as own definitions"
      // elsewhere in this file) — the exported=1 UPDATE matches by
      // (name, kind, file, line), so a name present only in one side never
      // gets marked exported.
      const symbols = parseJS(`export const [x, ...[a, b]] = computeList();`);
      for (const name of ['x', 'a', 'b']) {
        expect(symbols.exports).toContainEqual(
          expect.objectContaining({ name, kind: 'constant', line: 1 }),
        );
      }
    });

    it('does not export let/var destructured bindings (#2070)', () => {
      // Mirrors "does not extract definitions from let/var destructured
      // bindings" above — the Export side must stay restricted to const too,
      // never diverging from which bindings get a Definition in the first place.
      const letSymbols = parseJS(`export let { userId, email } = parseRequest(req);`);
      expect(letSymbols.exports.some((e) => e.name === 'userId')).toBe(false);
      expect(letSymbols.exports.some((e) => e.name === 'email')).toBe(false);

      const varSymbols = parseJS(`export var [foo, bar] = getConfig();`);
      expect(varSymbols.exports.some((e) => e.name === 'foo')).toBe(false);
      expect(varSymbols.exports.some((e) => e.name === 'bar')).toBe(false);
    });

    it('extracts non-renamed destructured const bindings with kind constant (#1773)', () => {
      // Regression guard for issue #1773: plain (non-renamed) destructured
      // bindings from a non-call RHS (e.g. `workerData`) must not default to
      // kind 'function' — they hold arbitrary values, not callables.
      const symbols = parseJS(`const { dbPath, name, force } = workerData;`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'dbPath', kind: 'constant' }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'name', kind: 'constant' }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'force', kind: 'constant' }),
      );
    });

    it('does not extract definitions from let/var destructured bindings', () => {
      const letSymbols = parseJS(`let { userId, email } = parseRequest(req);`);
      expect(letSymbols.definitions).not.toContainEqual(
        expect.objectContaining({ name: 'userId' }),
      );
      expect(letSymbols.definitions).not.toContainEqual(expect.objectContaining({ name: 'email' }));

      const varSymbols = parseJS(`var { foo, bar } = getConfig();`);
      expect(varSymbols.definitions).not.toContainEqual(expect.objectContaining({ name: 'foo' }));
      expect(varSymbols.definitions).not.toContainEqual(expect.objectContaining({ name: 'bar' }));
    });

    it('extracts renamed destructured const binding under its local alias', () => {
      // kind is 'constant' (#1773) — see comment on the non-renamed case above.
      const symbols = parseJS(`const { original: renamed } = initAuth();`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'renamed', kind: 'constant' }),
      );
      expect(symbols.definitions).not.toContainEqual(expect.objectContaining({ name: 'original' }));
    });

    it('does not extract destructured bindings declared inside function scope', () => {
      // Parity with the query path (extractDestructuredBindingsWalk) and the
      // Rust walk path (handle_var_decl) — both skip FUNCTION_SCOPE_TYPES.
      const symbols = parseJS(
        `function setup() { const { handleToken, checkPermissions } = initAuth(config); }`,
      );
      expect(symbols.definitions).not.toContainEqual(
        expect.objectContaining({ name: 'handleToken' }),
      );
      expect(symbols.definitions).not.toContainEqual(
        expect.objectContaining({ name: 'checkPermissions' }),
      );
    });

    describe('destructured const binding rest/default definitions (#2051)', () => {
      // extractDestructuredBindings's object_pattern branch only recognized
      // shorthand_property_identifier_pattern and pair_pattern children, so a
      // rest element (`...rest`) never got a Definition at all and a shorthand
      // default (`{ a = 1 }`) produced no Definition either — the same class of
      // bug fixed for dynamic-import destructure extraction in #1920, but for
      // the generic destructured-const-binding path used by any object
      // destructure, not just dynamic imports.

      it('extracts a constant Definition for a rest binding alongside plain names', () => {
        const symbols = parseJS(`const { a, ...rest } = someValue;`);
        expect(symbols.definitions).toContainEqual(
          expect.objectContaining({ name: 'a', kind: 'constant' }),
        );
        expect(symbols.definitions).toContainEqual(
          expect.objectContaining({ name: 'rest', kind: 'constant' }),
        );
      });

      it('extracts a constant Definition for a shorthand default-value binding', () => {
        const symbols = parseJS(`const { a = 1 } = someValue;`);
        expect(symbols.definitions).toContainEqual(
          expect.objectContaining({ name: 'a', kind: 'constant' }),
        );
      });

      it('extracts a mix of plain, renamed, default, and rest bindings', () => {
        const symbols = parseJS(`const { a, b: alias, c = 1, ...rest } = someValue;`);
        for (const name of ['a', 'alias', 'c', 'rest']) {
          expect(symbols.definitions).toContainEqual(
            expect.objectContaining({ name, kind: 'constant' }),
          );
        }
        expect(symbols.definitions).not.toContainEqual(expect.objectContaining({ name: 'b' }));
      });

      it('extracts a constant Definition for a renamed binding with a default value', () => {
        // Greptile follow-up: { key: local = fallback } nests an
        // assignment_pattern under pair_pattern's value field — a distinct
        // shape from the plain shorthand default ({ a = 1 }) case above.
        // Without this branch the pair_pattern handler rejected the nested
        // assignment_pattern and `local` never got a Definition at all.
        const symbols = parseJS(`const { key: local = fallback } = someValue;`);
        expect(symbols.definitions).toContainEqual(
          expect.objectContaining({ name: 'local', kind: 'constant' }),
        );
        expect(symbols.definitions).not.toContainEqual(expect.objectContaining({ name: 'key' }));
      });
    });

    // let/var object-literal method definitions
    it('extracts qualified definitions from var object-literal arrow functions', () => {
      // `var x = { a: function() {} }` — native produces `x.a`, WASM must too.
      // Parity fix: extractLetVarObjLiteralDeclarators covers let/var (const already
      // handled by extractConstDeclarators → extractObjectLiteralFunctions).
      const symbols = parseJS(`var x = { a: function() {}, b: () => {} };`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'x.a', kind: 'function' }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'x.b', kind: 'function' }),
      );
    });

    it('extracts qualified definitions from let object-literal shorthand methods', () => {
      // `let x12 = { f13() {} }` — matches jelly-micro classes.js fixtures.
      const symbols = parseJS(`let x12 = { f13() {}, f14: () => {} };`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'x12.f13', kind: 'function' }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'x12.f14', kind: 'function' }),
      );
    });

    it('does not extract let/var object-literal definitions inside function scope', () => {
      // Scope guard mirrors const path — skips object literals inside function bodies.
      const symbols = parseJS(`function setup() { var local = { f() {} }; }`);
      expect(symbols.definitions).not.toContainEqual(expect.objectContaining({ name: 'local.f' }));
    });

    // Issue #2033: object literals returned from a factory function's body
    it('extracts qualified definitions from an object literal returned by a named function', () => {
      const symbols = parseJS(`
        function computeDeltaCPM(s, v) { return s + v; }
        function makePartition(seed) {
          const s = seed;
          return {
            deltaCPM: (v) => computeDeltaCPM(s, v),
            deltaModularity(v) { return v; },
          };
        }
      `);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'makePartition.deltaCPM', kind: 'function' }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'makePartition.deltaModularity', kind: 'function' }),
      );
      // The call inside the closure must attribute to the qualified property span
      // (the `deltaCPM: (v) => ...` line), not the enclosing factory's own span.
      const deltaCPM = symbols.definitions.find((d) => d.name === 'makePartition.deltaCPM');
      expect(deltaCPM.line).toBe(6);
    });

    it('qualifies an object literal returned by a named function expression assigned to a const', () => {
      // `const makePartition = function(seed) { return {...} }` — the enclosing
      // function has no name of its own, so the qualifier falls back to the
      // variable it's directly assigned to, mirroring handleVarFnAssignment.
      const symbols = parseJS(`
        const makePartition = function (seed) {
          return { deltaCPM: (v) => v + seed };
        };
      `);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'makePartition.deltaCPM', kind: 'function' }),
      );
    });

    it('qualifies an object literal returned by a method against ClassName.method', () => {
      const symbols = parseJS(`
        class Factory {
          makePartition(seed) {
            return { deltaCPM: (v) => v + seed };
          }
        }
      `);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'Factory.makePartition.deltaCPM', kind: 'function' }),
      );
    });

    it('does not qualify an object literal returned from an anonymous, non-assigned closure', () => {
      // The returned object literal's nearest enclosing function scope is an
      // anonymous callback passed directly to `array.map` — no resolvable
      // qualifier, so no qualified definition should be created for it.
      const symbols = parseJS(`
        function outer() {
          return [1].map(function (v) {
            return { get: () => v };
          });
        }
      `);
      expect(symbols.definitions).not.toContainEqual(
        expect.objectContaining({ name: expect.stringContaining('.get') }),
      );
    });

    it('seeds a typeMap entry for the qualified return-statement object-literal property', () => {
      const symbols = parseJS(`
        function makePartition(seed) {
          return { deltaCPM: (v) => v + seed };
        }
      `);
      const entry = symbols.typeMap.get('makePartition.deltaCPM');
      expect(entry).toBeDefined();
      expect(entry.type).toBe('makePartition.deltaCPM');
    });

    it('self-types a factory function whose body directly returns an object literal with callable properties', () => {
      const symbols = parseJS(`
        function makePartition(seed) {
          return { deltaCPM: (v) => v + seed };
        }
      `);
      const entry = symbols.returnTypeMap.get('makePartition');
      expect(entry).toBeDefined();
      expect(entry.type).toBe('makePartition');
    });

    it('does not self-type an async factory function — its runtime return value is a Promise wrapper', () => {
      // `const p = makePartitionAsync(seed)` yields a Promise, not the object
      // literal directly — self-typing `p` as the factory would let
      // `p.deltaCPM(...)` wrongly resolve without an intervening `await`.
      const symbols = parseJS(`
        async function makePartitionAsync(seed) {
          return { deltaCPM: (v) => v + seed };
        }
      `);
      expect(symbols.returnTypeMap.get('makePartitionAsync')).toBeUndefined();
      // The qualified property definition itself is still extracted — only the
      // self-type inference (which would let a caller's receiver resolve to it
      // without unwrapping the Promise) is skipped.
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'makePartitionAsync.deltaCPM', kind: 'function' }),
      );
    });

    it('does not self-type a generator factory function — its runtime return value is a Generator wrapper', () => {
      const symbols = parseJS(`
        function* makePartitionGen(seed) {
          return { deltaCPM: (v) => v + seed };
        }
      `);
      expect(symbols.returnTypeMap.get('makePartitionGen')).toBeUndefined();
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'makePartitionGen.deltaCPM', kind: 'function' }),
      );
    });

    it('does not apply return-new-Constructor self-typing to an async function either', () => {
      // Regression guard for the pre-existing `return new Ctor()` inference,
      // which has the identical async-wrapper flaw and is gated by the same
      // isAsyncFunctionNode/isGeneratorFunctionNode check.
      const symbols = parseJS(`
        class Foo {}
        async function makeFoo() {
          return new Foo();
        }
      `);
      expect(symbols.returnTypeMap.get('makeFoo')).toBeUndefined();
    });

    // Line range verification
    it('sets correct line and endLine on callback definition', () => {
      const code = [
        'app.get("/users",', // line 1
        '  (req, res) => {', // line 2 — callback starts
        '    res.json([]);', // line 3
        '  }', // line 4 — callback ends
        ');', // line 5
      ].join('\n');
      const symbols = parseJS(code);
      const def = symbols.definitions.find((d) => d.name === 'route:GET /users');
      expect(def).toBeDefined();
      expect(def.line).toBe(2);
      expect(def.endLine).toBe(4);
    });

    // .call/.apply/.bind narrowing (#1406)
    // All args flow into the delegated function, not as callbacks for the current scope.
    // This-rebinding (fn::this → ctx) is handled by extractThisCallBindingsWalk instead.
    it('emits nothing for .call() — args flow into the delegated function, not the current scope', () => {
      const symbols = parseJS(`Array.prototype.forEach.call(collection, handler);`);
      expect(symbols.calls).not.toContainEqual(expect.objectContaining({ name: 'handler' }));
      expect(symbols.calls).not.toContainEqual(expect.objectContaining({ name: 'collection' }));
    });

    it('emits nothing for .apply() — second arg is an arguments array, not a callback', () => {
      const symbols = parseJS(`fn.apply(ctx, handler);`);
      expect(symbols.calls).not.toContainEqual(expect.objectContaining({ name: 'handler' }));
      expect(symbols.calls).not.toContainEqual(expect.objectContaining({ name: 'ctx' }));
    });

    it('emits nothing for .call() with only the this-context arg', () => {
      const symbols = parseJS(`fn.call(ctx);`);
      expect(symbols.calls).not.toContainEqual(expect.objectContaining({ name: 'ctx' }));
    });

    it('emits nothing for .bind() — all args are absorbed into the partial application', () => {
      const symbols = parseJS(`Promise.resolve.bind(null, transform);`);
      expect(symbols.calls).not.toContainEqual(expect.objectContaining({ name: 'transform' }));
      expect(symbols.calls).not.toContainEqual(expect.objectContaining({ name: 'null' }));
    });
  });

  describe('object-literal value-ref extraction (#1771)', () => {
    it('extracts a value-ref call for a bare-identifier property value', () => {
      const symbols = parseJS(`const table = { resolve: resolveWrapperParam };`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({
          name: 'resolveWrapperParam',
          dynamic: true,
          dynamicKind: 'value-ref',
        }),
      );
    });

    it('extracts value-ref calls for every handler in a dispatch-table array', () => {
      // Mirrors this repo's own PARAM_NODE_HANDLERS pattern (issue #1771):
      // an array of `{ matches, resolve }` objects where `resolve` is a bare
      // function identifier dispatched at runtime via `handler.resolve(...)`.
      const symbols = parseJS(`
        const HANDLERS = [
          { matches: isA, resolve: resolveA },
          { matches: isB, resolve: resolveB },
          { matches: isC, resolve: resolveC },
        ];
      `);
      for (const name of ['isA', 'resolveA', 'isB', 'resolveB', 'isC', 'resolveC']) {
        expect(symbols.calls).toContainEqual(
          expect.objectContaining({ name, dynamic: true, dynamicKind: 'value-ref' }),
        );
      }
    });

    it('extracts a value-ref call for a shorthand property', () => {
      const symbols = parseJS(`const table = { someFunction };`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'someFunction', dynamic: true, dynamicKind: 'value-ref' }),
      );
    });

    it('does not extract a value-ref call for a call-expression value', () => {
      const symbols = parseJS(`const table = { resolve: someFunction() };`);
      expect(symbols.calls).not.toContainEqual(
        expect.objectContaining({ name: 'someFunction', dynamicKind: 'value-ref' }),
      );
    });

    it('does not extract a value-ref call for a member-expression value', () => {
      const symbols = parseJS(`const table = { resolve: obj.someFunction };`);
      expect(symbols.calls).not.toContainEqual(
        expect.objectContaining({ dynamicKind: 'value-ref', name: 'someFunction' }),
      );
    });

    it('does not extract a value-ref call for an inline function/arrow value', () => {
      const symbols = parseJS(`const table = { resolve: () => {}, other: function () {} };`);
      expect(symbols.calls.filter((c) => c.dynamicKind === 'value-ref')).toHaveLength(0);
    });

    it('does not extract a value-ref call for literal or data-shaped values', () => {
      const symbols = parseJS(`
        const config = { name: 'literal', count: 42, active: true, empty: null, list: [1, 2] };
      `);
      expect(symbols.calls.filter((c) => c.dynamicKind === 'value-ref')).toHaveLength(0);
    });

    it('excludes builtin globals from value-ref extraction', () => {
      const symbols = parseJS(`const table = { log: console, Ctor: Object };`);
      expect(symbols.calls.filter((c) => c.dynamicKind === 'value-ref')).toHaveLength(0);
    });
  });

  describe('JSX element value-ref extraction (#2389)', () => {
    it('extracts a value-ref call for a self-closing component reference', () => {
      const symbols = parseJS(`function App() { return <Header title="x" />; }`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'Header', dynamic: true, dynamicKind: 'value-ref' }),
      );
    });

    it('extracts a value-ref call for a component with children', () => {
      const symbols = parseJS(`function App() { return <Wrapper><span /></Wrapper>; }`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'Wrapper', dynamic: true, dynamicKind: 'value-ref' }),
      );
    });

    it('does not extract a value-ref call for a lowercase intrinsic HTML tag', () => {
      const symbols = parseJS(`function App() { return <div className="x"><span /></div>; }`);
      expect(symbols.calls.filter((c) => c.dynamicKind === 'value-ref')).toHaveLength(0);
    });

    it('credits the base object identifier for a namespaced component reference', () => {
      const symbols = parseJS(`function App() { return <NS.Header />; }`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'NS', dynamic: true, dynamicKind: 'value-ref' }),
      );
    });
  });

  describe('call-argument identifier value-ref extraction (#2389)', () => {
    it('extracts a value-ref call for a bare identifier passed as a call argument', () => {
      const symbols = parseJS(`Factory.create(AppModule);`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'AppModule', dynamic: true, dynamicKind: 'value-ref' }),
      );
    });

    it('extracts a value-ref call for every bare identifier argument', () => {
      const symbols = parseJS(`register(ModuleA, ModuleB);`);
      for (const name of ['ModuleA', 'ModuleB']) {
        expect(symbols.calls).toContainEqual(
          expect.objectContaining({ name, dynamic: true, dynamicKind: 'value-ref' }),
        );
      }
    });

    it('does not extract a value-ref call for undefined/null/builtin-global arguments', () => {
      const symbols = parseJS(`register(undefined, null, console);`);
      expect(symbols.calls.filter((c) => c.dynamicKind === 'value-ref')).toHaveLength(0);
    });

    it('does not extract a value-ref call for a member-expression or call-expression argument', () => {
      const symbols = parseJS(`register(obj.Module, makeModule());`);
      expect(symbols.calls.filter((c) => c.dynamicKind === 'value-ref')).toHaveLength(0);
    });
  });

  describe('object-literal value-ref keyExpr capture (#1895)', () => {
    it('captures the property key, distinct from the referenced value name', () => {
      const symbols = parseJS(`const table = { resolve: someFunction };`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({
          name: 'someFunction',
          dynamicKind: 'value-ref',
          keyExpr: 'resolve',
        }),
      );
    });

    it('captures a string-literal key with quotes stripped', () => {
      const symbols = parseJS(`const table = { 'resolve': someFunction };`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'someFunction', keyExpr: 'resolve' }),
      );
    });

    it('captures a computed string-literal key', () => {
      const symbols = parseJS(`const table = { ['resolve']: someFunction };`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'someFunction', keyExpr: 'resolve' }),
      );
    });

    it('leaves keyExpr unset for a non-string computed key', () => {
      const symbols = parseJS(`const table = { [Symbol.iterator]: someFunction };`);
      const call = symbols.calls.find(
        (c) => c.dynamicKind === 'value-ref' && c.name === 'someFunction',
      );
      expect(call?.keyExpr).toBeUndefined();
    });

    it('sets keyExpr equal to name for a shorthand property', () => {
      const symbols = parseJS(`const table = { someFunction };`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'someFunction', keyExpr: 'someFunction' }),
      );
    });

    it('leaves keyExpr unset for instanceof value-refs (no property key exists)', () => {
      const symbols = parseJS(`if (err instanceof CodegraphError) {}`);
      const call = symbols.calls.find(
        (c) => c.dynamicKind === 'value-ref' && c.name === 'CodegraphError',
      );
      expect(call).toBeDefined();
      expect(call?.keyExpr).toBeUndefined();
    });
  });

  describe('object-literal allocation sites (#2088)', () => {
    it('emits a site and tags the value-ref call with objectLiteralSite', () => {
      const symbols = parseJS(`
        function someFunction() {}
        const table = { resolve: someFunction };
        table.resolve();
      `);
      expect(symbols.objectLiteralSites?.length).toBeGreaterThan(0);
      const site = symbols.objectLiteralSites![0]!;
      expect(site.site).toMatch(/^\d+:\d+$/);
      expect(site.owner).toBe('table');
      expect(site.escapes).toBe(false);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({
          name: 'someFunction',
          dynamicKind: 'value-ref',
          objectLiteralSite: site.site,
        }),
      );
    });

    it('marks an exported table as escaping', () => {
      const symbols = parseJS(`
        function someFunction() {}
        export const table = { resolve: someFunction };
        table.resolve();
      `);
      expect(symbols.objectLiteralSites?.[0]?.escapes).toBe(true);
    });

    it('does not tag instanceof value-refs with objectLiteralSite', () => {
      const symbols = parseJS(`if (err instanceof CodegraphError) {}`);
      const call = symbols.calls.find(
        (c) => c.dynamicKind === 'value-ref' && c.name === 'CodegraphError',
      );
      expect(call?.objectLiteralSite).toBeUndefined();
    });

    it('marks a this-using method table as escaping', () => {
      const symbols = parseJS(`
        function fnA() { return 1; }
        const T = { alpha: fnA, run() { return this.alpha(); } };
        T.run();
      `);
      expect(symbols.objectLiteralSites?.[0]?.escapes).toBe(true);
    });

    it('marks an object-spread table as escaping', () => {
      const symbols = parseJS(`
        function fnA() { return 1; }
        const mixin = { extra: 1 };
        const T = { alpha: fnA, ...mixin };
        T.alpha();
      `);
      expect(symbols.objectLiteralSites?.[0]?.escapes).toBe(true);
    });

    it('keeps a mixed data/handler table local-closed', () => {
      const symbols = parseJS(`
        function isBaz() { return 1; }
        const N = { priority: 1, label: 'default', tags: ['x', 'y'], resolve: isBaz };
        N.resolve();
      `);
      expect(symbols.objectLiteralSites?.[0]?.escapes).toBe(false);
    });
  });

  describe('logical-or/nullish-coalescing/ternary fallback value-ref extraction (#2257)', () => {
    it('extracts a value-ref call for a logical-or fallback whose variable is used again', () => {
      const symbols = parseJS(`
        const fetchFn = options.custom || fetchLatestVersion;
        call(fetchFn);
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({
          name: 'fetchLatestVersion',
          dynamic: true,
          dynamicKind: 'value-ref',
        }),
      );
    });

    it('does not extract a value-ref call when the variable is never referenced again', () => {
      const symbols = parseJS(`
        const fetchFn = options.custom || fetchLatestVersion;
        console.log('unrelated');
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    it('extracts value-ref calls for both ternary branches when the variable is used again', () => {
      const symbols = parseJS(`
        const picked = cond ? left : right;
        call(picked);
      `);
      const names = symbols.calls.filter((c) => c.dynamicKind === 'value-ref').map((c) => c.name);
      expect(names).toContain('left');
      expect(names).toContain('right');
    });

    it('extracts a value-ref call for a nullish-coalescing fallback', () => {
      const symbols = parseJS(`
        const fetchFn = options.custom ?? fetchLatestVersion;
        call(fetchFn);
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(true);
    });

    // Greptile review, PR #2432: a same-named binding declared in a nested
    // scope must not be mistaken for a reference to the outer fallback
    // variable.
    it('does not credit liveness from a same-named binding shadowed in a nested scope', () => {
      const symbols = parseJS(`
        function outer() {
          const fetchFn = options.custom || fetchLatestVersion;
          function helper() {
            let fetchFn = somethingElse();
            return fetchFn();
          }
        }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    // Greptile review, PR #2432: a reference in a sibling declarator of the
    // SAME comma-separated declaration must still count.
    it('extracts a value-ref call when the variable is used by a sibling declarator in the same statement', () => {
      const symbols = parseJS(
        `const fetchFn = options.custom || fetchLatestVersion, result = fetchFn();`,
      );
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(true);
    });

    // Greptile review, PR #2432: the liveness scan's recursive walk must be
    // depth-bounded (MAX_WALK_DEPTH), matching every other recursive walk in
    // this file, so a pathologically deep enclosing block (e.g. deeply
    // nested generated JS) can't overflow the stack.
    it('does not overflow the stack on a pathologically deep enclosing block', () => {
      const depth = 300;
      const nested = `${'if (true) {\n'.repeat(depth)}call(fetchFn);\n${'}\n'.repeat(depth)}`;
      const source = `const fetchFn = options.custom || fetchLatestVersion;\n${nested}`;
      expect(() => parseJS(source)).not.toThrow();
    });

    // Greptile review, PR #2432: a default-value expression referencing the
    // outer fallback variable is a REFERENCE (a real use), not a shadowing
    // parameter binding — must not be pruned from the liveness scan.
    it('does not treat a parameter default reference as a shadowing binding', () => {
      const symbols = parseJS(`
        function outer() {
          const fetchFn = options.custom || fetchLatestVersion;
          function helper(x = fetchFn) {
            return x();
          }
        }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(true);
    });

    // Greptile review, PR #2432: a legal `var` sibling rebinding the SAME
    // name in the same statement (`var fn = a, fn = b;`) is a binding, not a
    // read — must not fabricate liveness for the first declarator's fallback.
    it('does not credit liveness from a var sibling rebinding the same name', () => {
      const symbols = parseJS(`var fn = options.custom || fetchLatestVersion, fn = replacement;`);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    // Greptile review, PR #2432: a block-local function declaration also
    // introduces its own binding — a call to it inside that block must not
    // be mistaken for a use of the outer fallback variable sharing its name.
    it('does not credit liveness from a block-local function declaration sharing the name', () => {
      const symbols = parseJS(`
        const fn = options.custom || fetchLatestVersion;
        {
          function fn() {}
          fn();
        }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    // Greptile review, PR #2432: a plain `=` reassignment overwrites the
    // variable without ever consuming its current value — must not
    // fabricate liveness for the fallback that was assigned to it.
    it('does not credit liveness from a write-only reassignment', () => {
      const symbols = parseJS(`
        let fn = options.custom || fetchLatestVersion;
        fn = replacement;
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    // A compound assignment (`+=`, `||=`, etc.) DOES read the current value
    // before writing, so its left-hand identifier is a real reference and
    // must still count.
    it('credits liveness from a compound assignment reference', () => {
      const symbols = parseJS(`
        let fn = options.custom || fetchLatestVersion;
        fn += 1;
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(true);
    });

    // Greptile review, PR #2432: overwriting a fallback variable through
    // OBJECT destructuring is still a WRITE, not a read — the same as a
    // plain `fn = replacement`.
    it('does not credit liveness from a write-only object destructuring reassignment', () => {
      const symbols = parseJS(`
        let fn = options.custom || fetchLatestVersion;
        ({ fn } = replacement);
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    // Same as above, for ARRAY destructuring.
    it('does not credit liveness from a write-only array destructuring reassignment', () => {
      const symbols = parseJS(`
        let fn = options.custom || fetchLatestVersion;
        [fn] = replacement;
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    // Greptile review, PR #2432: patternBindsName's own recursive descent
    // through nested destructuring patterns must be depth-bounded too, like
    // every other recursive walk in this file (MAX_WALK_DEPTH) — a
    // pathologically deep array/object pattern must not overflow the stack.
    it('does not overflow the stack on a pathologically deep destructuring pattern', () => {
      const depth = 300;
      const pattern = `${'['.repeat(depth)}fn${']'.repeat(depth)}`;
      const source = `let fn = options.custom || fetchLatestVersion;\n${pattern} = replacement;`;
      expect(() => parseJS(source)).not.toThrow();
    });

    // Greptile review, PR #2432: a destructuring default that READS the
    // outer fallback variable (`const { value = fn } = input;`) must not be
    // mistaken for a binding of `fn` when deciding whether a nested block
    // shadows it — the read must still be found.
    it('does not treat a destructuring default reference as a shadowing declaration', () => {
      const symbols = parseJS(`
        const fn = options.custom || fetchLatestVersion;
        {
          const { value = fn } = input;
        }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(true);
    });

    // Greptile review, PR #2432: `({ fn = fn } = replacement)` both WRITES
    // `fn` and READS its previous value as the default — the write must not
    // suppress the read.
    it('credits liveness from a default read inside a destructuring write', () => {
      const symbols = parseJS(`
        let fn = options.custom || fetchLatestVersion;
        ({ fn = fn } = replacement);
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(true);
    });

    // Greptile review, PR #2432: a `var` is hoisted, so a reference in an
    // earlier sibling statement executes BEFORE the fallback is assigned and
    // reads the pre-assignment value, not the fallback — must not fabricate
    // liveness for it.
    it('does not credit liveness from a reference before a hoisted var initializer', () => {
      const symbols = parseJS(`
        fn();
        var fn = options.custom || fetchLatestVersion;
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    // A reference in a LATER sibling statement is exactly the liveness
    // evidence this mechanism requires — the position filter above must not
    // suppress it too.
    it('still credits liveness from a reference after the declaration', () => {
      const symbols = parseJS(`
        var fn = options.custom || fetchLatestVersion;
        fn();
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(true);
    });

    // Greptile review, PR #2432: all `case`/`default` clauses in a switch
    // share ONE lexical scope. An UNBRACED case's own `let` declaration of
    // the SAME name shadows the outer fallback variable for the whole
    // switch, even though it isn't wrapped in its own block.
    it('does not credit liveness from an unbraced switch-case shadowing the name', () => {
      const symbols = parseJS(`
        const fn = options.custom || fetchLatestVersion;
        switch (x) {
          case 1:
            let fn = 1;
            fn();
            break;
        }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    // Greptile review, PR #2432: `var` is function-scoped, not switch-scoped
    // — a `var fn` redeclaration in one case is the SAME outer binding, not
    // a distinct shadow, so it must not suppress a genuine read in a
    // DIFFERENT, unrelated case.
    it('still credits liveness from a switch-case read when another case redeclares the name via var', () => {
      const symbols = parseJS(`
        function outer() {
          var fn = options.custom || fetchLatestVersion;
          switch (x) {
            case 1:
              fn();
              break;
            case 2:
              var fn = something;
              break;
          }
        }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(true);
    });

    // The flip side of the var-is-function-scoped model: because `var` hoists
    // to the FUNCTION
    // scope, a nested function declaring `var fn` at ANY depth in its body
    // shadows the outer `fn` for that whole function — including a read that
    // sits outside the block physically containing the `var`.
    it('does not credit liveness from a nested function that hoists its own var deeper down', () => {
      const symbols = parseJS(`
        function outer() {
          var fn = options.custom || fetchLatestVersion;
          function inner(flag) {
            if (flag) { var fn = 1; }
            return fn();
          }
        }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    // Greptile review, PR #2432: a `for (let fn of …)` head declares its own
    // per-iteration binding, so the body's read is of that binding. The
    // grammar exposes the declaration as a `kind` FIELD rather than a
    // `variable_declaration` child, which is why this needs handling on the
    // for-in/of node itself.
    it('does not credit liveness from a for-of loop that declares its own binding', () => {
      const symbols = parseJS(`
        const fn = options.custom || fetchLatestVersion;
        for (let fn of values) { fn(); }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    // A for-in/of head that binds the name kills the pre-loop value, so the
    // BODY can never be reading it — only `right` still can.
    it('does not credit liveness from a for-of body read of a bare loop target', () => {
      const symbols = parseJS(`
        let fn = options.custom || fetchLatestVersion;
        for (fn of values) { fn(); }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    // …but `right` IS evaluated in the enclosing scope, so a genuine read
    // there must still count.
    it('credits liveness from a for-of right-hand side read in the enclosing scope', () => {
      const symbols = parseJS(`
        const fn = options.custom || fetchLatestVersion;
        for (const item of fn()) { use(item); }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(true);
    });

    // Greptile review, PR #2432: `for (fn of values) {}` / `for (fn in obj)
    // {}` with NO declaration keyword reassigns fn on every iteration — a
    // WRITE, not a read of the value it held before the loop started.
    it('does not credit liveness from a for-of loop write target', () => {
      const symbols = parseJS(`
        const fn = options.custom || fetchLatestVersion;
        for (fn of values) {}
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    it('does not credit liveness from a for-in loop write target', () => {
      const symbols = parseJS(`
        const fn = options.custom || fetchLatestVersion;
        for (fn in obj) {}
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    // Using the fallback variable as the ITERABLE (not the loop target) is
    // a genuine read and must still count.
    it('still credits liveness when the fallback variable is the for-of iterable', () => {
      const symbols = parseJS(`
        const fn = options.custom || fetchLatestVersion;
        for (const x of fn) {}
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(true);
    });

    // Greptile review, PR #2432: with a hoisted declaration like
    // `var result = fn(), fn = custom || fallback`, the EARLIER sibling
    // declarator's initializer runs before this one is assigned — it
    // cannot have consumed a value that doesn't exist yet.
    it('does not credit liveness from an earlier sibling declarator in the same statement', () => {
      const symbols = parseJS(`
        var result = fn(), fn = options.custom || fetchLatestVersion;
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    // Greptile review, PR #2432: `var` is function-scoped, so a `var`
    // redeclaration anywhere in a nested block is the SAME binding as an
    // outer `var` of the same name — it must not prune a genuine read
    // elsewhere in that same block (here, one that textually precedes the
    // redeclaration).
    it('still credits liveness from a read in a nested block that also redeclares the name via var', () => {
      const symbols = parseJS(`
        function outer() {
          var fn = options.custom || fetchLatestVersion;
          {
            fn();
            var fn = something;
          }
        }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(true);
    });

    // A C-style for-loop whose own init clause rebinds the name via `var` is
    // the SAME function-scoped binding — and that is precisely why it KILLS
    // the fallback value rather than reading it: `var fn = 0` runs before the
    // test/update clauses, so `fn < 10` and `fn++` only ever see the number.
    // Verified at runtime: `typeof fn` inside that loop is always `number`,
    // and the fallback function is never invoked. Crediting liveness here
    // would fabricate an edge for a value that is assigned and immediately
    // overwritten without ever being consumed.
    //
    // A loop that does NOT rebind the name is unaffected — `for (var i = 0;
    // i < 10; i++) { fn(); }` still credits the body's genuine read.
    it('does not credit liveness from a for-loop whose own var init overwrote the value', () => {
      const symbols = parseJS(`
        function outer() {
          var fn = options.custom || fetchLatestVersion;
          for (var fn = 0; fn < 10; fn++) {}
        }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    // Greptile review, PR #2440: only an INITIALIZER overwrites the value. A
    // bare `var fn;` redeclaration in the loop head assigns nothing, so it is
    // not a kill and the body's read is genuine.
    it('credits liveness from a for-loop body read when the head redeclares the name without initializing it', () => {
      const symbols = parseJS(`
        function outer() {
          var fn = options.custom || fetchLatestVersion;
          for (var fn; cond; update) { fn(); }
        }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(true);
    });

    // A sibling declarator BEFORE the killing one runs before the overwrite,
    // so its read is genuine.
    it('credits liveness from a for-head sibling initializer that runs before the kill', () => {
      const symbols = parseJS(`
        function outer() {
          var fn = options.custom || fetchLatestVersion;
          for (var a = fn(), fn = 0; fn < 3; fn++) {}
        }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(true);
    });

    // …but a sibling declarator AFTER the killing one reads the NEW value.
    it('does not credit liveness from a for-head sibling initializer that runs after the kill', () => {
      const symbols = parseJS(`
        function outer() {
          var fn = options.custom || fetchLatestVersion;
          for (var fn = 0, a = fn(); fn < 3; fn++) {}
        }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    // The killing declarator's own initializer still reads the pre-loop value.
    it('credits liveness from a for-head initializer that reads the value it overwrites', () => {
      const symbols = parseJS(`
        function outer() {
          var fn = options.custom || fetchLatestVersion;
          for (var fn = fn; cond; update) {}
        }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(true);
    });

    // …and the guard for that last sentence: a loop counter with a DIFFERENT
    // name must not suppress a real read in the loop body.
    it('credits liveness from a loop body read when the loop counter is a different name', () => {
      const symbols = parseJS(`
        function outer() {
          var fn = options.custom || fetchLatestVersion;
          for (var i = 0; i < 10; i++) { fn(); }
        }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(true);
    });

    // A `let`/`const` declaring for-in loop variable IS a genuinely distinct
    // block-scoped binding (unlike `var`) — it must still shadow correctly.
    it('does not credit liveness from a let-declared for-in loop variable', () => {
      const symbols = parseJS(`
        function outer() {
          const fn = options.custom || fetchLatestVersion;
          for (let fn in obj) {
            doSomething(fn);
          }
        }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    // Greptile review, PR #2440: a `let`/`const` for-of target creates a
    // BRAND-NEW per-iteration binding for `name` — a default hidden inside
    // that SAME destructuring pattern which mentions `name` resolves to that
    // new binding (in the temporal dead zone until its own position
    // initializes it), never to the enclosing fallback. Verified at runtime:
    // `let [fn = fn] = [undefined]` throws "Cannot access 'fn' before
    // initialization" — it never reads the outer `fn`.
    it('does not credit liveness from a lexical destructuring default that self-references the loop target', () => {
      const symbols = parseJS(`
        function outer() {
          var fn = options.custom || fetchLatestVersion;
          for (const [fn = fn] of values) { fn(); }
        }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(false);
    });

    // …but a `var` target reuses the SAME pre-existing binding (no new
    // scope), so the identical shape still reads the current,
    // soon-to-be-overwritten value — this must stay credited.
    it('still credits liveness from a var destructuring default that self-references the loop target', () => {
      const symbols = parseJS(`
        function outer() {
          var fn = options.custom || fetchLatestVersion;
          for (var [fn = fn] of values) {}
        }
      `);
      expect(
        symbols.calls.some((c) => c.dynamicKind === 'value-ref' && c.name === 'fetchLatestVersion'),
      ).toBe(true);
    });
  });

  describe('computed/bracket-access dispatch-table invocation evidence (#2260)', () => {
    // This mechanism's Call extraction is UNCONDITIONAL (like #1771/#1895 —
    // every bare-identifier object-literal property value always produces a
    // value-ref Call, regardless of liveness); only the RESOLVER (build-edges.ts
    // / incremental.ts) later gates whether that Call becomes a real edge,
    // consulting invokedPropertyNames/computedDispatchTableEvidence at that
    // point — NOT here. So the correct thing to assert at the extractor level
    // is computedDispatchTableEvidence's own contents (what THIS mechanism
    // actually decides), not the calls array (which is always populated
    // either way) — the full end-to-end edge-creation behavior is covered by
    // the dual-engine integration test instead.

    // The confirmed real-world case: an AST-node-type-keyed dispatch table
    // (src/extractors/groovy.ts's GROOVY_NODE_HANDLERS), consumed via a
    // computed lookup stored in an intermediate variable, then called.
    it('records the table name when the intermediate variable is later called', () => {
      const symbols = parseJS(`
        const NODE_HANDLERS = {
          interface_definition: handleInterfaceDecl,
        };
        function walkNode(node, ctx) {
          const handler = NODE_HANDLERS[node.type];
          if (handler) handler(node, ctx);
        }
      `);
      expect(symbols.computedDispatchTableEvidence).toEqual(['NODE_HANDLERS']);
    });

    it('does not record the table name when the intermediate variable is only referenced, never called', () => {
      const symbols = parseJS(`
        const NODE_HANDLERS = {
          interface_definition: handleInterfaceDecl,
        };
        function walkNode(node, ctx) {
          const handler = NODE_HANDLERS[node.type];
          console.log(handler);
        }
      `);
      expect(symbols.computedDispatchTableEvidence).toBeUndefined();
    });

    it('does not fire for a string-literal key — already handled by the existing computed-literal path', () => {
      const symbols = parseJS(`
        const NODE_HANDLERS = {
          interface_definition: handleInterfaceDecl,
        };
        function walkNode() {
          const handler = NODE_HANDLERS['interface_definition'];
          handler();
        }
      `);
      expect(symbols.computedDispatchTableEvidence).toBeUndefined();
    });

    it('does not record the table name when the call is inside a nested scope that shadows the intermediate variable', () => {
      const symbols = parseJS(`
        const NODE_HANDLERS = {
          interface_definition: handleInterfaceDecl,
        };
        function walkNode(node, ctx) {
          const handler = NODE_HANDLERS[node.type];
          {
            let handler = unrelatedFn;
            handler();
          }
        }
      `);
      expect(symbols.computedDispatchTableEvidence).toBeUndefined();
    });

    it('resolves the table name through a parenthesized/as-const wrapper', () => {
      const symbols = parseJS(`
        const NODE_HANDLERS = ({
          interface_definition: handleInterfaceDecl,
        } as const);
        function walkNode(node, ctx) {
          const handler = NODE_HANDLERS[node.type];
          handler();
        }
      `);
      expect(symbols.computedDispatchTableEvidence).toEqual(['NODE_HANDLERS']);
    });

    it('only records the specific table that has its own computed-invocation evidence', () => {
      const symbols = parseJS(`
        const HANDLERS_A = {
          interface_definition: handleA,
        };
        const HANDLERS_B = {
          interface_definition: handleB,
        };
        function walkNode(node, ctx) {
          const handler = HANDLERS_A[node.type];
          handler();
        }
      `);
      expect(symbols.computedDispatchTableEvidence).toEqual(['HANDLERS_A']);
    });

    it('does not overflow the stack on a pathologically deep enclosing block', () => {
      const depth = 300;
      const nested = `${'if (true) {\n'.repeat(depth)}handler();\n${'}\n'.repeat(depth)}`;
      const source = `
        const NODE_HANDLERS = { interface_definition: handleInterfaceDecl };
        function walkNode(node) {
          const handler = NODE_HANDLERS[node.type];
          ${nested}
        }
      `;
      expect(() => parseJS(source)).not.toThrow();
    });
  });

  describe('inline object-literal dispatch table extraction (RES-2, #1897)', () => {
    // Mirrors the Rust `dispatch_table_emits_dt_call_and_array_elem_bindings`
    // / `dispatch_table_parenthesized_object_also_works` unit tests in
    // crates/codegraph-core/src/extractors/javascript.rs.
    it('emits a <dt_line_col>[*] call and array-elem bindings for each identifier value', () => {
      const symbols = parseJS(`
        function dtFn1() {}
        function dtFn2() {}
        function runDispatch(key) { ({ a: dtFn1, b: dtFn2 })[key](); }
      `);
      const dtCall = symbols.calls.find(
        (c) => c.name.startsWith('<dt_') && c.name.endsWith('>[*]'),
      );
      expect(dtCall).toBeDefined();
      expect(dtCall?.dynamic).toBe(true);
      expect(dtCall?.dynamicKind).toBe('dispatch-table');
      expect(dtCall?.keyExpr).toBe('key');

      const tableName = dtCall!.name.slice(0, -3); // strip trailing "[*]"
      expect(symbols.arrayElemBindings).toContainEqual({
        arrayName: tableName,
        index: 0,
        elemName: 'dtFn1',
      });
      expect(symbols.arrayElemBindings).toContainEqual({
        arrayName: tableName,
        index: 1,
        elemName: 'dtFn2',
      });
    });

    it('also detects the pattern without wrapping parens in a non-ambiguous expression position', () => {
      // `{...}` needs parens only where it would otherwise be parsed as a
      // block (statement position). In a `return` expression it's already
      // unambiguous, so the object node is not wrapped in a
      // parenthesized_expression — exercising the non-unwrap branch of
      // extractDispatchTableCall, the mirror image of the first test above.
      const symbols = parseJS(`
        function fnA() {}
        function fnB() {}
        function run(k) { return { a: fnA, b: fnB }[k](); }
      `);
      const dtCall = symbols.calls.find(
        (c) => c.name.startsWith('<dt_') && c.name.endsWith('>[*]'),
      );
      expect(dtCall).toBeDefined();
    });

    it('resolves the shorthand-property form (`{ fnA, fnB }[k]()`)', () => {
      const symbols = parseJS(`
        function fnA() {}
        function fnB() {}
        function run(k) { ({ fnA, fnB })[k](); }
      `);
      const dtCall = symbols.calls.find(
        (c) => c.name.startsWith('<dt_') && c.name.endsWith('>[*]'),
      );
      expect(dtCall).toBeDefined();
      const tableName = dtCall!.name.slice(0, -3);
      expect(symbols.arrayElemBindings).toContainEqual({
        arrayName: tableName,
        index: 0,
        elemName: 'fnA',
      });
      expect(symbols.arrayElemBindings).toContainEqual({
        arrayName: tableName,
        index: 1,
        elemName: 'fnB',
      });
    });

    it('falls back to the generic computed-key classification for a non-literal object', () => {
      const symbols = parseJS(`function run(handlers, key) { return handlers[key](); }`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: '<dynamic:computed-key>', dynamicKind: 'computed-key' }),
      );
      expect(symbols.calls.find((c) => c.dynamicKind === 'dispatch-table')).toBeUndefined();
    });

    it('does not treat a string-literal key on an object literal as a dispatch table', () => {
      const symbols = parseJS(`
        function fnA() {}
        function run() { return ({ a: fnA })['a'](); }
      `);
      expect(symbols.calls.find((c) => c.dynamicKind === 'dispatch-table')).toBeUndefined();
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'a', dynamicKind: 'computed-literal' }),
      );
    });
  });

  describe('var/const-assigned function Definition.line/column (#2265)', () => {
    it('gives each declarator in a multi-declarator statement its own function-node line, not the statement start', () => {
      const symbols = parseJS(`
        const a = (x) => {
          if (x) { return 1; }
          return 0;
        }, b = (x) => {
          return 2;
        };
        a(1); b(2);
      `);
      const a = symbols.definitions.find((d) => d.name === 'a');
      const b = symbols.definitions.find((d) => d.name === 'b');
      expect(a?.line).toBe(2);
      expect(b?.line).toBe(5);
      expect(a?.line).not.toBe(b?.line);
    });

    it('records each declarator its own start column, distinct even on a shared line', () => {
      const symbols = parseJS(
        `const a = (y) => { return y; }, b = (y) => { if (y) { return 1; } return 0; };`,
      );
      const a = symbols.definitions.find((d) => d.name === 'a');
      const b = symbols.definitions.find((d) => d.name === 'b');
      expect(a?.line).toBe(b?.line);
      expect(a?.column).toBeDefined();
      expect(b?.column).toBeDefined();
      expect(a?.column).not.toBe(b?.column);
    });

    it('uses the function-expression value node line for a single named/anonymous function-expression declarator too', () => {
      const symbols = parseJS(`const solo = function (x) { return x; };`);
      const solo = symbols.definitions.find((d) => d.name === 'solo');
      // Single-declarator statement: statement start and value-node start
      // coincide here, so this must keep passing unchanged by the #2265 fix.
      expect(solo?.line).toBe(1);
    });
  });

  describe('instanceof value-ref extraction (#1784)', () => {
    it('extracts a value-ref call for `instanceof ClassName`', () => {
      const symbols = parseJS(`
        function handle(err) {
          if (err instanceof CodegraphError) { report(err); }
        }
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({
          name: 'CodegraphError',
          dynamic: true,
          dynamicKind: 'value-ref',
        }),
      );
    });

    it('extracts a value-ref call for `instanceof` used as an expression value', () => {
      const symbols = parseJS(`const isConfig = (err) => err instanceof ConfigError;`);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'ConfigError', dynamic: true, dynamicKind: 'value-ref' }),
      );
    });

    it('does not extract a value-ref call for a member-expression right operand', () => {
      const symbols = parseJS(`const check = (a) => a instanceof ns.SomeClass;`);
      expect(symbols.calls).not.toContainEqual(
        expect.objectContaining({ dynamicKind: 'value-ref', name: 'SomeClass' }),
      );
    });

    it('does not extract a value-ref call for a call-expression right operand', () => {
      const symbols = parseJS(`const check = (a) => a instanceof getClass();`);
      expect(symbols.calls.filter((c) => c.dynamicKind === 'value-ref')).toHaveLength(0);
    });

    it('excludes builtin globals from instanceof value-ref extraction', () => {
      const symbols = parseJS(`
        function isBuiltin(x) {
          return x instanceof Error || x instanceof Array || x instanceof Map;
        }
      `);
      expect(symbols.calls.filter((c) => c.dynamicKind === 'value-ref')).toHaveLength(0);
    });

    it('does not extract a value-ref call for the unrelated `in` operator', () => {
      const symbols = parseJS(`const has = (obj) => 'key' in obj;`);
      expect(symbols.calls.filter((c) => c.dynamicKind === 'value-ref')).toHaveLength(0);
    });

    it('does not extract a value-ref call for other binary operators', () => {
      const symbols = parseJS(`const sum = (a, b) => a + b === Total;`);
      expect(symbols.calls.filter((c) => c.dynamicKind === 'value-ref')).toHaveLength(0);
    });
  });

  describe('Phase 8.3f: object-destructuring rest parameter binding extraction', () => {
    function parseJS(code) {
      const parser = parsers.get('javascript');
      const tree = parser.parse(code);
      return extractSymbols(tree, 'test.js');
    }

    it('extracts rest binding from object-destructuring function parameter', () => {
      const symbols = parseJS(`
        function f3({ e1: eee1, ...eerest }) {
          eerest.e4();
        }
        f3(obj);
      `);
      expect(symbols.objectRestParamBindings).toBeDefined();
      expect(symbols.objectRestParamBindings).toContainEqual({
        callee: 'f3',
        restName: 'eerest',
        argIndex: 0,
      });
    });

    it('extracts rest binding from arrow function with object-destructuring parameter', () => {
      const symbols = parseJS(`
        const handler = ({ a, ...rest }) => { rest.b(); };
        handler(obj);
      `);
      expect(symbols.objectRestParamBindings).toBeDefined();
      expect(symbols.objectRestParamBindings).toContainEqual({
        callee: 'handler',
        restName: 'rest',
        argIndex: 0,
      });
    });

    it('records correct argIndex when rest param is not the first parameter', () => {
      const symbols = parseJS(`
        function g(x, { a, ...rest }) { rest.b(); }
        g(1, obj);
      `);
      expect(symbols.objectRestParamBindings).toContainEqual({
        callee: 'g',
        restName: 'rest',
        argIndex: 1,
      });
    });

    it('does not emit binding when object pattern has no rest element', () => {
      const symbols = parseJS(`
        function h({ a, b }) { a(); }
        h(obj);
      `);
      expect(symbols.objectRestParamBindings ?? []).not.toContainEqual(
        expect.objectContaining({ callee: 'h' }),
      );
    });

    it('seeds composite typeMap keys from object literal with shorthand properties', () => {
      const symbols = parseJS(`
        function e4() {}
        var obj = { e4 };
      `);
      expect(symbols.typeMap.get('obj.e4')).toEqual({ type: 'e4', confidence: 0.85 });
    });

    it('seeds composite typeMap keys from object literal with pair properties', () => {
      const symbols = parseJS(`
        function handler() {}
        var routes = { get: handler };
      `);
      expect(symbols.typeMap.get('routes.get')).toEqual({ type: 'handler', confidence: 0.85 });
    });

    // Issue #1551: let/var object-literal method definitions must seed typeMap entries
    it('seeds composite typeMap keys for let-declared object-literal method shorthand', () => {
      const symbols = parseJS(`
        let obj = { f() { return 1; } };
        obj.f();
      `);
      expect(symbols.typeMap.get('obj.f')).toBeDefined();
    });

    it('extracts rest binding from a class method', () => {
      const symbols = parseJS(`
        class Service {
          handle({ event, ...rest }) {
            rest.save();
          }
        }
      `);
      expect(symbols.objectRestParamBindings).toContainEqual({
        callee: 'Service.handle',
        restName: 'rest',
        argIndex: 0,
      });
    });

    it('extracts rest binding from object-literal shorthand method', () => {
      const symbols = parseJS(`
        const api = {
          process({ items, ...rest }) {
            rest.flush();
          }
        };
      `);
      expect(symbols.objectRestParamBindings).toContainEqual({
        callee: 'process',
        restName: 'rest',
        argIndex: 0,
      });
    });

    it('extracts rest binding from object-literal pair with function value', () => {
      const symbols = parseJS(`
        const api = {
          process: function({ items, ...rest }) {
            rest.flush();
          }
        };
      `);
      expect(symbols.objectRestParamBindings).toContainEqual({
        callee: 'process',
        restName: 'rest',
        argIndex: 0,
      });
    });

    it('uses unqualified method name for class method with no class name', () => {
      const symbols = parseJS(`
        export default class {
          handle({ a, ...rest }) { rest.b(); }
        }
      `);
      expect(symbols.objectRestParamBindings).toContainEqual(
        expect.objectContaining({ restName: 'rest', argIndex: 0 }),
      );
    });
  });

  // #2080: tree-sitter-typescript wraps EVERY parameter — typed or not — in
  // a required_parameter/optional_parameter node (confirmed by parsing
  // `function f({ ...rest }) {}` with the TS grammar, which still wraps
  // despite no type annotation), unlike plain tree-sitter-javascript where
  // object_pattern is a direct formal_parameters child. Without unwrapping,
  // object-rest-param bindings were silently never recorded for ANY .ts/.tsx
  // file — the describe block above only ever exercised the .js grammar.
  describe('Phase 8.3f + #2080: object-rest-param binding extraction in TypeScript', () => {
    function parseTS(code) {
      const parser = parsers.get('typescript');
      const tree = parser.parse(code);
      return extractSymbols(tree, 'test.ts');
    }

    it('extracts rest binding from an untyped object-destructuring parameter', () => {
      const symbols = parseTS(`
        function f3({ e1: eee1, ...eerest }) {
          eerest.e4();
        }
        f3(obj);
      `);
      expect(symbols.objectRestParamBindings).toContainEqual({
        callee: 'f3',
        restName: 'eerest',
        argIndex: 0,
      });
    });

    it('extracts rest binding from a type-annotated object-destructuring parameter', () => {
      const symbols = parseTS(`
        function dispatchRest({ ...rest }: IWorker) {
          rest.doWork();
        }
      `);
      expect(symbols.objectRestParamBindings).toContainEqual({
        callee: 'dispatchRest',
        restName: 'rest',
        argIndex: 0,
      });
    });

    it('seeds a direct typeMap entry for the rest binding from its type annotation', () => {
      const symbols = parseTS(`
        function dispatchRest({ ...rest }: IWorker) {
          rest.doWork();
        }
      `);
      expect(symbols.typeMap.get('rest')).toEqual({ type: 'IWorker', confidence: 0.9 });
    });

    it('does not seed a typeMap entry for an untyped rest binding', () => {
      const symbols = parseTS(`
        function f3({ ...rest }) {
          rest.go();
        }
      `);
      expect(symbols.typeMap.has('rest')).toBe(false);
    });

    // Review finding: a named property alongside the rest element excludes
    // that property from rest's real type (`Omit<IWorker, 'doWork'>`), so
    // seeding the full IWorker type onto `rest` would let a call like
    // `rest.doWork()` — invalid, since doWork was destructured away —
    // falsely resolve via CHA dispatch.
    it('does not seed the full annotation type when a sibling property is destructured out', () => {
      const symbols = parseTS(`
        function f({ doWork, ...rest }: IWorker) {
          rest.other();
        }
      `);
      expect(symbols.typeMap.has('rest')).toBe(false);
    });

    it('still records the object-rest-param binding when a sibling property is present', () => {
      const symbols = parseTS(`
        function f({ doWork, ...rest }: IWorker) {
          rest.other();
        }
      `);
      expect(symbols.objectRestParamBindings).toContainEqual({
        callee: 'f',
        restName: 'rest',
        argIndex: 0,
      });
    });

    it('records correct argIndex for a type-annotated rest param that is not first', () => {
      const symbols = parseTS(`
        function g(x: number, { ...rest }: IWorker) { rest.doWork(); }
      `);
      expect(symbols.objectRestParamBindings).toContainEqual({
        callee: 'g',
        restName: 'rest',
        argIndex: 1,
      });
    });
  });

  describe('prototype method extraction', () => {
    it('extracts Foo.prototype.bar = function() {} as a method definition', () => {
      const symbols = parseJS(`
        function C() {}
        C.prototype.foo = function() {}
      `);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'C.foo', kind: 'method' }),
      );
    });

    it('extracts Foo.prototype.bar = arrow as a method definition', () => {
      const symbols = parseJS(`
        function C() {}
        C.prototype.greet = () => 'hello';
      `);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'C.greet', kind: 'method' }),
      );
    });

    it('seeds typeMap for Foo.prototype.bar = identifier with confidence 0.9', () => {
      const symbols = parseJS(`
        const f = () => {};
        class A {}
        A.prototype.t = f;
      `);
      expect(symbols.typeMap.get('A.t')).toEqual({ type: 'f', confidence: 0.9 });
    });

    it('extracts methods from Foo.prototype = { bar: fn } object literal', () => {
      const symbols = parseJS(`
        function C() {}
        C.prototype = {
          foo: function() {},
          baz: function() {},
        };
      `);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'C.foo', kind: 'method' }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'C.baz', kind: 'method' }),
      );
    });

    it('seeds typeMap for identifier values in object literal prototype assignment', () => {
      const symbols = parseJS(`
        function helper() {}
        function C() {}
        C.prototype = { run: helper };
      `);
      expect(symbols.typeMap.get('C.run')).toEqual({ type: 'helper', confidence: 0.9 });
    });

    it('does not extract prototype assignments on built-in globals', () => {
      const symbols = parseJS(
        `Array.prototype.last = function() { return this[this.length - 1]; };`,
      );
      expect(symbols.definitions).not.toContainEqual(
        expect.objectContaining({ name: 'Array.last' }),
      );
    });

    it('does not seed typeMap for prototype identifier assignment from built-in globals', () => {
      const symbols = parseJS(`Object.prototype.clone = myClone;`);
      expect(symbols.typeMap.has('Object.clone')).toBe(false);
    });

    it('seeds typeMap for shorthand property in prototype object literal', () => {
      const symbols = parseJS(`
        function helper() {}
        function C() {}
        C.prototype = { helper };
      `);
      expect(symbols.typeMap.get('C.helper')).toEqual({ type: 'helper', confidence: 0.9 });
    });
  });

  describe('function-as-object property method extraction (#1334)', () => {
    it('extracts fn.method = function() {} as a method definition', () => {
      const symbols = parseJS(`
        function f() {}
        f.g = function() { console.log("2"); }
      `);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'f.g', kind: 'method' }),
      );
    });

    it('extracts fn.method = () => {} as a method definition', () => {
      const symbols = parseJS(`
        function f() {}
        f.g = () => 42;
      `);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'f.g', kind: 'method' }),
      );
    });

    it('extracts the this.g() call inside f.h', () => {
      const symbols = parseJS(`
        function f() {}
        f.g = function() {}
        f.h = function() { this.g(); }
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'g', receiver: 'this' }),
      );
    });

    it('does not extract func-prop assignments on built-in globals', () => {
      const symbols = parseJS(`console.log = function() {};`);
      expect(symbols.definitions).not.toContainEqual(
        expect.objectContaining({ name: 'console.log' }),
      );
    });

    it('does not extract .prototype property assignments (handled by prototype walk)', () => {
      const symbols = parseJS(`
        function C() {}
        C.prototype = function() {};
      `);
      expect(symbols.definitions).not.toContainEqual(
        expect.objectContaining({ name: 'C.prototype' }),
      );
    });
  });

  describe('Phase 8.3e: extractSpreadForOfWalk — exported arrow function funcStack (#1354)', () => {
    it('tracks plain const arrow function on funcStack for for-of loop', () => {
      const symbols = parseJS(`const f = (arr) => { for (const x of arr) x(); };`);
      expect(symbols.forOfBindings).toContainEqual(expect.objectContaining({ enclosingFunc: 'f' }));
    });

    it('tracks func-prop assignment on funcStack for for-of loop (#1373)', () => {
      const symbols = parseJS(`
        const obj = {};
        obj.run = function(callbacks) {
          for (const cb of callbacks) cb();
        };
      `);
      expect(symbols.forOfBindings).toContainEqual(
        expect.objectContaining({
          varName: 'cb',
          sourceName: 'callbacks',
          enclosingFunc: 'obj.run',
        }),
      );
    });

    it('tracks exported const arrow function on funcStack for for-of loop', () => {
      const symbols = parseJS(`export const f = (arr) => { for (const x of arr) x(); };`);
      expect(symbols.forOfBindings).toContainEqual(expect.objectContaining({ enclosingFunc: 'f' }));
    });

    it('records correct varName and sourceName for exported arrow for-of', () => {
      const symbols = parseJS(
        `export const handleItems = (items) => { for (const cb of items) cb(); };`,
      );
      expect(symbols.forOfBindings).toContainEqual(
        expect.objectContaining({
          varName: 'cb',
          sourceName: 'items',
          enclosingFunc: 'handleItems',
        }),
      );
    });
  });

  describe('class expression extends + static block + field def extraction', () => {
    it('extracts extends relationship from named class expression', () => {
      const symbols = parseJS(
        `function make() { return class Child extends Parent { m() { super.m(); } } }`,
      );
      expect(symbols.classes).toContainEqual(
        expect.objectContaining({ name: 'Child', extends: 'Parent' }),
      );
    });

    it('extracts methods from named class expression', () => {
      const symbols = parseJS(`const X = class Foo extends Base { bar() { return 1; } }`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'Foo.bar', kind: 'method' }),
      );
    });

    it('records super.method() call with receiver=super from class expression method', () => {
      const symbols = parseJS(`const X = class Child extends Parent { m() { super.m(); } }`);
      const superCall = symbols.calls.find((c) => c.name === 'm' && c.receiver === 'super');
      expect(superCall).toBeDefined();
    });

    it('creates ClassName.<static:L:C> definition for class static block', () => {
      const symbols = parseJS(`class A extends B {\n  static {\n    super.init();\n  }\n}`);
      // Name includes line:column suffix for uniqueness
      const staticDef = symbols.definitions.find((d) => d.name.startsWith('A.<static:'));
      expect(staticDef).toBeDefined();
      expect(staticDef).toMatchObject({ kind: 'method' });
    });

    it('attributes super.method() call inside static block to ClassName.<static:L:C>', () => {
      const symbols = parseJS(`class A extends B {\n  static {\n    super.init();\n  }\n}`);
      const staticDef = symbols.definitions.find((d) => d.name.startsWith('A.<static:'));
      expect(staticDef).toBeDefined();
      const superCall = symbols.calls.find((c) => c.name === 'init' && c.receiver === 'super');
      expect(superCall).toBeDefined();
      expect(superCall!.line).toBeGreaterThanOrEqual(staticDef!.line);
      expect(superCall!.line).toBeLessThanOrEqual(staticDef!.endLine!);
    });

    it('extracts class field arrow function as callable ClassName.fieldName method', () => {
      const symbols = parseJS(`class A {\n  static f = () => {\n    doSomething();\n  };\n}`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'A.f', kind: 'method' }),
      );
    });
  });

  describe('computed method name extraction (#1471, #1517)', () => {
    it('extracts computed getter with plain name (strips brackets+quotes)', () => {
      const symbols = parseJS(`const obj = { get ['property7']() {} };`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'property7', kind: 'method' }),
      );
    });

    it('extracts computed setter with plain name and preserves parameter', () => {
      const symbols = parseJS(`const obj = { set ['property8'](value) {} };`);
      const def = symbols.definitions.find((d) => d.name === 'property8');
      expect(def).toBeDefined();
      expect(def).toMatchObject({ kind: 'method' });
      expect(def!.children).toContainEqual(
        expect.objectContaining({ name: 'value', kind: 'parameter' }),
      );
    });

    it('extracts computed regular method with plain name and preserves parameter', () => {
      const symbols = parseJS(`const obj = { ['property9'](parameters) {} };`);
      const def = symbols.definitions.find((d) => d.name === 'property9');
      expect(def).toBeDefined();
      expect(def!.children).toContainEqual(
        expect.objectContaining({ name: 'parameters', kind: 'parameter' }),
      );
    });

    it('extracts computed generator method with plain name', () => {
      const symbols = parseJS(`const obj = { *['generator10'](parameters) {} };`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'generator10', kind: 'method' }),
      );
    });

    it('extracts computed async method with plain name', () => {
      const symbols = parseJS(`const obj = { async ['property11'](parameters) {} };`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'property11', kind: 'method' }),
      );
    });

    it('extracts computed class method with plain name', () => {
      const symbols = parseJS(`class MyClass { ['myMethod']() { return 1; } }`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'MyClass.myMethod', kind: 'method' }),
      );
    });

    it('does not extract non-string computed key (Symbol.iterator)', () => {
      const symbols = parseJS(`class MyClass { [Symbol.iterator]() {} }`);
      const def = symbols.definitions.find((d) => d.name.includes('iterator'));
      expect(def).toBeUndefined();
    });

    it('does not use the bracketed form in the stored name', () => {
      const symbols = parseJS(`const obj = { ['property7']() {} };`);
      const def = symbols.definitions.find((d) => d.name.includes('['));
      expect(def).toBeUndefined();
    });
  });

  describe('quoted (non-computed) method/property key extraction (#1944)', () => {
    it('strips quotes from a plain quoted class method key', () => {
      const symbols = parseJS(`class A { 'foo'() { return 1; } }`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'A.foo', kind: 'method' }),
      );
      const def = symbols.definitions.find((d) => d.name.includes("'"));
      expect(def).toBeUndefined();
    });

    it('strips quotes from a plain quoted object-literal method shorthand key', () => {
      const symbols = parseJS(`const obj = { 'quoted'() { return 1; } };`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'obj.quoted', kind: 'function' }),
      );
      const def = symbols.definitions.find((d) => d.name.includes("'"));
      expect(def).toBeUndefined();
    });

    it('strips double quotes too', () => {
      const symbols = parseJS(`class B { "bar"() { return 1; } }`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'B.bar', kind: 'method' }),
      );
    });
  });

  describe('computed pair key extraction (#1764)', () => {
    it('extracts a computed string-literal pair key as a plain qualified name', () => {
      // `{ ['foo']: () => {} }` — computed_property_name wrapping a string literal must be
      // unwrapped the same way as method_definition's name field (resolveComputedKeyName),
      // not left as the raw bracket/quote text `obj.['foo']`.
      const symbols = parseJS(
        `const obj = { ['foo']: () => { return 1; }, bar: () => { return 2; } };`,
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'obj.foo', kind: 'function' }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'obj.bar', kind: 'function' }),
      );
    });

    it('does not use the bracketed/quoted form in the stored pair definition name', () => {
      const symbols = parseJS(`const obj = { ['foo']: () => {} };`);
      const def = symbols.definitions.find((d) => d.name.includes('['));
      expect(def).toBeUndefined();
    });

    it('skips a non-string computed pair key (Symbol.iterator) instead of emitting garbage', () => {
      // Mirrors method_definition's precedent ('does not extract non-string computed key'):
      // there's no statically resolvable name, so the pair is skipped entirely rather than
      // falling back to raw source text like `obj.[Symbol.iterator]`.
      const symbols = parseJS(`const obj = { [Symbol.iterator]: () => {}, bar: () => {} };`);
      const def = symbols.definitions.find((d) => d.name.includes('iterator'));
      expect(def).toBeUndefined();
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'obj.bar', kind: 'function' }),
      );
    });

    it('skips a variable computed pair key instead of emitting garbage', () => {
      const symbols = parseJS(`const key = 'foo'; const obj = { [key]: () => {}, bar: () => {} };`);
      expect(symbols.definitions).not.toContainEqual(
        expect.objectContaining({ name: expect.stringContaining('[key]') }),
      );
      expect(symbols.definitions).not.toContainEqual(expect.objectContaining({ name: 'obj.key' }));
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'obj.bar', kind: 'function' }),
      );
    });

    it('extracts a computed string-literal pair key for let/var object literals', () => {
      const symbols = parseJS(`let x15 = { ['computedLet']: () => {}, plain: () => {} };`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'x15.computedLet', kind: 'function' }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'x15.plain', kind: 'function' }),
      );
    });
  });

  describe('computed string-literal keys across typeMap/prototype extraction sites (#1884)', () => {
    it('seeds a qualified typeMap entry (not a garbled bracket key) for a computed pair with a function value', () => {
      // handleObjectLiteralTypeMap's pair branch: the extractObjectLiteralFunctions
      // Definition ('obj.foo') already resolves correctly since #1764 — this covers the
      // *typeMap* entry that the two-step accessor dispatch also needs.
      const symbols = parseJS(`const obj = { ['foo']: () => {} };`);
      expect(symbols.typeMap.get('obj.foo')).toEqual({ type: 'obj.foo', confidence: 0.85 });
      expect(symbols.typeMap.has("obj.['foo']")).toBe(false);
    });

    it('seeds typeMap from a computed pair key with an identifier value', () => {
      const symbols = parseJS(`
        function handler() {}
        var routes = { ['get']: handler };
      `);
      expect(symbols.typeMap.get('routes.get')).toEqual({ type: 'handler', confidence: 0.85 });
    });

    it('seeds a qualified typeMap entry for a computed method_definition shorthand in an object literal', () => {
      const symbols = parseJS(`let obj = { ['foo']() { return 1; } };`);
      expect(symbols.typeMap.get('obj.foo')).toEqual({ type: 'obj.foo', confidence: 0.85 });
    });

    it('does not seed a garbage typeMap entry for a non-string computed method_definition key', () => {
      const symbols = parseJS(`let obj = { [Symbol.iterator]() { return 1; } };`);
      for (const key of symbols.typeMap.keys()) {
        expect(key).not.toContain('Symbol');
        expect(key).not.toContain('[');
      }
    });

    it('seeds typeMap from a computed key in Object.defineProperties', () => {
      const symbols = parseJS(`
        function f1() {}
        const obj = {};
        Object.defineProperties(obj, { ['foo']: { value: f1 } });
      `);
      expect(symbols.typeMap.get('obj.foo')).toEqual({ type: 'f1', confidence: 0.85 });
    });

    it('skips a non-string computed key in Object.defineProperties instead of emitting garbage', () => {
      const symbols = parseJS(`
        function f1() {}
        const obj = {};
        Object.defineProperties(obj, { [Symbol.iterator]: { value: f1 } });
      `);
      for (const key of symbols.typeMap.keys()) {
        expect(key).not.toContain('Symbol');
      }
    });

    it('seeds typeMap from a computed key in an Object.create prototype literal', () => {
      const symbols = parseJS(`
        function fn() {}
        const obj = Object.create({ ['foo']: fn });
      `);
      expect(symbols.typeMap.get('obj.foo')).toEqual({ type: 'fn', confidence: 0.85 });
    });

    it('unwraps a resolvable computed key instead of blanket-skipping the rest-param binding', () => {
      const symbols = parseJS(`
        const api = {
          ['process']: function({ items, ...rest }) {
            rest.flush();
          }
        };
      `);
      expect(symbols.objectRestParamBindings).toContainEqual({
        callee: 'process',
        restName: 'rest',
        argIndex: 0,
      });
    });

    it('still skips a non-string computed key for rest-param binding extraction', () => {
      const symbols = parseJS(`
        const api = {
          [Symbol.iterator]: function({ ...rest }) {
            rest.flush();
          }
        };
      `);
      expect(symbols.objectRestParamBindings ?? []).not.toContainEqual(
        expect.objectContaining({ restName: 'rest' }),
      );
    });

    it('extracts a computed method_definition in a Foo.prototype = {...} object literal', () => {
      const symbols = parseJS(`
        function C() {}
        C.prototype = { ['bar']() { return 1; } };
      `);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'C.bar', kind: 'method' }),
      );
    });

    it('does not extract a non-string computed method_definition key in a prototype object literal', () => {
      const symbols = parseJS(`
        function C() {}
        C.prototype = { [Symbol.iterator]() { return 1; } };
      `);
      const def = symbols.definitions.find((d) => d.name.includes('iterator'));
      expect(def).toBeUndefined();
    });

    it('extracts a computed pair key with a function value in a prototype object literal', () => {
      const symbols = parseJS(`
        function C() {}
        C.prototype = { ['foo']: function() { return 1; } };
      `);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'C.foo', kind: 'method' }),
      );
    });

    it('seeds typeMap for a computed pair key with an identifier value in a prototype object literal', () => {
      const symbols = parseJS(`
        function helper() {}
        function C() {}
        C.prototype = { ['run']: helper };
      `);
      expect(symbols.typeMap.get('C.run')).toEqual({ type: 'helper', confidence: 0.9 });
    });

    it('does not extract a non-string computed pair key in a prototype object literal', () => {
      const symbols = parseJS(`
        function C() {}
        C.prototype = { [Symbol.iterator]: function() { return 1; } };
      `);
      const def = symbols.definitions.find((d) => d.name.includes('iterator'));
      expect(def).toBeUndefined();
    });
  });

  describe('class expression inside function extraction (#1471)', () => {
    it('extracts named class expression returned from a function', () => {
      const symbols = parseJS(
        `function mixin() { return class PostMixin extends A { constructor() { super(); } }; }`,
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'PostMixin', kind: 'class' }),
      );
    });

    it('records extends relationship for class expression inside function', () => {
      const symbols = parseJS(`function mixin() { return class PostMixin extends A { m() {} }; }`);
      expect(symbols.classes).toContainEqual(
        expect.objectContaining({ name: 'PostMixin', extends: 'A' }),
      );
    });

    it('extracts class field properties as children of class expression', () => {
      const symbols = parseJS(
        `function mixin() { return class PostMixin extends A { w = 1; eee = this; }; }`,
      );
      const pm = symbols.definitions.find((d) => d.name === 'PostMixin');
      expect(pm).toBeDefined();
      expect(pm!.children).toContainEqual(expect.objectContaining({ name: 'w', kind: 'property' }));
      expect(pm!.children).toContainEqual(
        expect.objectContaining({ name: 'eee', kind: 'property' }),
      );
    });
  });

  describe('bare super(...) constructor call extraction (#1929)', () => {
    it('records bare super(...) as a constructor call with receiver=super', () => {
      const symbols = parseJS(
        `class Base { constructor(a) { this.a = a; } }
         class Derived extends Base { constructor(a, b) { super(a); this.b = b; } }`,
      );
      const superCall = symbols.calls.find(
        (c) => c.name === 'constructor' && c.receiver === 'super',
      );
      expect(superCall).toBeDefined();
      expect(superCall!.dynamic).toBeFalsy();
    });

    it('records bare super(...) from a class expression constructor', () => {
      const symbols = parseJS(
        `function mixin() { return class PostMixin extends A { constructor() { super(); } }; }`,
      );
      const superCall = symbols.calls.find(
        (c) => c.name === 'constructor' && c.receiver === 'super',
      );
      expect(superCall).toBeDefined();
    });

    it('does not emit super(...) arguments as spurious callback-reference calls', () => {
      const symbols = parseJS(
        `class Base { constructor(a, b) { this.a = a; this.b = b; } }
         class Derived extends Base { constructor(a, b) { super(a, b); } }`,
      );
      expect(symbols.calls.some((c) => c.name === 'a')).toBe(false);
      expect(symbols.calls.some((c) => c.name === 'b')).toBe(false);
    });
  });

  describe('array destructuring constant extraction (#1471, #1901)', () => {
    it('extracts one constant definition per bound identifier in a const array pattern', () => {
      // Per-element extraction (#1901) supersedes the prior single-node
      // ("[x, y]" as one unresolvable name) approach — `[x, y]` was never a
      // real identifier and could never be a call target.
      const symbols = parseJS(`const [x, y] = new Set([() => {}, () => {}]);`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'x', kind: 'constant' }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'y', kind: 'constant' }),
      );
      expect(symbols.definitions.every((d) => d.name !== '[x, y]')).toBe(true);
    });

    it('extracts the default-value binding and the rest binding as their own constants', () => {
      const symbols = parseJS(`const [a = 1, ...rest] = computeList();`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'a', kind: 'constant' }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'rest', kind: 'constant' }),
      );
    });

    it('recurses into a nested array pattern within a rest binding', () => {
      // Greptile review (#2038): `rest_pattern`/`rest_element` has no "name"
      // field in the grammar (only a single positional child), so a rest
      // element that itself nests another array pattern (`...[a, b]`) must be
      // recursed into rather than silently skipped when it isn't a plain
      // identifier.
      const symbols = parseJS(`const [x, ...[a, b]] = computeList();`);
      for (const name of ['x', 'a', 'b']) {
        expect(symbols.definitions).toContainEqual(
          expect.objectContaining({ name, kind: 'constant' }),
        );
      }
      expect(symbols.definitions.every((d) => !d.name.startsWith('['))).toBe(true);
    });

    it('does not extract let or var array destructuring', () => {
      const symbols = parseJS(`let [a, b] = [1, 2];`);
      expect(symbols.definitions.every((d) => d.name !== 'a' && d.name !== 'b')).toBe(true);
      expect(symbols.definitions.every((d) => d.name !== '[a, b]')).toBe(true);
    });
  });

  describe('prototype method parameter extraction (#1471)', () => {
    it('extracts parameters from Foo.prototype.bar = (x, y) => arrow', () => {
      const symbols = parseJS(`function Arit() {}\nArit.prototype.sum = (x, y) => x + y;`);
      const def = symbols.definitions.find((d) => d.name === 'Arit.sum');
      expect(def).toBeDefined();
      expect(def!.children).toContainEqual(
        expect.objectContaining({ name: 'x', kind: 'parameter' }),
      );
      expect(def!.children).toContainEqual(
        expect.objectContaining({ name: 'y', kind: 'parameter' }),
      );
    });

    it('extracts parameters from Foo.prototype.bar = function(key, value)', () => {
      const symbols = parseJS(
        `function Foo() {}\nFoo.prototype.add = function(key, value) { this[key] = value; };`,
      );
      const def = symbols.definitions.find((d) => d.name === 'Foo.add');
      expect(def).toBeDefined();
      expect(def!.children).toContainEqual(
        expect.objectContaining({ name: 'key', kind: 'parameter' }),
      );
      expect(def!.children).toContainEqual(
        expect.objectContaining({ name: 'value', kind: 'parameter' }),
      );
    });
  });

  describe('export-list detection for `export const/let/var …` (#1728)', () => {
    it('lists named exported function/class declarations (refactor regression guard)', () => {
      const symbols = parseJS(`export function greet() {}\nexport class Widget {}`);
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'greet', kind: 'function' }),
      );
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'Widget', kind: 'class' }),
      );
    });

    it('lists an exported const with a bare numeric-literal initializer (repro 1)', () => {
      const symbols = parseJS(`export const MAX_WALK_DEPTH = 200;`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'MAX_WALK_DEPTH', kind: 'constant', line: 1 }),
      );
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'MAX_WALK_DEPTH', kind: 'constant', line: 1 }),
      );
    });

    it('lists an exported const initialized with new Set(...) (sibling regression guard)', () => {
      const symbols = parseJS(`export const PUNCTUATION_TOKENS = new Set([',', ';']);`);
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'PUNCTUATION_TOKENS', kind: 'constant', line: 1 }),
      );
    });

    it('lists an exported object-literal-with-methods const, without independently exporting its methods (repro 2)', () => {
      const symbols = parseJS(
        `export const command = {\n  name: 'info',\n  execute(args, opts, ctx) {},\n};`,
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'command', kind: 'constant', line: 1 }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'command.execute', kind: 'function' }),
      );
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'command', kind: 'constant', line: 1 }),
      );
      // Qualified child methods aren't independently listed as exports — mirrors
      // how `Foo.method` isn't exported when only `export class Foo` is (only the
      // top-level declared name is; see the class-method exported=0 convention).
      expect(symbols.exports.some((e) => e.name === 'command.execute')).toBe(false);
    });

    it('lists an exported arrow-function const with kind "function"', () => {
      const symbols = parseJS(`export const add = (a, b) => a + b;`);
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'add', kind: 'function', line: 1 }),
      );
    });

    it('does not list a non-exported const', () => {
      const symbols = parseJS(`const INTERNAL = 42;`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'INTERNAL', kind: 'constant' }),
      );
      expect(symbols.exports.some((e) => e.name === 'INTERNAL')).toBe(false);
    });
  });

  describe('export enum declarations produce an Export record (#2560)', () => {
    // Regression guard for #2560: `enum_declaration` was extracted as a
    // Definition (via handleEnumDecl) but had no entry in EXPORT_DECL_KIND,
    // so collectExportedDeclarations silently no-op'd for it — the enum
    // itself was never marked exported, even though real TS/JS semantics say
    // `export enum Foo {}` genuinely exports `Foo`.
    function parseTS(code) {
      const parser = parsers.get('typescript');
      const tree = parser.parse(code);
      return extractSymbols(tree, 'test.ts');
    }

    it('lists an exported enum with kind "enum"', () => {
      const symbols = parseTS(`export enum Color { Red, Green, Blue }`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'Color', kind: 'enum', line: 1 }),
      );
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'Color', kind: 'enum', line: 1 }),
      );
    });

    it('does not list a non-exported enum', () => {
      const symbols = parseTS(`enum Internal { A, B }`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'Internal', kind: 'enum' }),
      );
      expect(symbols.exports.some((e) => e.name === 'Internal')).toBe(false);
    });
  });

  describe('export line matches the declaration, not the `export` keyword (#2293)', () => {
    // Regression guard for #2293: collectExportedDeclarations computed a single
    // `exportLine` from the wrapping `export_statement` node and applied it to
    // every branch, so any export whose declaration didn't start on the same
    // line as the `export` keyword got the WRONG line — mismatching the line
    // its own Definition was recorded under, so the exported=1 UPDATE (which
    // matches by name/kind/file/line) silently never fired.
    // Note: a bare `export\nconst x = 5;` (the issue's own illustrative
    // repro) doesn't actually reach this code at all — tree-sitter-javascript
    // fails to recognize a newline-separated bare `export` followed by a
    // declaration keyword as a single `export_statement` in the first place
    // (confirmed by dumping the parse tree; filed separately as #2459, since
    // it's an upstream grammar limitation, not a line-computation bug). The
    // repros below use `export default`/`export abstract`, which the grammar
    // *does* parse as one `export_statement` spanning multiple lines,
    // to exercise the actual line-computation fix.
    it("uses the function value's own line for a multi-binding exported const, not the declaration's", () => {
      // Mirrors #2265: `export const a = fn1, b = fn2;` — each function-valued
      // declarator's export line must match its own Definition's line (the
      // value node's line), not a shared line derived from the statement.
      const symbols = parseJS(`export const first = () => 1,\n  second = () => 2;`);
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'first', kind: 'function', line: 1 }),
      );
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'second', kind: 'function', line: 2 }),
      );
    });

    it('uses the declaration line, not the export keyword line, for a default-exported class', () => {
      const symbols = parseJS(`export default\nclass Widget {}`);
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'Widget', kind: 'class', line: 2 }),
      );
    });

    it('uses the declaration line, not the export keyword line, for a default-exported function', () => {
      const symbols = parseJS(`export default\nfunction greet() {}`);
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'greet', kind: 'function', line: 2 }),
      );
    });
  });

  describe('bare `export` + newline before a declaration (#2459)', () => {
    // tree-sitter-javascript/typescript misparses `export` followed by a
    // newline before const/let/var/class/function/interface/type as a
    // standalone `(expression_statement (identifier))` rather than a single
    // `export_statement` — `export default`/`{`/`*` ARE handled correctly
    // across a newline (the grammar's ASI-like heuristic special-cases
    // them), which is why the #2293 suite above uses `export default` to
    // exercise its line-computation fix instead of this exact shape.
    function parseTS(code) {
      const parser = parsers.get('typescript');
      const tree = parser.parse(code);
      return extractSymbols(tree, 'test.ts');
    }

    it('recovers an exported const split across a newline from the export keyword', () => {
      const symbols = parseJS(`export\nconst onOwnLine = 5;`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'onOwnLine', kind: 'constant', line: 2 }),
      );
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'onOwnLine', kind: 'constant', line: 2 }),
      );
    });

    it('recovers an exported class split across a newline from the export keyword', () => {
      const symbols = parseJS(`export\nclass Widget {}`);
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'Widget', kind: 'class', line: 2 }),
      );
    });

    it('recovers an exported function split across a newline from the export keyword', () => {
      const symbols = parseJS(`export\nfunction greet() {}`);
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'greet', kind: 'function', line: 2 }),
      );
    });

    it('recovers an exported TS interface split across a newline from the export keyword', () => {
      const symbols = parseTS(`export\ninterface Shape {}`);
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'Shape', kind: 'interface', line: 2 }),
      );
    });

    it('recovers an exported TS type alias split across a newline from the export keyword', () => {
      const symbols = parseTS(`export\ntype Id = string;`);
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'Id', kind: 'type', line: 2 }),
      );
    });

    it('skips a comment between the export keyword and the declaration', () => {
      const symbols = parseJS(`export\n// why is this exported\nconst withComment = 1;`);
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'withComment', kind: 'constant', line: 3 }),
      );
    });

    it('still exports a same-line declaration normally (no regression from the recovery path)', () => {
      const symbols = parseJS(`export const sameLine = 6;`);
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'sameLine', kind: 'constant', line: 1 }),
      );
    });

    it('does not export a plain top-level statement that merely references an unrelated identifier', () => {
      // Sanity check that the recovery is keyed on the literal text "export"
      // (a reserved word — this can only ever be the misparse), not on "any
      // bare identifier expression statement followed by a declaration".
      const symbols = parseJS(`notExport;\nconst untouched = 1;`);
      expect(symbols.exports.some((e) => e.name === 'untouched')).toBe(false);
    });
  });

  describe('top-level const with a non-"literal-shaped" initializer (#1819)', () => {
    it('extracts a const with a parenthesized member-expression initializer as a definition (repro)', () => {
      // Repro from #1819: `(...).version` isn't one of the recognized "literal"
      // shapes, so the whole declaration was previously dropped — not just
      // unexported, absent from `definitions` entirely.
      const symbols = parseJS(
        `export const CODEGRAPH_VERSION = (\n  JSON.parse(readFileSync(pkgPath, 'utf-8'))\n).version;`,
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'CODEGRAPH_VERSION', kind: 'constant' }),
      );
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'CODEGRAPH_VERSION', kind: 'constant' }),
      );
    });

    it('extracts a const with a call-expression initializer as a definition', () => {
      const symbols = parseJS(`const config = loadConfig();`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'config', kind: 'constant' }),
      );
    });

    it('extracts an exported const with a call-expression initializer', () => {
      const symbols = parseJS(`export const config = loadConfig();`);
      expect(symbols.exports).toContainEqual(
        expect.objectContaining({ name: 'config', kind: 'constant' }),
      );
    });

    it('extracts a const with a bare identifier initializer as a definition', () => {
      const symbols = parseJS(`const alias = handler;`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'alias', kind: 'constant' }),
      );
      // The new Definition must not come at the expense of the existing pts
      // fnRefBindings tracking (they're independent passes).
      expect(symbols.fnRefBindings).toContainEqual(
        expect.objectContaining({ lhs: 'alias', rhs: 'handler' }),
      );
    });

    it('still skips a non-top-level const with a non-literal initializer', () => {
      const symbols = parseJS(`function f() { const x = compute(); }`);
      expect(symbols.definitions.some((d) => d.name === 'x')).toBe(false);
    });

    it('extracts a const array pattern with a call-expression initializer (parity with identifier case)', () => {
      const symbols = parseJS(`const [a, b] = computePair();`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'a', kind: 'constant' }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'b', kind: 'constant' }),
      );
    });
  });

  describe('interface member kind labeling (#1809)', () => {
    function parseTS(code) {
      const parser = parsers.get('typescript');
      const tree = parser.parse(code);
      return extractSymbols(tree, 'test.ts');
    }

    it('labels a property_signature interface member as kind "property"', () => {
      const symbols = parseTS(`interface ExtractParametersOptions {
  paramTypes: readonly string[];
  nameField?: string | null;
}`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({
          name: 'ExtractParametersOptions.paramTypes',
          kind: 'property',
        }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({
          name: 'ExtractParametersOptions.nameField',
          kind: 'property',
        }),
      );
    });

    it('still labels a method_signature interface member as kind "method"', () => {
      const symbols = parseTS(`interface Repo {
  find(id: string): Item | undefined;
}`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'Repo.find', kind: 'method' }),
      );
    });

    it('labels mixed property and method interface members correctly', () => {
      const symbols = parseTS(`interface Widget {
  name: string;
  render(): void;
}`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'Widget.name', kind: 'property' }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'Widget.render', kind: 'method' }),
      );
    });
  });

  describe('ES6 getter/setter same-file property-read call attribution (#1893)', () => {
    function parseJS(code) {
      const parser = parsers.get('javascript');
      const tree = parser.parse(code);
      return extractSymbols(tree, 'test.js');
    }

    function parseTS(code) {
      const parser = parsers.get('typescript');
      const tree = parser.parse(code);
      return extractSymbols(tree, 'test.ts');
    }

    it('attributes a bare `this.prop` read to the same-class getter', () => {
      const symbols = parseJS(`
        class Session {
          get isReady() { return this._ready; }
          check() {
            if (this.isReady) { report(); }
          }
        }
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'isReady', receiver: 'this' }),
      );
    });

    it('attributes a bare `varName.prop` read to a same-file class getter via typeMap', () => {
      const symbols = parseTS(`
        class Repo {
          get db() { return this._db; }
        }
        function useRepo(repo: Repo) {
          return repo.db;
        }
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'db', receiver: 'repo' }),
      );
    });

    it('attributes a plain-assignment write to the same-class setter', () => {
      const symbols = parseJS(`
        class Toggle {
          set flag(v) { this._f = v; }
          reset() { this.flag = false; }
        }
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'flag', receiver: 'this' }),
      );
    });

    it('does not attribute a getter-only read as a call to the setter (no setter declared)', () => {
      const symbols = parseJS(`
        class Repo {
          get db() { return this._db; }
          check() { return this.db; }
        }
      `);
      const dbCalls = symbols.calls.filter((c) => c.name === 'db');
      expect(dbCalls).toHaveLength(1);
    });

    it('skips a property with both a getter and a setter (ambiguous target)', () => {
      const symbols = parseJS(`
        class Toggle {
          get flag() { return this._f; }
          set flag(v) { this._f = v; }
          flip() { this.flag = !this.flag; }
        }
      `);
      expect(symbols.calls.filter((c) => c.name === 'flag')).toHaveLength(0);
    });

    it('does not attribute a real method call to a bare-read even when the name matches an accessor', () => {
      const symbols = parseJS(`
        class Widget {
          get value() { return this._v; }
        }
        function useWidget(w) {
          return w.value();
        }
      `);
      // The call-callee occurrence must still be handled by the regular call
      // path (name='value', receiver='w') exactly once — not duplicated by
      // the accessor-read collector.
      expect(symbols.calls.filter((c) => c.name === 'value' && c.receiver === 'w')).toHaveLength(1);
    });

    it('does not attribute a plain (non-accessor) same-name method reference as a call', () => {
      const symbols = parseJS(`
        class Widget {
          render() { return 1; }
        }
        function useWidget(w) {
          const fn = w.render;
          return fn;
        }
      `);
      expect(symbols.calls).not.toContainEqual(
        expect.objectContaining({ name: 'render', receiver: 'w' }),
      );
    });

    it('recognizes a static get/set accessor the same way as an instance accessor', () => {
      const symbols = parseJS(`
        class Config {
          static get version() { return Config._v; }
          static describe() {
            return this.version;
          }
        }
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'version', receiver: 'this' }),
      );
    });

    // #2086: `this` inside an instance method never refers to the
    // class/constructor object (where static members live) — only `this`
    // inside a static method does — so the registry must not conflate the
    // two when matching a bare `this.prop` read.
    it('does not attribute an instance-context this read to a static-only accessor', () => {
      const symbols = parseJS(`
        class Config {
          static get version() { return Config._v; }
          static _v = '1.0';
          describe() {
            return this.version;
          }
        }
      `);
      expect(symbols.calls).not.toContainEqual(expect.objectContaining({ name: 'version' }));
    });

    it('does not attribute a static-context this read to an instance-only accessor', () => {
      const symbols = parseJS(`
        class Widget {
          get value() { return this._v; }
          _v = 1;
          static describe() {
            return this.value;
          }
        }
      `);
      expect(symbols.calls).not.toContainEqual(expect.objectContaining({ name: 'value' }));
    });

    it('still attributes an instance-context this read to an instance accessor', () => {
      const symbols = parseJS(`
        class Widget {
          get value() { return this._v; }
          _v = 1;
          useOther() {
            return this.value;
          }
        }
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'value', receiver: 'this' }),
      );
    });
  });

  describe('ES6 getter/setter cross-file property-read call attribution (#2030)', () => {
    function parseJS(code) {
      const parser = parsers.get('javascript');
      const tree = parser.parse(code);
      return extractSymbols(tree, 'test.js');
    }

    function parseTS(code) {
      const parser = parsers.get('typescript');
      const tree = parser.parse(code);
      return extractSymbols(tree, 'test.ts');
    }

    it('tags a cross-file `varName.prop` read with accessorRead="get" and the resolved class name', () => {
      const symbols = parseTS(`
        function useRepo(repo: SqliteRepository) {
          return repo.db;
        }
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'db', receiver: 'SqliteRepository', accessorRead: 'get' }),
      );
    });

    it('tags a cross-file plain-assignment write with accessorRead="set"', () => {
      const symbols = parseTS(`
        function useRepo(repo: SqliteRepository) {
          repo.db = null;
        }
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'db', receiver: 'SqliteRepository', accessorRead: 'set' }),
      );
    });

    it('does not tag a same-file confirmed accessor call', () => {
      const symbols = parseTS(`
        class Repo {
          get db() { return this._db; }
        }
        function useRepo(repo: Repo) {
          return repo.db;
        }
      `);
      const call = symbols.calls.find((c) => c.name === 'db' && c.receiver === 'repo');
      expect(call).toBeDefined();
      expect(call.accessorRead).toBeUndefined();
    });

    it('narrows the receiver type via `instanceof` for a cross-file accessor read', () => {
      const symbols = parseJS(`
        function useRepo(repo) {
          if (repo instanceof SqliteRepository) {
            return repo.db;
          }
        }
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'db', receiver: 'SqliteRepository', accessorRead: 'get' }),
      );
    });

    it('narrows across an `&&`-chained instanceof condition', () => {
      const symbols = parseJS(`
        function useRepo(x, repo) {
          if (x && repo instanceof SqliteRepository) {
            return repo.db;
          }
        }
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'db', receiver: 'SqliteRepository' }),
      );
    });

    it('does not narrow across an `||` condition (unsafe — falls back to the declared type)', () => {
      const symbols = parseTS(`
        function useRepo(repo: Repository) {
          if (repo instanceof SqliteRepository || true) {
            return repo.db;
          }
        }
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'db', receiver: 'Repository' }),
      );
      expect(symbols.calls).not.toContainEqual(
        expect.objectContaining({ name: 'db', receiver: 'SqliteRepository' }),
      );
    });

    it('does not leak instanceof narrowing into the else branch', () => {
      const symbols = parseTS(`
        function useRepo(repo: Repository) {
          if (repo instanceof SqliteRepository) {
            return 1;
          } else {
            return repo.db;
          }
        }
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'db', receiver: 'Repository' }),
      );
    });

    it('never tags a plain `this.field` read even when not locally confirmed', () => {
      const symbols = parseJS(`
        class Widget {
          useOther() { return this.unknownProp; }
        }
      `);
      expect(symbols.calls).not.toContainEqual(expect.objectContaining({ name: 'unknownProp' }));
    });
  });

  // #2085: a plain (non-arrow) function does not inherit `this` lexically —
  // `this.method()`/`this.prop` inside one is not guaranteed to be the
  // enclosing class's instance, so it must not resolve as a same-class call.
  describe('this-binding scope boundaries for call/property-read attribution (#2085)', () => {
    function parseTS(code) {
      const parser = parsers.get('typescript');
      const tree = parser.parse(code);
      return extractSymbols(tree, 'test.ts');
    }

    it('flags a this.method() call inside an unbound plain-function callback as unresolved', () => {
      const symbols = parseTS(`
        class Session {
          isReady(): boolean { return true; }
          checkExplicit(): void {
            setTimeout(function () {
              return this.isReady();
            }, 100);
          }
        }
      `);
      expect(symbols.calls).not.toContainEqual(
        expect.objectContaining({ name: 'isReady', receiver: 'this' }),
      );
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({
          name: '<dynamic:unresolved>',
          dynamic: true,
          dynamicKind: 'unresolved-dynamic',
        }),
      );
    });

    it('still resolves a this.method() call inside an arrow-function callback', () => {
      const symbols = parseTS(`
        class Session {
          isReady(): boolean { return true; }
          checkArrow(): void {
            setTimeout(() => {
              return this.isReady();
            }, 100);
          }
        }
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'isReady', receiver: 'this' }),
      );
    });

    it('still resolves a this.method() call inside an explicitly `.bind(this)`-wrapped callback', () => {
      const symbols = parseTS(`
        class Session {
          isReady(): boolean { return true; }
          checkBound(): void {
            setTimeout(function () {
              return this.isReady();
            }.bind(this), 100);
          }
        }
      `);
      expect(symbols.calls).toContainEqual(
        expect.objectContaining({ name: 'isReady', receiver: 'this' }),
      );
    });

    it('does not attribute a this.field accessor read inside an unbound plain-function callback', () => {
      const symbols = parseTS(`
        class Session {
          get ready(): boolean { return this._ready; }
          private _ready = true;
          checkExplicit(): void {
            setTimeout(function () {
              return this.ready;
            }, 100);
          }
        }
      `);
      expect(symbols.calls).not.toContainEqual(expect.objectContaining({ name: 'ready' }));
    });

    it('still resolves a nested plain function inside an arrow (boundary re-established)', () => {
      const symbols = parseTS(`
        class Session {
          isReady(): boolean { return true; }
          checkNested(): void {
            const arrow = () => {
              function inner() {
                return this.isReady();
              }
              inner();
            };
            arrow();
          }
        }
      `);
      expect(symbols.calls).not.toContainEqual(
        expect.objectContaining({ name: 'isReady', receiver: 'this' }),
      );
    });
  });
});
