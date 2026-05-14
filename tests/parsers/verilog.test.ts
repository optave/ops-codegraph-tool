import { beforeAll, describe, expect, it } from 'vitest';
import { createParsers, extractVerilogSymbols } from '../../src/domain/parser.js';

describe('Verilog parser', () => {
  let parsers: any;

  beforeAll(async () => {
    parsers = await createParsers();
  });

  function parseVerilog(code: string) {
    const parser = parsers.get('verilog');
    if (!parser) throw new Error('Verilog parser not available');
    const tree = parser.parse(code);
    return extractVerilogSymbols(tree, 'test.v');
  }

  it('extracts module declarations', () => {
    const symbols = parseVerilog(`module counter(
    input clk,
    input reset,
    output reg [7:0] count
);
endmodule`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'counter', kind: 'module' }),
    );
  });

  it('extracts function declarations', () => {
    const symbols = parseVerilog(`module math;
    function integer add;
        input integer a, b;
        add = a + b;
    endfunction
endmodule`);
    expect(symbols.definitions).toContainEqual(expect.objectContaining({ kind: 'function' }));
  });

  it('extracts task declarations', () => {
    const symbols = parseVerilog(`module tb;
    task display_msg;
        $display("hello");
    endtask
endmodule`);
    expect(symbols.definitions).toContainEqual(expect.objectContaining({ kind: 'function' }));
  });

  it('extracts module instantiations as calls', () => {
    const symbols = parseVerilog(`module top;
    counter u1(.clk(clk), .reset(reset));
endmodule`);
    expect(symbols.calls).toContainEqual(expect.objectContaining({ name: 'counter' }));
  });

  it('extracts package imports', () => {
    const symbols = parseVerilog(`module m;
    import pkg::item;
endmodule`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({ source: 'pkg', names: ['item'] }),
    );
  });

  it('extracts class declarations with extends', () => {
    // tree-sitter-verilog wraps the class name in `class_identifier`, not a
    // bare `simple_identifier`, so the lookup must descend through the
    // wrapper. Guards against the silent regression where class extraction
    // was a no-op despite the grammar parsing the class cleanly.
    const symbols = parseVerilog(`class Foo extends Bar; endclass`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Foo', kind: 'class' }),
    );
    expect(symbols.classes).toContainEqual(
      expect.objectContaining({ name: 'Foo', extends: 'Bar' }),
    );
  });

  it('extracts class declarations without extends', () => {
    const symbols = parseVerilog(`class Baz; endclass`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'Baz', kind: 'class' }),
    );
    expect(symbols.classes.find((c: { name: string }) => c.name === 'Baz')).toBeUndefined();
  });

  it('extracts ports from ANSI-style modules', () => {
    // tree-sitter-verilog wraps ANSI declarations (`module top(input clk, …);`)
    // under `module_ansi_header`, so `extractPorts` must descend through that
    // wrapper. Without it the WASM engine returns no port children while the
    // native engine extracts them correctly — a parity violation.
    const symbols = parseVerilog(`module top(input clk, output reg q); endmodule`);
    const moduleDef = symbols.definitions.find(
      (d: { name: string; kind: string }) => d.name === 'top' && d.kind === 'module',
    );
    expect(moduleDef).toBeDefined();
    expect(moduleDef?.children).toBeDefined();
    const portNames = moduleDef?.children?.map((c: { name: string }) => c.name) ?? [];
    expect(portNames).toContain('clk');
    expect(portNames).toContain('q');
  });

  it('extracts include compiler directives as imports', () => {
    const symbols = parseVerilog(`\`include "common/defines.vh"`);
    expect(symbols.imports).toContainEqual(
      expect.objectContaining({
        source: 'common/defines.vh',
        cInclude: true,
      }),
    );
  });

  it('qualifies tasks nested inside a class with the class name', () => {
    // `findVerilogParent` must descend into `class_identifier` to recover the
    // class name when qualifying nested function/task definitions, otherwise
    // a task declared inside `class MyClass; task run; endtask endclass`
    // would surface as a bare `run` instead of `MyClass.run`.
    const symbols = parseVerilog(`class MyClass;
  task run;
    input x;
  endtask
endclass`);
    expect(symbols.definitions).toContainEqual(
      expect.objectContaining({ name: 'MyClass.run', kind: 'function' }),
    );
  });
});
