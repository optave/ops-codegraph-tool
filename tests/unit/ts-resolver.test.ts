/**
 * Unit tests for ts-resolver Phase 8.2 parity backfill.
 *
 * Verifies that enrichTypeMapWithTsc populates returnTypeMap and callAssignments
 * when they are undefined (simulating the native engine path that doesn't run
 * the JS extractor). Also verifies that existing returnTypeMap data (WASM path)
 * is not overwritten.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enrichTypeMapWithTsc } from '../../src/domain/graph/resolver/ts-resolver.js';
import type { ExtractorOutput } from '../../src/types.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ts-resolver-test-'));
}

function makeFileSymbols(
  relPath: string,
  returnTypeMap?: ExtractorOutput['returnTypeMap'],
): Map<string, ExtractorOutput> {
  const fileSymbols = new Map<string, ExtractorOutput>();
  fileSymbols.set(relPath, {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
    returnTypeMap,
    callAssignments: returnTypeMap !== undefined ? [] : undefined,
  });
  return fileSymbols;
}

describe('enrichTypeMapWithTsc Phase 8.2 backfill', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Minimal tsconfig that includes all .ts files in the directory
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: false }, include: ['./**/*.ts'] }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('backfills returnTypeMap for function declarations when undefined (native engine path)', async () => {
    const srcFile = 'service.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
class User { name: string = ''; }
function createUser(): User { return new User(); }
`,
    );

    const fileSymbols = makeFileSymbols(srcFile); // returnTypeMap = undefined
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const symbols = fileSymbols.get(srcFile)!;
    expect(symbols.returnTypeMap).toBeInstanceOf(Map);
    expect(symbols.returnTypeMap!.get('createUser')).toEqual({ type: 'User', confidence: 1.0 });
  });

  it('backfills returnTypeMap for qualified method names', async () => {
    const srcFile = 'repo.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
class Profile {}
class UserService {
  getProfile(): Profile { return new Profile(); }
}
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const symbols = fileSymbols.get(srcFile)!;
    expect(symbols.returnTypeMap!.get('UserService.getProfile')).toEqual({
      type: 'Profile',
      confidence: 1.0,
    });
  });

  it('backfills returnTypeMap for arrow function variable initialisers', async () => {
    const srcFile = 'factory.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
class Widget {}
const makeWidget = (): Widget => new Widget();
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const symbols = fileSymbols.get(srcFile)!;
    expect(symbols.returnTypeMap!.get('makeWidget')).toEqual({ type: 'Widget', confidence: 1.0 });
  });

  it('backfills callAssignments for call-expression variable assignments', async () => {
    const srcFile = 'consumer.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
declare function getRepo(): any;
const repo = getRepo();
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const symbols = fileSymbols.get(srcFile)!;
    expect(symbols.callAssignments).toBeDefined();
    const ca = symbols.callAssignments!.find((c) => c.varName === 'repo');
    expect(ca).toBeDefined();
    expect(ca!.calleeName).toBe('getRepo');
  });

  it('excludes ambiguous callAssignments where same varName maps to different callees', async () => {
    const srcFile = 'ambiguous.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
declare function getA(): any;
declare function getB(): any;
declare function getUnique(): any;

class MyService {
  methodOne() {
    const result = getA();
    return result;
  }
  methodTwo() {
    // Same varName 'result' but different callee — should be excluded as ambiguous
    const result = getB();
    return result;
  }
}

// Unambiguous: only one binding across the file
const unique = getUnique();
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const symbols = fileSymbols.get(srcFile)!;
    expect(symbols.callAssignments).toBeDefined();
    // 'result' is ambiguous (getA in one method, getB in another) — must be excluded
    const resultEntries = symbols.callAssignments!.filter((c) => c.varName === 'result');
    expect(resultEntries).toHaveLength(0);
    // 'unique' is unambiguous — must be included
    const uniqueEntry = symbols.callAssignments!.find((c) => c.varName === 'unique');
    expect(uniqueEntry).toBeDefined();
    expect(uniqueEntry!.calleeName).toBe('getUnique');
  });

  it('does NOT overwrite returnTypeMap when already set (JS/WASM engine path)', async () => {
    const srcFile = 'existing.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
class Foo {}
function makeFoo(): Foo { return new Foo(); }
`,
    );

    const preExisting = new Map([['makeFoo', { type: 'OriginalType', confidence: 0.85 }]]);
    const fileSymbols = makeFileSymbols(srcFile, preExisting); // returnTypeMap already set
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const symbols = fileSymbols.get(srcFile)!;
    // returnTypeMap should be the same object (not replaced)
    expect(symbols.returnTypeMap).toBe(preExisting);
    expect(symbols.returnTypeMap!.get('makeFoo')).toEqual({
      type: 'OriginalType',
      confidence: 0.85,
    });
  });

  it('backfills returnTypeMap for async functions by unwrapping Promise<T>', async () => {
    const srcFile = 'async-service.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
class Order {}
async function fetchOrder(): Promise<Order> { return new Order(); }
class OrderService {
  async loadOrder(): Promise<Order> { return new Order(); }
}
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const symbols = fileSymbols.get(srcFile)!;
    // Async functions must be unwrapped — Promise itself is in SKIP_TYPE_NAMES
    expect(symbols.returnTypeMap!.get('fetchOrder')).toEqual({ type: 'Order', confidence: 1.0 });
    expect(symbols.returnTypeMap!.get('OrderService.loadOrder')).toEqual({
      type: 'Order',
      confidence: 1.0,
    });
  });

  it('does NOT capture local (method-body-scoped) helper functions in returnTypeMap', async () => {
    const srcFile = 'nested.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
class InnerResult {}
class MyService {
  doWork(): void {
    // This local helper must NOT appear in returnTypeMap under the bare name 'helper'
    const helper = (): InnerResult => new InnerResult();
    helper();
  }
}
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const symbols = fileSymbols.get(srcFile)!;
    // 'helper' is local to MyService.doWork — must not pollute returnTypeMap
    expect(symbols.returnTypeMap!.has('helper')).toBe(false);
  });

  it('skips non-TS files even when returnTypeMap is undefined', async () => {
    const fileSymbols = new Map<string, ExtractorOutput>();
    fileSymbols.set('index.js', {
      definitions: [],
      calls: [],
      imports: [],
      classes: [],
      exports: [],
      typeMap: new Map(),
      returnTypeMap: undefined,
    });

    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    // JS files are not processed — returnTypeMap stays undefined
    const symbols = fileSymbols.get('index.js')!;
    expect(symbols.returnTypeMap).toBeUndefined();
  });
});

describe('enrichTypeMapWithTsc Phase 8.1 typeMap enrichment', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: false }, include: ['./**/*.ts'] }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enriches typeMap for typed function parameters', async () => {
    const srcFile = 'handler.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
class RequestHandler {}
function process(handler: RequestHandler): void {}
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const { typeMap } = fileSymbols.get(srcFile)!;
    expect(typeMap.get('handler')).toEqual({ type: 'RequestHandler', confidence: 1.0 });
  });

  it('enriches typeMap for typed variable declarations', async () => {
    const srcFile = 'session.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
class Session {}
const session = new Session();
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const { typeMap } = fileSymbols.get(srcFile)!;
    expect(typeMap.get('session')).toEqual({ type: 'Session', confidence: 1.0 });
  });

  it('does NOT overwrite confidence-1.0 entries already in typeMap', async () => {
    const srcFile = 'preseeded.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
class OrderService {}
function place(svc: OrderService): void {}
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    fileSymbols.get(srcFile)!.typeMap.set('svc', { type: 'OriginalService', confidence: 1.0 });
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const { typeMap } = fileSymbols.get(srcFile)!;
    expect(typeMap.get('svc')).toEqual({ type: 'OriginalService', confidence: 1.0 });
  });

  it('replaces low-confidence typeMap entries with compiler-verified ones', async () => {
    const srcFile = 'replace.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
class PaymentService {}
function pay(svc: PaymentService): void {}
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    fileSymbols.get(srcFile)!.typeMap.set('svc', { type: 'GuessedType', confidence: 0.8 });
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const { typeMap } = fileSymbols.get(srcFile)!;
    expect(typeMap.get('svc')).toEqual({ type: 'PaymentService', confidence: 1.0 });
  });

  it('excludes ambiguous parameter names where same name maps to different types across functions', async () => {
    const srcFile = 'ambiguous-params.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
class LoggerA {}
class LoggerB {}
function logA(logger: LoggerA): void {}
function logB(logger: LoggerB): void {}
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const { typeMap } = fileSymbols.get(srcFile)!;
    // 'logger' appears with two distinct types — must not be written as a bare name
    expect(typeMap.has('logger')).toBe(false);
  });

  it('does not add typeMap entries for primitive/built-in parameter types', async () => {
    const srcFile = 'primitives.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
function process(name: string, count: number, flag: boolean): void {}
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const { typeMap } = fileSymbols.get(srcFile)!;
    expect(typeMap.has('name')).toBe(false);
    expect(typeMap.has('count')).toBe(false);
    expect(typeMap.has('flag')).toBe(false);
  });
});

describe('enrichTypeMapWithTsc callAssignment receiver type and deduplication', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: false }, include: ['./**/*.ts'] }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('captures receiverTypeName for method call assignments when receiver is in typeMap', async () => {
    const srcFile = 'method-call.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
class DataService {
  getData(): any { return null; }
}
const svc = new DataService();
const result = svc.getData();
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const symbols = fileSymbols.get(srcFile)!;
    const ca = symbols.callAssignments!.find((c) => c.varName === 'result');
    expect(ca).toBeDefined();
    expect(ca!.calleeName).toBe('getData');
    expect(ca!.receiverTypeName).toBe('DataService');
  });

  it('does not add callAssignment for varName already resolved in typeMap', async () => {
    const srcFile = 'skip-resolved.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
declare function createConfig(): any;
const config = createConfig();
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    // Pre-seeding typeMap simulates that config was already resolved by a prior pass
    fileSymbols.get(srcFile)!.typeMap.set('config', { type: 'Config', confidence: 1.0 });
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const symbols = fileSymbols.get(srcFile)!;
    expect(symbols.callAssignments!.find((c) => c.varName === 'config')).toBeUndefined();
  });

  it('variables resolved by enrichSourceFile are not duplicated in callAssignments', async () => {
    const srcFile = 'no-dupe.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
class MyService {}
declare function createService(): MyService;
const svc = createService();
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const symbols = fileSymbols.get(srcFile)!;
    // enrichSourceFile resolves svc → MyService; enrichCallAssignments must skip it
    expect(symbols.typeMap.get('svc')).toEqual({ type: 'MyService', confidence: 1.0 });
    expect(symbols.callAssignments!.find((c) => c.varName === 'svc')).toBeUndefined();
  });
});

describe('enrichTypeMapWithTsc edge cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('processes .tsx files and backfills returnTypeMap', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: false }, include: ['./**/*.tsx'] }),
    );
    const srcFile = 'component.tsx';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
class ComponentState {}
function getInitialState(): ComponentState { return new ComponentState(); }
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const symbols = fileSymbols.get(srcFile)!;
    expect(symbols.returnTypeMap).toBeInstanceOf(Map);
    expect(symbols.returnTypeMap!.get('getInitialState')).toEqual({
      type: 'ComponentState',
      confidence: 1.0,
    });
  });

  it('enriches returnTypeMap for regular function expressions (not just arrow functions)', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: false }, include: ['./**/*.ts'] }),
    );
    const srcFile = 'func-expr.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
class Widget {}
const makeWidget = function(): Widget { return new Widget(); };
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const symbols = fileSymbols.get(srcFile)!;
    expect(symbols.returnTypeMap!.get('makeWidget')).toEqual({ type: 'Widget', confidence: 1.0 });
  });

  it('excludes returnTypeMap entries for functions returning primitive types', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: false }, include: ['./**/*.ts'] }),
    );
    const srcFile = 'primitives-return.ts';
    fs.writeFileSync(
      path.join(tmpDir, srcFile),
      `
function getName(): string { return 'hello'; }
function getCount(): number { return 42; }
`,
    );

    const fileSymbols = makeFileSymbols(srcFile);
    await enrichTypeMapWithTsc(tmpDir, fileSymbols);

    const symbols = fileSymbols.get(srcFile)!;
    expect(symbols.returnTypeMap!.has('getName')).toBe(false);
    expect(symbols.returnTypeMap!.has('getCount')).toBe(false);
  });
});
