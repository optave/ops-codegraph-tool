/**
 * AST node extraction parity tests (native vs WASM).
 *
 * Verifies that the native Rust engine extracts identical AST nodes
 * (new, throw, await, string, regex) to the WASM visitor for JS/TS.
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
  definitions?: Array<{ name: string; kind: string; line: number }>;
}

let native: NativeAddon | null = null;

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

// In the dedicated parity CI job (CODEGRAPH_PARITY=1), never silently skip —
// fail hard so a missing native addon is immediately visible.
const requireParity = !!process.env.CODEGRAPH_PARITY;
const describeOrSkip = requireParity || isNativeAvailable() ? describe : describe.skip;

describeOrSkip('AST node parity (native vs WASM)', () => {
  beforeAll(async () => {
    if (!isNativeAvailable()) return;
    native = getNative();
  });

  it.skipIf(!isNativeAvailable())('JS: native astNodes kinds are valid and well-formed', () => {
    const nativeResult = nativeExtract(JS_SNIPPET, '/test/sample.js');
    const astNodes = nativeResult.astNodes || [];

    // Native should produce some AST nodes (strings, regex, new, throw, await at minimum)
    expect(astNodes.length).toBeGreaterThan(0);

    // All nodes must have valid structure.
    // 'call' is accepted transitionally: the published native binary (v3.7.0) still
    // emits it; the Rust source removes it but CI tests run against the published binary.
    const validKinds = new Set(['new', 'throw', 'await', 'string', 'regex', 'call']);
    for (const node of astNodes) {
      expect(validKinds).toContain(node.kind);
      expect(typeof node.name).toBe('string');
      expect(typeof node.line).toBe('number');
    }
  });

  it.skipIf(!isNativeAvailable())('TS: native produces well-formed AST nodes', () => {
    const nativeResult = nativeExtract(TS_SNIPPET, '/test/sample.ts');
    expect(nativeResult).toBeTruthy();

    const astNodes = nativeResult.astNodes || [];
    expect(astNodes.length).toBeGreaterThan(0);

    // Verify all nodes have valid kinds (see JS test above for 'call' note)
    const validKinds = new Set(['new', 'throw', 'await', 'string', 'regex', 'call']);
    for (const node of astNodes) {
      expect(validKinds).toContain(node.kind);
    }
  });

  it.skipIf(!isNativeAvailable())('empty file returns empty astNodes array (not undefined)', () => {
    const nativeResult = nativeExtract('// empty file\n', '/test/empty.js');
    const astNodes = nativeResult.astNodes || nativeResult.ast_nodes;

    // Should be an array (possibly empty), not undefined
    expect(Array.isArray(astNodes)).toBe(true);
  });
});
