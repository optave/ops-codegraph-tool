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
});
