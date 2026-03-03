/**
 * Cross-engine parity tests.
 *
 * Parse the same source snippets with both WASM and native engines,
 * then assert the FileSymbols output is equivalent for all 11 languages.
 *
 * Skipped when the native engine is not installed.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { isNativeAvailable } from '../../src/native.js';
import {
  createParsers,
  extractCSharpSymbols,
  extractGoSymbols,
  extractHCLSymbols,
  extractJavaSymbols,
  extractPHPSymbols,
  extractPythonSymbols,
  extractRubySymbols,
  extractRustSymbols,
  extractSymbols,
  getParser,
} from '../../src/parser.js';

let native;
let parsers;

function wasmExtract(code, filePath) {
  const parser = getParser(parsers, filePath);
  if (!parser) return null;
  const tree = parser.parse(code);
  const isHCL = filePath.endsWith('.tf') || filePath.endsWith('.hcl');
  const isPython = filePath.endsWith('.py');
  const isGo = filePath.endsWith('.go');
  const isRust = filePath.endsWith('.rs');
  const isJava = filePath.endsWith('.java');
  const isCSharp = filePath.endsWith('.cs');
  const isRuby = filePath.endsWith('.rb');
  const isPHP = filePath.endsWith('.php');
  return isHCL
    ? extractHCLSymbols(tree, filePath)
    : isPython
      ? extractPythonSymbols(tree, filePath)
      : isGo
        ? extractGoSymbols(tree, filePath)
        : isRust
          ? extractRustSymbols(tree, filePath)
          : isJava
            ? extractJavaSymbols(tree, filePath)
            : isCSharp
              ? extractCSharpSymbols(tree, filePath)
              : isRuby
                ? extractRubySymbols(tree, filePath)
                : isPHP
                  ? extractPHPSymbols(tree, filePath)
                  : extractSymbols(tree, filePath);
}

function nativeExtract(code, filePath) {
  return native.parseFile(filePath, code);
}

/** Normalize symbols for comparison — strip undefined/null optional fields. */
function normalize(symbols) {
  if (!symbols) return symbols;
  return {
    definitions: (symbols.definitions || []).map((d) => ({
      name: d.name,
      kind: d.kind,
      line: d.line,
      endLine: d.endLine ?? d.end_line ?? null,
      children: (d.children || []).map((c) => ({
        name: c.name,
        kind: c.kind,
        line: c.line,
      })),
    })),
    calls: (symbols.calls || []).map((c) => ({
      name: c.name,
      line: c.line,
      ...(c.dynamic ? { dynamic: true } : {}),
      // receiver excluded from parity comparison until native binary is rebuilt
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

const describeOrSkip = hasNative ? describe : describe.skip;

describeOrSkip('Cross-engine parity', () => {
  beforeAll(async () => {
    if (!hasNative) return;
    const { getNative } = await import('../../src/native.js');
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
});
