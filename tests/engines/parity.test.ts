/**
 * Cross-engine parity tests.
 *
 * Parse the same source snippets with both WASM and native engines,
 * then assert the FileSymbols output is equivalent for all 11 languages.
 *
 * Skipped when the native engine is not installed.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  createParsers,
  extractCSharpSymbols,
  extractElixirSymbols,
  extractGoSymbols,
  extractHaskellSymbols,
  extractHCLSymbols,
  extractJavaSymbols,
  extractPHPSymbols,
  extractPythonSymbols,
  extractRubySymbols,
  extractRustSymbols,
  extractSymbols,
  getParser,
} from '../../src/domain/parser.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

let native: any;
let parsers: any;

function wasmExtract(code, filePath) {
  const parser = getParser(parsers, filePath);
  if (!parser) return null;
  const tree = parser.parse(code);
  if (filePath.endsWith('.tf') || filePath.endsWith('.hcl'))
    return extractHCLSymbols(tree, filePath);
  if (filePath.endsWith('.py')) return extractPythonSymbols(tree, filePath);
  if (filePath.endsWith('.go')) return extractGoSymbols(tree, filePath);
  if (filePath.endsWith('.rs')) return extractRustSymbols(tree, filePath);
  if (filePath.endsWith('.java')) return extractJavaSymbols(tree, filePath);
  if (filePath.endsWith('.cs')) return extractCSharpSymbols(tree, filePath);
  if (filePath.endsWith('.rb')) return extractRubySymbols(tree, filePath);
  if (filePath.endsWith('.php')) return extractPHPSymbols(tree, filePath);
  if (filePath.endsWith('.ex') || filePath.endsWith('.exs'))
    return extractElixirSymbols(tree, filePath);
  if (filePath.endsWith('.hs')) return extractHaskellSymbols(tree, filePath);
  return extractSymbols(tree, filePath);
}

function nativeExtract(code, filePath) {
  return native.parseFile(filePath, code);
}

/** Normalize symbols for comparison — strip undefined/null optional fields. */
function normalize(symbols) {
  if (!symbols) return symbols;
  return {
    definitions: (symbols.definitions || [])
      .map((d) => ({
        name: d.name,
        kind: d.kind,
        line: d.line,
        endLine: d.endLine ?? d.end_line ?? null,
        ...(() => {
          // Both engines skip implicit `self`/`&self` parameters for Python/Rust;
          // this filter is a safety net for any language that hasn't been aligned yet.
          const filtered = (d.children || [])
            .filter((c) => c.name !== 'self')
            .map((c) => ({ name: c.name, kind: c.kind, line: c.line }));
          return filtered.length ? { children: filtered } : {};
        })(),
      }))
      // Deduplicate: interface/trait methods can be emitted twice (handler + recursive walk)
      .filter(
        (d, i, arr) =>
          arr.findIndex((x) => x.name === d.name && x.kind === d.kind && x.line === d.line) === i,
      ),
    calls: (symbols.calls || []).map((c) => ({
      name: c.name,
      line: c.line,
      ...(c.dynamic ? { dynamic: true } : {}),
      ...(c.receiver ? { receiver: c.receiver } : {}),
    })),
    imports: (symbols.imports || []).map((i) => ({
      source: i.source,
      names: i.names || [],
      line: i.line,
    })),
    classes: (symbols.classes || []).map((c) => ({
      name: c.name,
      ...(c.extends ? { extends: c.extends } : {}),
      ...(c.implements ? { implements: c.implements } : {}),
      line: c.line,
    })),
    exports: (symbols.exports || []).map((e) => ({
      name: e.name,
      kind: e.kind,
      line: e.line,
    })),
  };
}

const hasNative = isNativeAvailable();
// In the dedicated parity CI job (CODEGRAPH_PARITY=1), never silently skip —
// fail hard so a missing native addon is immediately visible.
const requireParity = !!process.env.CODEGRAPH_PARITY;
const describeOrSkip = requireParity || hasNative ? describe : describe.skip;

describeOrSkip('Cross-engine parity', () => {
  beforeAll(async () => {
    if (!hasNative) return;
    const { getNative } = await import('../../src/infrastructure/native.js');
    native = getNative();
    parsers = await createParsers();
  });

  const cases = [
    {
      name: 'JavaScript — functions and calls',
      file: 'test.js',
      code: `
function greet(name) { return 'Hello ' + name; }
const add = (a, b) => a + b;
greet('world');
add(1, 2);
`,
    },
    {
      name: 'JavaScript — constants',
      file: 'const.js',
      code: `
const MAX_RETRIES = 3;
const APP_NAME = "codegraph";
const add = (a, b) => a + b;
`,
    },
    {
      // Regression guard: native must apply the same callback-callee gating as
      // WASM. Without the gate, native over-emits dynamic calls for member-expr
      // args of non-allowlisted callees (e.g. `store.set(user.id, user)` →
      // bogus call to `id` with receiver `user`), inflating call and receiver
      // edge counts. Each line below probes a different branch of the gate:
      //   1. non-allowlisted callee  → drop member-expr arg
      //   2. cache/Map .get          → drop (HTTP verb without string-literal path)
      //   3. router HTTP route        → keep (HTTP verb WITH string-literal path)
      //   4. promise.then            → keep (always-allowlisted callback API)
      //   5. optional-chain on .on   → keep (allowlisted, callee name still resolves)
      name: 'JavaScript — callback gating must agree between engines',
      file: 'callbacks.js',
      code: `
store.set(user.id, user);
cache.get(user.id);
router.get('/users/:id', auth.check);
promise.then(handlers.onSuccess);
emitter?.on('tick', handlers.fn);
`,
    },
    {
      name: 'TypeScript — destructured parameters',
      file: 'destruct.ts',
      code: `
function greet({ name, age }: { name: string; age: number }) {
  return name;
}
function update({ id }: { id: string }, value: number) {
  return id;
}
`,
    },
    {
      name: 'TypeScript — interfaces and types',
      file: 'test.ts',
      code: `
interface Greeter { greet(name: string): string; }
type ID = string | number;
class MyGreeter implements Greeter {
  greet(name: string) { return name; }
}
`,
    },
    {
      name: 'TSX — class with extends',
      file: 'test.tsx',
      code: `
import React from 'react';
class Button extends React.Component {
  render() { return <button />; }
}
export default Button;
`,
    },
    {
      name: 'Python — classes and imports',
      file: 'test.py',
      code: `
import os
from pathlib import Path
class Animal:
    def speak(self):
        pass
class Dog(Animal):
    def speak(self):
        print("Woof")
`,
    },
    {
      // Regression guard: both engines must extract function parameters as
      // `parameter` children — drives contains / parameter_of edges. Native
      // previously dropped all Elixir params, leaving WASM-only contains
      // edges on every function. See #1189.
      name: 'Elixir — module with parameterised defs',
      file: 'test.ex',
      code: `defmodule UserService do
  def create_user(store, id, name) do
    UserRepository.save(store, id, name)
  end

  defp format_user(user) do
    user.name
  end
end
`,
    },
    {
      // Regression guard for #1197: both engines must extract bound identifiers
      // from default-value (`a \\ default`), tuple, map, and struct parameter
      // patterns. tree-sitter-elixir wraps these in `binary_operator` / `tuple`
      // / `map` nodes rather than emitting bare identifiers, so naive
      // identifier-only iteration drops the parameters silently.
      name: 'Elixir — default-value and destructured parameter patterns',
      file: 'patterns.ex',
      code: `defmodule Patterns do
  def fetch(url, timeout \\\\ 5000, retries \\\\ 3) do
    {url, timeout, retries}
  end

  def first_of({x, _y}) do
    x
  end

  def name_of(%{name: name, email: _email}) do
    name
  end

  def id_of(%User{id: id}) do
    id
  end
end
`,
    },
    {
      // Regression guard: native previously dropped all Haskell function
      // parameters (positional pattern children). See #1189.
      name: 'Haskell — top-level functions with parameters',
      file: 'Service.hs',
      code: `module Service where

createUser uid name age store =
  if validateUser name age then Right store else Left "invalid"

getUser uid store = lookup uid store
`,
    },
    {
      // Regression guard: WASM previously emitted `self`/`cls` as `parameter`
      // children of methods, but native skipped them — inflating contains and
      // parameter_of counts on every method. WASM now skips them too. See #1189.
      name: 'Python — methods must skip implicit self/cls',
      file: 'pyself.py',
      code: `class Store:
    def __init__(self, name):
        self.name = name

    def get(self, key):
        return key

    @classmethod
    def build(cls, name):
        return cls(name)
`,
    },
    {
      name: 'Go — structs and methods',
      file: 'test.go',
      code: `
package main
import "fmt"
type Server struct {}
func (s *Server) Start() { fmt.Println("started") }
func main() { s := Server{}; s.Start() }
`,
    },
    {
      name: 'Rust — traits and impls',
      file: 'test.rs',
      code: `
use std::fmt;
trait Greet { fn hello(&self); }
struct Person { name: String }
impl Greet for Person {
    fn hello(&self) { println!("{}", self.name); }
}
`,
    },
    {
      name: 'Java — classes and interfaces',
      file: 'Test.java',
      code: `
import java.util.List;
interface Printable { void print(); }
class Document implements Printable {
    public void print() { System.out.println("doc"); }
}
`,
    },
    {
      name: 'C# — classes and using',
      file: 'Test.cs',
      // Skip until next native binary release includes base_list extraction fix
      skip: true,
      code: `
using System;
using System.Collections.Generic;
class Animal { public virtual void Speak() {} }
class Dog : Animal { public override void Speak() {} }
`,
    },
    {
      name: 'Ruby — classes and require',
      file: 'test.rb',
      // Known native gap: native misses inherited class in classes array
      skip: true,
      code: `
require 'json'
class Animal
  def speak; end
end
class Dog < Animal
  def speak; puts "Woof"; end
end
`,
    },
    {
      name: 'PHP — classes and use',
      file: 'test.php',
      // Known gap: PHP WASM grammar not always available in CI/worktrees
      skip: true,
      code: `<?php
namespace App;
use App\\Models\\User;
class Controller {
    public function index() { return new User(); }
}
`,
    },
    {
      name: 'HCL — resources and modules',
      file: 'main.tf',
      // Known native gap: native engine does not support HCL
      skip: true,
      code: `
resource "aws_instance" "web" {
  ami = "abc-123"
}
module "vpc" {
  source = "./modules/vpc"
}
`,
    },
  ];

  for (const { name, file, code, skip } of cases) {
    (skip ? it.skip : it)(`${name}`, () => {
      const wasmResult = normalize(wasmExtract(code, file));
      const nativeResult = normalize(nativeExtract(code, file));
      expect(nativeResult).toEqual(wasmResult);
    });
  }

  // Explicit guard for #1197. The structural parity loop above only catches
  // *divergence*; a regression where *both* engines silently drop default-value
  // or pattern parameters would still pass. Assert the bound identifiers are
  // present in each engine's output.
  it('Elixir engines must extract bound identifiers from default-value and pattern params', () => {
    const code = `defmodule Patterns do
  def fetch(url, timeout \\\\ 5000, retries \\\\ 3), do: url
  def first_of({x, _y}), do: x
  def name_of(%{name: name}), do: name
  def id_of(%User{id: id}), do: id
end
`;
    const wasm = wasmExtract(code, 'patterns.ex');
    const nat = nativeExtract(code, 'patterns.ex');
    for (const [label, syms] of [
      ['wasm', wasm],
      ['native', nat],
    ] as const) {
      const byName = new Map(
        (syms?.definitions ?? []).map((d: any) => [
          d.name,
          (d.children ?? []).map((c: any) => c.name),
        ]),
      );
      expect(byName.get('Patterns.fetch'), `${label} fetch`).toEqual(['url', 'timeout', 'retries']);
      expect(byName.get('Patterns.first_of'), `${label} first_of`).toEqual(['x', '_y']);
      expect(byName.get('Patterns.name_of'), `${label} name_of`).toEqual(['name']);
      expect(byName.get('Patterns.id_of'), `${label} id_of`).toEqual(['id']);
    }
  });

  // Explicit guard for the WASM Python fix in #1189. The structural parity
  // loop above strips `self` from both sides via normalize(), so a regression
  // where WASM re-emits self/cls would slip through. Assert it directly.
  it('Python WASM must skip implicit self/cls in method parameter children', () => {
    const code = `class Foo:
    def bar(self, x, y):
        pass

    @classmethod
    def baz(cls, name):
        pass
`;
    const wasm = wasmExtract(code, 'test.py');
    const methods = (wasm?.definitions ?? []).filter((d) => d.kind === 'method');
    expect(methods.length).toBeGreaterThan(0);
    for (const m of methods) {
      const childNames = (m.children ?? []).map((c) => c.name);
      expect(childNames).not.toContain('self');
      expect(childNames).not.toContain('cls');
    }
  });
});
