/**
 * Unit tests for src/mcp.js
 *
 * Mocks @modelcontextprotocol/sdk to capture handlers,
 * and tests the TOOLS schema and dispatch logic.
 */

import { describe, expect, it, vi } from 'vitest';
import { TOOLS } from '../../src/mcp.js';

const ALL_TOOL_NAMES = [
  'query_function',
  'file_deps',
  'impact_analysis',
  'find_cycles',
  'module_map',
  'fn_deps',
  'fn_impact',
  'diff_impact',
  'semantic_search',
  'export_graph',
  'list_functions',
  'list_repos',
];

// ─── TOOLS schema ──────────────────────────────────────────────────

describe('TOOLS', () => {
  it('contains all expected tool names', () => {
    const names = TOOLS.map((t) => t.name);
    for (const expected of ALL_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
    expect(names).toHaveLength(ALL_TOOL_NAMES.length);
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

  it('fn_deps requires name parameter', () => {
    const fd = TOOLS.find((t) => t.name === 'fn_deps');
    expect(fd.inputSchema.required).toContain('name');
    expect(fd.inputSchema.properties).toHaveProperty('depth');
    expect(fd.inputSchema.properties).toHaveProperty('no_tests');
  });

  it('fn_impact requires name parameter', () => {
    const fi = TOOLS.find((t) => t.name === 'fn_impact');
    expect(fi.inputSchema.required).toContain('name');
    expect(fi.inputSchema.properties).toHaveProperty('depth');
    expect(fi.inputSchema.properties).toHaveProperty('no_tests');
  });

  it('diff_impact has no required parameters', () => {
    const di = TOOLS.find((t) => t.name === 'diff_impact');
    expect(di.inputSchema.required).toBeUndefined();
    expect(di.inputSchema.properties).toHaveProperty('staged');
    expect(di.inputSchema.properties).toHaveProperty('ref');
    expect(di.inputSchema.properties).toHaveProperty('depth');
  });

  it('semantic_search requires query parameter', () => {
    const ss = TOOLS.find((t) => t.name === 'semantic_search');
    expect(ss.inputSchema.required).toContain('query');
    expect(ss.inputSchema.properties).toHaveProperty('limit');
    expect(ss.inputSchema.properties).toHaveProperty('min_score');
  });

  it('export_graph requires format parameter with enum', () => {
    const eg = TOOLS.find((t) => t.name === 'export_graph');
    expect(eg.inputSchema.required).toContain('format');
    expect(eg.inputSchema.properties.format.enum).toEqual(['dot', 'mermaid', 'json']);
    expect(eg.inputSchema.properties).toHaveProperty('file_level');
  });

  it('list_functions has no required parameters', () => {
    const lf = TOOLS.find((t) => t.name === 'list_functions');
    expect(lf.inputSchema.required).toBeUndefined();
    expect(lf.inputSchema.properties).toHaveProperty('file');
    expect(lf.inputSchema.properties).toHaveProperty('pattern');
    expect(lf.inputSchema.properties).toHaveProperty('no_tests');
  });

  it('every tool except list_repos has optional repo property', () => {
    for (const tool of TOOLS) {
      if (tool.name === 'list_repos') continue;
      expect(tool.inputSchema.properties).toHaveProperty('repo');
      expect(tool.inputSchema.properties.repo.type).toBe('string');
      // repo must never be required
      if (tool.inputSchema.required) {
        expect(tool.inputSchema.required).not.toContain('repo');
      }
    }
  });

  it('list_repos tool exists with no required params', () => {
    const lr = TOOLS.find((t) => t.name === 'list_repos');
    expect(lr).toBeDefined();
    expect(lr.inputSchema.required).toBeUndefined();
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
      fnDepsData: vi.fn(() => ({ name: 'test', results: [] })),
      fnImpactData: vi.fn(() => ({ name: 'test', results: [] })),
      diffImpactData: vi.fn(() => ({ changedFiles: 0, affectedFunctions: [] })),
      listFunctionsData: vi.fn(() => ({ count: 0, functions: [] })),
    }));

    // Clear module cache and reimport
    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer('/tmp/test.db');

    // Test tools/list
    const toolsList = await handlers['tools/list']();
    expect(toolsList.tools.length).toBe(ALL_TOOL_NAMES.length);

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

  it('dispatches fn_deps to fnDepsData', async () => {
    const handlers = {};

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

    const fnDepsMock = vi.fn(() => ({ name: 'myFn', results: [{ callers: [] }] }));
    vi.doMock('../../src/queries.js', () => ({
      queryNameData: vi.fn(),
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: fnDepsMock,
      fnImpactData: vi.fn(),
      diffImpactData: vi.fn(),
      listFunctionsData: vi.fn(),
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer('/tmp/test.db');

    const result = await handlers['tools/call']({
      params: { name: 'fn_deps', arguments: { name: 'myFn', depth: 5, no_tests: true } },
    });
    expect(result.isError).toBeUndefined();
    expect(fnDepsMock).toHaveBeenCalledWith('myFn', '/tmp/test.db', { depth: 5, noTests: true });

    vi.doUnmock('@modelcontextprotocol/sdk/server/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.doUnmock('../../src/queries.js');
  });

  it('dispatches fn_impact to fnImpactData', async () => {
    const handlers = {};

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

    const fnImpactMock = vi.fn(() => ({ name: 'test', results: [] }));
    vi.doMock('../../src/queries.js', () => ({
      queryNameData: vi.fn(),
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: vi.fn(),
      fnImpactData: fnImpactMock,
      diffImpactData: vi.fn(),
      listFunctionsData: vi.fn(),
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer('/tmp/test.db');

    const result = await handlers['tools/call']({
      params: { name: 'fn_impact', arguments: { name: 'handleClick' } },
    });
    expect(result.isError).toBeUndefined();
    expect(fnImpactMock).toHaveBeenCalledWith('handleClick', '/tmp/test.db', {
      depth: undefined,
      noTests: undefined,
    });

    vi.doUnmock('@modelcontextprotocol/sdk/server/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.doUnmock('../../src/queries.js');
  });

  it('dispatches diff_impact to diffImpactData', async () => {
    const handlers = {};

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

    const diffImpactMock = vi.fn(() => ({ changedFiles: 2, affectedFunctions: [] }));
    vi.doMock('../../src/queries.js', () => ({
      queryNameData: vi.fn(),
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: vi.fn(),
      fnImpactData: vi.fn(),
      diffImpactData: diffImpactMock,
      listFunctionsData: vi.fn(),
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer('/tmp/test.db');

    const result = await handlers['tools/call']({
      params: { name: 'diff_impact', arguments: { staged: true } },
    });
    expect(result.isError).toBeUndefined();
    expect(diffImpactMock).toHaveBeenCalledWith('/tmp/test.db', {
      staged: true,
      ref: undefined,
      depth: undefined,
      noTests: undefined,
    });

    vi.doUnmock('@modelcontextprotocol/sdk/server/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.doUnmock('../../src/queries.js');
  });

  it('dispatches list_functions to listFunctionsData', async () => {
    const handlers = {};

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

    const listFnMock = vi.fn(() => ({
      count: 3,
      functions: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    }));
    vi.doMock('../../src/queries.js', () => ({
      queryNameData: vi.fn(),
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: vi.fn(),
      fnImpactData: vi.fn(),
      diffImpactData: vi.fn(),
      listFunctionsData: listFnMock,
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer('/tmp/test.db');

    const result = await handlers['tools/call']({
      params: { name: 'list_functions', arguments: { file: 'utils', pattern: 'parse' } },
    });
    expect(result.isError).toBeUndefined();
    expect(listFnMock).toHaveBeenCalledWith('/tmp/test.db', {
      file: 'utils',
      pattern: 'parse',
      noTests: undefined,
    });

    vi.doUnmock('@modelcontextprotocol/sdk/server/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.doUnmock('../../src/queries.js');
  });

  it('resolves repo param via registry', async () => {
    const handlers = {};

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
    vi.doMock('../../src/registry.js', () => ({
      resolveRepoDbPath: vi.fn((name) =>
        name === 'my-project' ? '/resolved/path/.codegraph/graph.db' : undefined,
      ),
    }));

    const queryMock = vi.fn(() => ({ query: 'test', results: [] }));
    vi.doMock('../../src/queries.js', () => ({
      queryNameData: queryMock,
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: vi.fn(),
      fnImpactData: vi.fn(),
      diffImpactData: vi.fn(),
      listFunctionsData: vi.fn(),
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer();

    const result = await handlers['tools/call']({
      params: { name: 'query_function', arguments: { name: 'test', repo: 'my-project' } },
    });
    expect(result.isError).toBeUndefined();
    expect(queryMock).toHaveBeenCalledWith('test', '/resolved/path/.codegraph/graph.db');

    vi.doUnmock('@modelcontextprotocol/sdk/server/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.doUnmock('../../src/registry.js');
    vi.doUnmock('../../src/queries.js');
  });

  it('returns error when repo not found in registry', async () => {
    const handlers = {};

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
    vi.doMock('../../src/registry.js', () => ({
      resolveRepoDbPath: vi.fn(() => undefined),
    }));
    vi.doMock('../../src/queries.js', () => ({
      queryNameData: vi.fn(),
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: vi.fn(),
      fnImpactData: vi.fn(),
      diffImpactData: vi.fn(),
      listFunctionsData: vi.fn(),
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer();

    const result = await handlers['tools/call']({
      params: { name: 'query_function', arguments: { name: 'test', repo: 'unknown-repo' } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unknown-repo');
    expect(result.content[0].text).toContain('not found');

    vi.doUnmock('@modelcontextprotocol/sdk/server/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.doUnmock('../../src/registry.js');
    vi.doUnmock('../../src/queries.js');
  });
});
