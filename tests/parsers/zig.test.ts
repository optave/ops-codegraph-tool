import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractZigSymbols } from '../../src/domain/parser.js';

describe('Zig parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseZig(code) {
    const parser = parsers.get('zig');
    if (!parser) throw new Error('Zig parser not available');
    const tree = parser.parse(code);
    return extractZigSymbols(tree, 'test.zig');
  }

  it('extracts function declarations', () => {
    const symbols = parseZig(`pub fn add(a: i32, b: i32) i32 {
    return a + b;
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'add', kind: 'function' }),
    );
  });

  it('extracts struct definitions', () => {
    const symbols = parseZig(`const Point = struct {
    x: f64,
    y: f64,
};`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Point', kind: 'struct' }),
    );
  });

  it('extracts enum definitions', () => {
    const symbols = parseZig(`const Color = enum {
    red,
    green,
    blue,
};`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Color', kind: 'enum' }),
    );
  });

  it('extracts @import as imports', () => {
    const symbols = parseZig(`const std = @import("std");`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ source: 'std', names: expect.arrayContaining(['std']) }),
    );
  });

  it('extracts function calls', () => {
    const symbols = parseZig(`pub fn main() void {
    std.debug.print("hello", .{});
}`);
    expect(symbols.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts test declarations', () => {
    const symbols = parseZig(`test "addition" {
    const result = add(1, 2);
}`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'addition', kind: 'function' }),
    );
  });
});
