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
  let parsers;

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

    it('prefers constructor (1.0) over type annotation (0.9)', () => {
      const symbols = parseTS(`const x: Base = new Derived();`);
      // Deliberate: constructor (1.0) beats annotation (0.9) because the runtime
      // type is what matters for call resolution. In `const x: Base = new Derived()`,
      // x.method() dispatches to Derived.method, not Base.method. This is a
      // semantic reversal from the previous behaviour (annotation-first).
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

    it('does not extract event with named handler', () => {
      const symbols = parseJS(`emitter.on('data', handleData);`);
      const defs = symbols.definitions.filter((d) => d.name.startsWith('event:'));
      expect(defs).toHaveLength(0);
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
