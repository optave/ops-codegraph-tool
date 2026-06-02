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
