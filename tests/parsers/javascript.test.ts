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

  describe('array destructuring constant extraction (#1471)', () => {
    it('extracts const array pattern as a single constant node', () => {
      const symbols = parseJS(`const [x, y] = new Set([() => {}, () => {}]);`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: '[x, y]', kind: 'constant' }),
      );
    });

    it('does not extract let or var array destructuring', () => {
      const symbols = parseJS(`let [a, b] = [1, 2];`);
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
        expect.objectContaining({ name: '[a, b]', kind: 'constant' }),
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
});
