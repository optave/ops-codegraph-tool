/**
 * Cross-engine dataflow parity tests.
 *
 * Parse the same source snippets with both WASM and native engines,
 * then assert the dataflow output is equivalent for Go, Rust, and Ruby.
 *
 * JS/TS/Python/Java/C# already have good parity coverage via the
 * 5 existing language-specific dataflow tests + build-parity.
 *
 * Skipped when the native engine is not installed or when the native
 * binary does not include dataflow support (requires local Rust build).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { extractDataflow } from '../../src/features/dataflow.js';
import { isNativeAvailable } from '../../src/native.js';
import { createParsers, getParser } from '../../src/parser.js';

let native;
let parsers;
let nativeHasDataflow = false;

/**
 * Extract dataflow via WASM: parse with tree-sitter WASM, then run
 * the JS extractDataflow() visitor.
 */
function wasmDataflow(code, filePath, langId) {
  const parser = getParser(parsers, filePath);
  if (!parser) return null;
  const tree = parser.parse(code);
  return extractDataflow(tree, filePath, [], langId);
}

/**
 * Extract dataflow via native: parseFile with include_dataflow=true.
 * Returns null if native doesn't support dataflow.
 */
function nativeDataflow(code, filePath) {
  const result = native.parseFile(filePath, code, true);
  if (!result || !result.dataflow) return null;
  const df = result.dataflow;
  return {
    parameters: (df.parameters || []).map((p) => ({
      funcName: p.funcName,
      paramName: p.paramName,
      paramIndex: p.paramIndex,
      line: p.line,
    })),
    returns: (df.returns || []).map((r) => ({
      funcName: r.funcName,
      expression: r.expression ?? '',
      referencedNames: r.referencedNames ?? [],
      line: r.line,
    })),
    assignments: (df.assignments || []).map((a) => ({
      varName: a.varName,
      callerFunc: a.callerFunc ?? null,
      sourceCallName: a.sourceCallName,
      expression: a.expression ?? '',
      line: a.line,
    })),
    argFlows: (df.argFlows ?? []).map((f) => ({
      callerFunc: f.callerFunc ?? null,
      calleeName: f.calleeName,
      argIndex: f.argIndex,
      argName: f.argName ?? null,
      confidence: f.confidence,
      expression: f.expression ?? '',
      line: f.line,
    })),
    mutations: (df.mutations || []).map((m) => ({
      funcName: m.funcName ?? null,
      receiverName: m.receiverName,
      mutatingExpr: m.mutatingExpr,
      line: m.line,
    })),
  };
}

/**
 * Normalize WASM extractDataflow() output to match the native shape.
 * WASM returns extra fields (binding, etc.) that native doesn't — strip them.
 */
function normalizeWasm(data) {
  if (!data) return null;
  return {
    parameters: (data.parameters || []).map((p) => ({
      funcName: p.funcName,
      paramName: p.paramName,
      paramIndex: p.paramIndex,
      line: p.line,
    })),
    returns: (data.returns || []).map((r) => ({
      funcName: r.funcName,
      expression: r.expression ?? '',
      referencedNames: r.referencedNames ?? [],
      line: r.line,
    })),
    assignments: (data.assignments || []).map((a) => ({
      varName: a.varName,
      callerFunc: a.callerFunc ?? null,
      sourceCallName: a.sourceCallName,
      expression: a.expression ?? '',
      line: a.line,
    })),
    argFlows: (data.argFlows ?? []).map((f) => ({
      callerFunc: f.callerFunc ?? null,
      calleeName: f.calleeName,
      argIndex: f.argIndex,
      argName: f.argName ?? null,
      confidence: f.confidence,
      expression: f.expression ?? '',
      line: f.line,
    })),
    mutations: (data.mutations || []).map((m) => ({
      funcName: m.funcName ?? null,
      receiverName: m.receiverName,
      mutatingExpr: m.mutatingExpr,
      line: m.line,
    })),
  };
}

const hasNative = isNativeAvailable();

// Detect whether the installed native binary includes dataflow support.
// The published npm prebuilt (v3.0.0) doesn't — only a local Rust build does.
function detectNativeDataflow() {
  if (!native) return false;
  const r = native.parseFile('probe.js', 'function f(a) { return a; }', true);
  return !!r?.dataflow;
}

const describeOrSkip = hasNative ? describe : describe.skip;

describeOrSkip('Cross-engine dataflow parity', () => {
  beforeAll(async () => {
    if (!hasNative) return;
    const { getNative } = await import('../../src/native.js');
    native = getNative();
    nativeHasDataflow = detectNativeDataflow();
    parsers = await createParsers();
  });

  // ── Go ─────────────────────────────────────────────────────────────────

  describe('Go', () => {
    const lang = 'go';
    const file = 'test.go';

    it('parameters — simple', ({ skip }) => {
      if (!nativeHasDataflow) skip();
      const code = 'package main\nfunc add(a int, b int) int {\n\treturn a + b\n}\n';
      const w = normalizeWasm(wasmDataflow(code, file, lang));
      const n = nativeDataflow(code, file);
      expect(n.parameters).toEqual(w.parameters);
    });

    it('returns — captures referenced names', ({ skip }) => {
      if (!nativeHasDataflow) skip();
      const code = 'package main\nfunc double(x int) int {\n\treturn x * 2\n}\n';
      const w = normalizeWasm(wasmDataflow(code, file, lang));
      const n = nativeDataflow(code, file);
      expect(n.returns).toEqual(w.returns);
    });

    it('assignments — short var declaration from call', ({ skip }) => {
      if (!nativeHasDataflow) skip();
      const code = 'package main\nfunc run() {\n\tresult := compute()\n\t_ = result\n}\n';
      const w = normalizeWasm(wasmDataflow(code, file, lang));
      const n = nativeDataflow(code, file);
      expect(n.assignments).toEqual(w.assignments);
    });

    it('argFlows — parameter passed as argument', ({ skip }) => {
      if (!nativeHasDataflow) skip();
      const code = 'package main\nfunc process(input string) {\n\ttransform(input)\n}\n';
      const w = normalizeWasm(wasmDataflow(code, file, lang));
      const n = nativeDataflow(code, file);
      expect(n.argFlows).toEqual(w.argFlows);
    });
  });

  // ── Rust ───────────────────────────────────────────────────────────────

  describe('Rust', () => {
    const lang = 'rust';
    const file = 'test.rs';

    it('parameters — simple', ({ skip }) => {
      if (!nativeHasDataflow) skip();
      const code = 'fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n';
      const w = normalizeWasm(wasmDataflow(code, file, lang));
      const n = nativeDataflow(code, file);
      expect(n.parameters).toEqual(w.parameters);
    });

    it('returns — explicit return', ({ skip }) => {
      if (!nativeHasDataflow) skip();
      const code = 'fn double(x: i32) -> i32 {\n    return x * 2;\n}\n';
      const w = normalizeWasm(wasmDataflow(code, file, lang));
      const n = nativeDataflow(code, file);
      expect(n.returns).toEqual(w.returns);
    });

    it('assignments — let binding from call', ({ skip }) => {
      if (!nativeHasDataflow) skip();
      const code = 'fn main() {\n    let result = compute();\n    println!("{}", result);\n}\n';
      const w = normalizeWasm(wasmDataflow(code, file, lang));
      const n = nativeDataflow(code, file);
      expect(n.assignments).toEqual(w.assignments);
    });

    it('argFlows — parameter passed as argument', ({ skip }) => {
      if (!nativeHasDataflow) skip();
      const code = 'fn process(input: String) {\n    transform(input);\n}\n';
      const w = normalizeWasm(wasmDataflow(code, file, lang));
      const n = nativeDataflow(code, file);
      expect(n.argFlows).toEqual(w.argFlows);
    });

    it('mutations — push on mutable parameter', ({ skip }) => {
      if (!nativeHasDataflow) skip();
      const code = 'fn add_item(items: &mut Vec<i32>, item: i32) {\n    items.push(item);\n}\n';
      const w = normalizeWasm(wasmDataflow(code, file, lang));
      const n = nativeDataflow(code, file);
      expect(n.mutations).toEqual(w.mutations);
    });
  });

  // ── Ruby ───────────────────────────────────────────────────────────────

  describe('Ruby', () => {
    const lang = 'ruby';
    const file = 'test.rb';

    it('parameters — simple', ({ skip }) => {
      if (!nativeHasDataflow) skip();
      const code = 'def add(a, b)\n  return a + b\nend\n';
      const w = normalizeWasm(wasmDataflow(code, file, lang));
      const n = nativeDataflow(code, file);
      expect(n.parameters).toEqual(w.parameters);
    });

    it('returns — explicit return', ({ skip }) => {
      if (!nativeHasDataflow) skip();
      const code = 'def double(x)\n  return x * 2\nend\n';
      const w = normalizeWasm(wasmDataflow(code, file, lang));
      const n = nativeDataflow(code, file);
      expect(n.returns).toEqual(w.returns);
    });

    it('assignments — variable from method call', ({ skip }) => {
      if (!nativeHasDataflow) skip();
      const code = 'def main\n  result = compute()\n  return result\nend\n';
      const w = normalizeWasm(wasmDataflow(code, file, lang));
      const n = nativeDataflow(code, file);
      expect(n.assignments).toEqual(w.assignments);
    });

    it('argFlows — parameter passed as argument', ({ skip }) => {
      if (!nativeHasDataflow) skip();
      const code = 'def process(input)\n  transform(input)\nend\n';
      const w = normalizeWasm(wasmDataflow(code, file, lang));
      const n = nativeDataflow(code, file);
      expect(n.argFlows).toEqual(w.argFlows);
    });
  });
});
