/**
 * AST node extraction parity tests (native vs WASM).
 *
 * Verifies that the native Rust engine extracts identical AST nodes
 * (new, throw, await, string, regex) to the WASM visitor for JS/TS.
 *
 * Skipped when the native engine is not installed.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  AST_STRING_CONFIGS,
  AST_TYPE_MAPS,
  astStopRecurseKinds,
} from '../../src/ast-analysis/rules/index.js';
import { walkWithVisitors } from '../../src/ast-analysis/visitor.js';
import { createAstStoreVisitor } from '../../src/ast-analysis/visitors/ast-store-visitor.js';
import { createParsers, getParser } from '../../src/domain/parser.js';
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

  // ── Row-count parity per language (#1010) ────────────────────────────
  // Both engines must emit the same ast_nodes row count for a given source.
  // Divergence means one engine is under- or over-extracting relative to the
  // other. Tested across all languages WASM has grammars + AST_TYPE_MAPS for.

  interface Fixture {
    langId: string;
    ext: string;
    code: string;
  }

  const PARITY_FIXTURES: Fixture[] = [
    {
      langId: 'javascript',
      ext: '.js',
      code: JS_SNIPPET,
    },
    {
      langId: 'typescript',
      ext: '.ts',
      code: TS_SNIPPET,
    },
    {
      langId: 'python',
      ext: '.py',
      code: `
import os
async def fetch(url):
    resp = await http.get(url)
    if not resp:
        raise ValueError("no data")
    return resp
s = "hello world"
r = r"raw"
f = f"prefix {s}"
`,
    },
    {
      langId: 'rust',
      ext: '.rs',
      code: `
async fn load() -> Result<String, std::io::Error> {
    let s = "hello world".to_string();
    let r = r"raw string content";
    let got = fetch().await?;
    Ok(s + &got)
}
`,
    },
    {
      langId: 'go',
      ext: '.go',
      code:
        `
package main
import "fmt"
func main() {
    s := "hello world"
    r := ` +
        '`raw string content`' +
        `
    fmt.Println(s, r)
}
`,
    },
    {
      langId: 'java',
      ext: '.java',
      code: `
public class App {
    public static void main(String[] args) {
        String s = "hello world";
        if (args.length == 0) {
            throw new RuntimeException("no args");
        }
        Object o = new Object();
    }
}
`,
    },
    // ── Minimal fixtures for languages added in PR #1016 ───────────────
    // Each exercises at least one string literal + one other ast_node kind
    // from AST_TYPE_MAPS to catch silent WASM/native divergence.
    {
      langId: 'csharp',
      ext: '.cs',
      code: `
using System;
public class App {
    public static void Main() {
        string s = "hello world";
        throw new InvalidOperationException("bad");
    }
}
`,
    },
    {
      langId: 'ruby',
      ext: '.rb',
      code: `
class MyError < StandardError; end
def load_data
  s = "hello world"
  raise MyError, "no data"
end
`,
    },
    {
      langId: 'php',
      ext: '.php',
      code: `<?php
class App {
    public function run() {
        $s = "hello world";
        $o = new \\RuntimeException("bad");
        throw $o;
    }
}
`,
    },
    {
      langId: 'c',
      ext: '.c',
      code: `
#include <stdio.h>
int main(void) {
    const char *s = "hello world";
    printf("%s\\n", s);
    return 0;
}
`,
    },
    {
      langId: 'cpp',
      ext: '.cpp',
      code: `
#include <stdexcept>
#include <string>
int run() {
    std::string s = "hello world";
    auto *p = new int(42);
    throw std::runtime_error("bad");
    return *p;
}
`,
    },
    {
      langId: 'kotlin',
      ext: '.kt',
      code: `
fun run() {
    val s = "hello world"
    throw RuntimeException("bad")
}
`,
    },
    {
      langId: 'swift',
      ext: '.swift',
      code: `
enum MyError: Error { case bad }
func run() async throws -> String {
    let s = "hello world"
    let r = try await load()
    throw MyError.bad
}
`,
    },
    {
      langId: 'scala',
      ext: '.scala',
      code: `
object App {
  def run(): Unit = {
    val s = "hello world"
    val o = new Exception("bad")
    throw o
  }
}
`,
    },
    {
      langId: 'bash',
      ext: '.sh',
      code: `
#!/bin/bash
s="hello world"
echo "$s"
`,
    },
    {
      langId: 'elixir',
      ext: '.ex',
      code: `
defmodule App do
  def run do
    s = "hello world"
    r = ~r/^[a-z]+$/
    {s, r}
  end
end
`,
    },
    {
      langId: 'lua',
      ext: '.lua',
      code: `
local function run()
    local s = "hello world"
    return s
end
`,
    },
    {
      langId: 'dart',
      ext: '.dart',
      code: `
Future<String> run() async {
  final s = "hello world";
  final r = await load();
  throw Exception("bad");
}
`,
    },
    {
      langId: 'zig',
      ext: '.zig',
      code: `
const std = @import("std");
pub fn main() void {
    const s = "hello world";
    std.debug.print("{s}\\n", .{s});
}
`,
    },
    {
      langId: 'haskell',
      ext: '.hs',
      code: `
module Main where
main :: IO ()
main = do
  let s = "hello world"
  putStrLn s
`,
    },
    {
      langId: 'ocaml',
      ext: '.ml',
      code: `
let run () =
  let s = "hello world" in
  print_endline s
`,
    },
  ];

  async function wasmExtractAstNodes(code: string, ext: string, langId: string): Promise<number> {
    const parsers = await createParsers();
    const parser = getParser(parsers, `/test/file${ext}`);
    if (!parser) return -1;
    const tree = parser.parse(code);
    if (!tree) return -1;
    const astTypeMap = AST_TYPE_MAPS.get(langId);
    if (!astTypeMap) return 0;
    const stringConfig = AST_STRING_CONFIGS.get(langId);
    const visitor = createAstStoreVisitor(
      astTypeMap,
      [],
      `/test/file${ext}`,
      new Map(),
      stringConfig,
      astStopRecurseKinds(langId),
    );
    const results = walkWithVisitors(tree.rootNode as any, [visitor], langId);
    const rows = (results['ast-store'] || []) as unknown[];
    return rows.length;
  }

  for (const fixture of PARITY_FIXTURES) {
    it.skipIf(!isNativeAvailable())(`ast_nodes row-count parity: ${fixture.langId}`, async () => {
      const wasmCount = await wasmExtractAstNodes(fixture.code, fixture.ext, fixture.langId);
      if (wasmCount === -1) return; // Grammar unavailable locally — skip.

      const nativeResult = nativeExtract(fixture.code, `/test/file${fixture.ext}`);
      const nativeCount = (nativeResult.astNodes || nativeResult.ast_nodes || []).length;

      // Allow ≤1 row tolerance — see issue #1010 acceptance criteria.
      const diff = Math.abs(wasmCount - nativeCount);
      expect(
        diff,
        `${fixture.langId}: WASM=${wasmCount}, Native=${nativeCount}`,
      ).toBeLessThanOrEqual(1);
    });
  }
});
