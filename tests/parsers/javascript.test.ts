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
    const symbols = parseJS(`class C6 { static staticProperty = (f1(), function() {}); }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'C6.staticProperty', kind: 'method' }),
    );
  });

  it('extracts static blocks as function definitions', () => {
    const symbols = parseJS(`class C6 { static { f1(); } static { f2(); } }`);
    const staticDefs = symbols.definitions.filter((d) => d.name === 'C6.<static>');
    expect(staticDefs).toHaveLength(2);
    expect(staticDefs[0]).toMatchObject({ kind: 'function' });
    expect(staticDefs[1]).toMatchObject({ kind: 'function' });
  });

  it('extracts import statements', () => {
    const symbols = parseJS(`import { foo, bar } from './baz';`);
    expect(symbols.imports).toHaveLength(1);
    expect(symbols.imports[0].source).toBe('./baz');
    expect(symbols.imports[0].names).toContain('foo');
    expect(symbols.imports[0].names).toContain('bar');
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

  it('detects dynamic call patterns', () => {
    const symbols = parseJS(`fn.call(null, arg); obj.apply(undefined, args);`);
    const dynamicCalls = symbols.calls.filter((c) => c.dynamic);
    expect(dynamicCalls.length).toBeGreaterThanOrEqual(1);
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

    // Destructured bindings
    it('extracts definitions from destructured const bindings', () => {
      const symbols = parseJS(`const { handleToken, checkPermissions } = initAuth(config);`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'handleToken', kind: 'function' }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'checkPermissions', kind: 'function' }),
      );
    });

    it('extracts definitions from exported destructured const bindings', () => {
      const symbols = parseJS(`export const { handleToken, checkPermissions } = initAuth(config);`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'handleToken', kind: 'function' }),
      );
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'checkPermissions', kind: 'function' }),
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
      const symbols = parseJS(`const { original: renamed } = initAuth();`);
      expect(symbols.definitions).toContainEqual(
        expect.objectContaining({ name: 'renamed', kind: 'function' }),
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
});
