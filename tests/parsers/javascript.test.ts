/**
 * JavaScript/TypeScript parser tests.
 *
 * NOTE: These tests require vitest and web-tree-sitter to be installed.
 * Run: npm install
 * Then: npm test
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractSymbols } from '../../src/domain/parser.js';

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

  it('extracts class declarations', () => {
    const symbols = parseJS(`class Foo { bar() {} }`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Foo', kind: 'class' }),
    );
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Foo.bar', kind: 'method' }),
    );
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
});
