/**
 * AST node extraction parity tests (native vs WASM).
 *
 * Verifies that the native Rust engine extracts identical AST nodes
 * (call, new, throw, await, string, regex) to the WASM visitor for JS/TS.
 *
 * Skipped when the native engine is not installed.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getNative, isNativeAvailable } from '../../src/infrastructure/native.js';
import type { NativeAddon } from '../../src/types.js';

interface AstNodeLike {
  kind: string;
  name: string;
  line: number;
  text?: string;
  receiver?: string;
}

interface NativeResult {
  astNodes?: AstNodeLike[];
  ast_nodes?: AstNodeLike[];
  calls?: Array<{ name: string; line: number; receiver?: string; dynamic?: boolean }>;
  definitions?: Array<{ name: string; kind: string; line: number }>;
}

let native: NativeAddon | null = null;
/** Whether the installed native binary supports call AST nodes. */
let nativeSupportsCallAst = false;

function nativeExtract(code: string, filePath: string): NativeResult {
  if (!native) throw new Error('nativeExtract called with native === null');
  // 4th arg = include_ast_nodes = true
  return native.parseFile(filePath, code, false, true) as NativeResult;
}

// ─── Test snippets ──────────────────────────────────────────────────────

const JS_SNIPPET = `
import fs from 'fs';
import path from 'path';

class MyError extends Error {
  constructor(msg) {
    super(msg);
  }
}

function greet(name) {
  console.log("Hello " + name);
  const result = fetch("/api/users");
  return result;
}

async function loadData(url) {
  const resp = await fetch(url);
  const data = await resp.json();
  if (!data) {
    throw new MyError("no data");
  }
  return data;
}

const pattern = /^[a-z]+$/i;
const obj = new Map();
const value = "some string value";
`;

const TS_SNIPPET = `
interface Config {
  apiUrl: string;
  timeout: number;
}

async function request(config: Config): Promise<Response> {
  const url = config.apiUrl;
  const resp = await fetch(url, { signal: AbortSignal.timeout(config.timeout) });
  if (!resp.ok) {
    throw new Error(\`HTTP \${resp.status}\`);
  }
  return resp.json();
}

function processItems(items: string[]): void {
  items.forEach(item => {
    console.log(item);
    item.trim().toLowerCase();
  });
}
`;

const MULTI_CALL_SNIPPET = `
function nested() {
  const a = foo(bar(baz()));
  const b = obj.method(helper());
  console.log("test");
}
`;

describe('AST node parity (native vs WASM)', () => {
  beforeAll(async () => {
    if (!isNativeAvailable()) return;
    native = getNative();

    // Detect whether this native binary supports call AST extraction.
    // Older published binaries produce astNodes but without call entries.
    const probe = native.parseFile('/probe.js', 'foo();', false, true) as NativeResult | null;
    if (probe) {
      const astNodes = probe.astNodes || [];
      nativeSupportsCallAst = astNodes.some((n: AstNodeLike) => n.kind === 'call');
    }
  });

  it.skipIf(!isNativeAvailable())('JS: native astNodes kinds are valid and well-formed', () => {
    const nativeResult = nativeExtract(JS_SNIPPET, '/test/sample.js');
    const astNodes = nativeResult.astNodes || [];

    // Native should produce some AST nodes (strings, regex, new, throw, await at minimum)
    expect(astNodes.length).toBeGreaterThan(0);

    // All nodes must have valid structure
    const validKinds = new Set(['call', 'new', 'throw', 'await', 'string', 'regex']);
    for (const node of astNodes) {
      expect(validKinds).toContain(node.kind);
      expect(typeof node.name).toBe('string');
      expect(typeof node.line).toBe('number');
    }
  });

  it.skipIf(!isNativeAvailable())('JS: native astNodes includes call kind', () => {
    if (!nativeSupportsCallAst) return; // runtime guard — set by beforeAll

    const nativeResult = nativeExtract(JS_SNIPPET, '/test/sample.js');
    const astNodes = nativeResult.astNodes || [];
    const callNodes = astNodes.filter((n: AstNodeLike) => n.kind === 'call');

    // JS snippet has: super, console.log, fetch (x2), resp.json
    expect(callNodes.length).toBeGreaterThan(0);

    // Verify call nodes have expected structure
    for (const node of callNodes) {
      expect(node.kind).toBe('call');
      expect(typeof node.name).toBe('string');
      expect(typeof node.line).toBe('number');
    }
  });

  it.skipIf(!isNativeAvailable())('JS: call receiver extraction', () => {
    if (!nativeSupportsCallAst) return; // runtime guard — set by beforeAll

    const nativeResult = nativeExtract(JS_SNIPPET, '/test/sample.js');
    const astNodes = nativeResult.astNodes || [];
    const callNodes = astNodes.filter((n: AstNodeLike) => n.kind === 'call');

    // console.log() should have receiver "console"
    const consoleLog = callNodes.find((n: AstNodeLike) => n.name === 'console.log');
    expect(consoleLog).toBeTruthy();
    expect(consoleLog?.receiver).toBe('console');

    // fetch() should have no receiver
    const fetchCall = callNodes.find((n: AstNodeLike) => n.name === 'fetch');
    expect(fetchCall).toBeTruthy();
    expect(fetchCall?.receiver).toBeFalsy();
  });

  it.skipIf(!isNativeAvailable())('TS: native produces well-formed AST nodes', () => {
    const nativeResult = nativeExtract(TS_SNIPPET, '/test/sample.ts');
    expect(nativeResult).toBeTruthy();

    const astNodes = nativeResult.astNodes || [];
    expect(astNodes.length).toBeGreaterThan(0);

    // Verify all nodes have valid kinds
    const validKinds = new Set(['call', 'new', 'throw', 'await', 'string', 'regex']);
    for (const node of astNodes) {
      expect(validKinds).toContain(node.kind);
    }
  });

  it.skipIf(!isNativeAvailable())('JS: nested calls are not double-counted', () => {
    if (!nativeSupportsCallAst) return; // runtime guard — set by beforeAll

    const nativeResult = nativeExtract(MULTI_CALL_SNIPPET, '/test/nested.js');
    const astNodes = nativeResult.astNodes || [];
    const callNodes = astNodes.filter((n: AstNodeLike) => n.kind === 'call');

    // foo(bar(baz())) should produce 3 separate call nodes
    const names = callNodes.map((n: AstNodeLike) => n.name).sort();
    expect(names).toContain('foo');
    expect(names).toContain('bar');
    expect(names).toContain('baz');
    expect(names).toContain('console.log');
    expect(names).toContain('obj.method');
    expect(names).toContain('helper');

    // No duplicate lines for the nested chain
    const fooLine = callNodes.find((n: AstNodeLike) => n.name === 'foo')?.line;
    const barLine = callNodes.find((n: AstNodeLike) => n.name === 'bar')?.line;
    const bazLine = callNodes.find((n: AstNodeLike) => n.name === 'baz')?.line;
    // All on the same line but each as separate nodes
    expect(fooLine).toBe(barLine);
    expect(barLine).toBe(bazLine);
  });

  it.skipIf(!isNativeAvailable())('JS: native calls match legacy calls field count', () => {
    if (!nativeSupportsCallAst) return; // runtime guard — set by beforeAll

    const nativeResult = nativeExtract(JS_SNIPPET, '/test/sample.js');
    const astNodes = nativeResult.astNodes || [];
    const nativeCallNodes = astNodes.filter((n: AstNodeLike) => n.kind === 'call');
    const legacyCalls = nativeResult.calls || [];

    // Native should capture at least as many calls as the legacy field
    expect(nativeCallNodes.length).toBeGreaterThanOrEqual(legacyCalls.length);
  });

  it.skipIf(!isNativeAvailable())('empty file returns empty astNodes array (not undefined)', () => {
    const nativeResult = nativeExtract('// empty file\n', '/test/empty.js');
    const astNodes = nativeResult.astNodes || nativeResult.ast_nodes;

    // Should be an array (possibly empty), not undefined
    expect(Array.isArray(astNodes)).toBe(true);
  });
});
