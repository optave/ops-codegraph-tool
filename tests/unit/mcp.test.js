/**
 * Unit tests for src/mcp.js
 *
 * Mocks @modelcontextprotocol/sdk to capture handlers,
 * and tests the TOOLS schema and dispatch logic.
 */

import { describe, expect, it, vi } from 'vitest';
import { TOOLS } from '../../src/mcp.js';

// ─── TOOLS schema ──────────────────────────────────────────────────

describe('TOOLS', () => {
  it('contains all expected tool names', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain('query_function');
    expect(names).toContain('file_deps');
    expect(names).toContain('impact_analysis');
    expect(names).toContain('find_cycles');
    expect(names).toContain('module_map');
  });

  it('each tool has name, description, and inputSchema', () => {
    for (const tool of TOOLS) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
      expect(tool.inputSchema).toHaveProperty('type', 'object');
    }
  });

  it('query_function requires name parameter', () => {
    const qf = TOOLS.find((t) => t.name === 'query_function');
    expect(qf.inputSchema.required).toContain('name');
  });

  it('file_deps requires file parameter', () => {
    const fd = TOOLS.find((t) => t.name === 'file_deps');
    expect(fd.inputSchema.required).toContain('file');
  });

  it('impact_analysis requires file parameter', () => {
    const ia = TOOLS.find((t) => t.name === 'impact_analysis');
    expect(ia.inputSchema.required).toContain('file');
  });

  it('find_cycles has no required parameters', () => {
    const fc = TOOLS.find((t) => t.name === 'find_cycles');
    expect(fc.inputSchema.required).toBeUndefined();
  });

  it('module_map has optional limit parameter', () => {
    const mm = TOOLS.find((t) => t.name === 'module_map');
    expect(mm.inputSchema.properties).toHaveProperty('limit');
    expect(mm.inputSchema.required).toBeUndefined();
  });
});

// ─── startMCPServer handler logic ────────────────────────────────────

describe('startMCPServer handler dispatch', () => {
  // We test the handler logic by mocking the SDK and capturing the registered handlers

  it('dispatches query_function to queryNameData', async () => {
    const handlers = {};

    // Mock the SDK modules
    vi.doMock('@modelcontextprotocol/sdk/server/index.js', () => ({
      Server: class MockServer {
        setRequestHandler(name, handler) {
          handlers[name] = handler;
        }
        async connect() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
      StdioServerTransport: class MockTransport {},
    }));

    // Mock query functions
    vi.doMock('../../src/queries.js', () => ({
      queryNameData: vi.fn(() => ({ query: 'test', results: [] })),
      impactAnalysisData: vi.fn(() => ({ file: 'test', sources: [] })),
      moduleMapData: vi.fn(() => ({ topNodes: [], stats: {} })),
      fileDepsData: vi.fn(() => ({ file: 'test', results: [] })),
    }));

    // Clear module cache and reimport
    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer('/tmp/test.db');

    // Test tools/list
    const toolsList = await handlers['tools/list']();
    expect(toolsList.tools.length).toBeGreaterThanOrEqual(5);

    // Test query_function dispatch
    const result = await handlers['tools/call']({
      params: { name: 'query_function', arguments: { name: 'test' } },
    });
    expect(result.content[0].type).toBe('text');
    expect(result.isError).toBeUndefined();

    // Test unknown tool
    const unknownResult = await handlers['tools/call']({
      params: { name: 'unknown_tool', arguments: {} },
    });
    expect(unknownResult.isError).toBe(true);
    expect(unknownResult.content[0].text).toContain('Unknown tool');

    vi.doUnmock('@modelcontextprotocol/sdk/server/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.doUnmock('../../src/queries.js');
  });
});
