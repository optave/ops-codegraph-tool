/**
 * Unit tests for src/mcp.js
 *
 * Mocks @modelcontextprotocol/sdk to capture handlers,
 * and tests the TOOLS schema and dispatch logic.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildToolList, TOOLS } from '../../src/mcp.js';

const ALL_TOOL_NAMES = [
  'query',
  'file_deps',
  'file_exports',
  'impact_analysis',
  'find_cycles',
  'module_map',
  'fn_impact',
  'context',
  'explain',
  'where',
  'diff_impact',
  'semantic_search',
  'export_graph',
  'list_functions',
  'structure',
  'hotspots',
  'co_changes',
  'node_roles',
  'execution_flow',
  'complexity',
  'manifesto',
  'communities',
  'code_owners',
  'audit',
  'batch_query',
  'triage',
  'branch_compare',
  'dataflow',
  'check',
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

  it('query requires name parameter and has mode enum', () => {
    const q = TOOLS.find((t) => t.name === 'query');
    expect(q.inputSchema.required).toContain('name');
    expect(q.inputSchema.properties).toHaveProperty('mode');
    expect(q.inputSchema.properties.mode.enum).toEqual(['deps', 'path']);
    expect(q.inputSchema.properties).toHaveProperty('to');
    expect(q.inputSchema.properties).toHaveProperty('file');
    expect(q.inputSchema.properties).toHaveProperty('kind');
    expect(q.inputSchema.properties.kind.enum).toBeDefined();
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

  it('fn_impact requires name parameter', () => {
    const fi = TOOLS.find((t) => t.name === 'fn_impact');
    expect(fi.inputSchema.required).toContain('name');
    expect(fi.inputSchema.properties).toHaveProperty('depth');
    expect(fi.inputSchema.properties).toHaveProperty('no_tests');
    expect(fi.inputSchema.properties).toHaveProperty('file');
    expect(fi.inputSchema.properties).toHaveProperty('kind');
    expect(fi.inputSchema.properties.kind.enum).toBeDefined();
  });

  it('where requires target parameter', () => {
    const w = TOOLS.find((t) => t.name === 'where');
    expect(w).toBeDefined();
    expect(w.inputSchema.required).toContain('target');
    expect(w.inputSchema.properties).toHaveProperty('target');
    expect(w.inputSchema.properties).toHaveProperty('file_mode');
    expect(w.inputSchema.properties).toHaveProperty('no_tests');
  });

  it('diff_impact has no required parameters', () => {
    const di = TOOLS.find((t) => t.name === 'diff_impact');
    expect(di.inputSchema.required).toBeUndefined();
    expect(di.inputSchema.properties).toHaveProperty('staged');
    expect(di.inputSchema.properties).toHaveProperty('ref');
    expect(di.inputSchema.properties).toHaveProperty('depth');
  });

  it('check has no required parameters', () => {
    const ch = TOOLS.find((t) => t.name === 'check');
    expect(ch).toBeDefined();
    expect(ch.inputSchema.required).toBeUndefined();
    expect(ch.inputSchema.properties).toHaveProperty('ref');
    expect(ch.inputSchema.properties).toHaveProperty('staged');
    expect(ch.inputSchema.properties).toHaveProperty('cycles');
    expect(ch.inputSchema.properties).toHaveProperty('blast_radius');
    expect(ch.inputSchema.properties).toHaveProperty('signatures');
    expect(ch.inputSchema.properties).toHaveProperty('boundaries');
    expect(ch.inputSchema.properties).toHaveProperty('depth');
    expect(ch.inputSchema.properties).toHaveProperty('no_tests');
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

  it('structure has no required parameters', () => {
    const st = TOOLS.find((t) => t.name === 'structure');
    expect(st).toBeDefined();
    expect(st.inputSchema.required).toBeUndefined();
    expect(st.inputSchema.properties).toHaveProperty('directory');
    expect(st.inputSchema.properties).toHaveProperty('depth');
    expect(st.inputSchema.properties).toHaveProperty('sort');
  });

  it('hotspots has no required parameters', () => {
    const hs = TOOLS.find((t) => t.name === 'hotspots');
    expect(hs).toBeDefined();
    expect(hs.inputSchema.required).toBeUndefined();
    expect(hs.inputSchema.properties).toHaveProperty('metric');
    expect(hs.inputSchema.properties).toHaveProperty('level');
    expect(hs.inputSchema.properties).toHaveProperty('limit');
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

// ─── buildToolList ──────────────────────────────────────────────────

describe('buildToolList', () => {
  it('single-repo mode excludes list_repos and repo property', () => {
    const tools = buildToolList(false);
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('list_repos');
    for (const tool of tools) {
      expect(tool.inputSchema.properties).not.toHaveProperty('repo');
    }
  });

  it('multi-repo mode includes list_repos and repo property on all other tools', () => {
    const tools = buildToolList(true);
    const names = tools.map((t) => t.name);
    expect(names).toContain('list_repos');
    for (const tool of tools) {
      if (tool.name === 'list_repos') continue;
      expect(tool.inputSchema.properties).toHaveProperty('repo');
      expect(tool.inputSchema.properties.repo.type).toBe('string');
    }
  });
});

// ─── startMCPServer handler logic ────────────────────────────────────

describe('startMCPServer handler dispatch', () => {
  // We test the handler logic by mocking the SDK and capturing the registered handlers

  it('dispatches query to fnDepsData', async () => {
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
    vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
      ListToolsRequestSchema: 'tools/list',
      CallToolRequestSchema: 'tools/call',
    }));

    // Mock query functions
    vi.doMock('../../src/queries.js', () => ({
      impactAnalysisData: vi.fn(() => ({ file: 'test', sources: [] })),
      moduleMapData: vi.fn(() => ({ topNodes: [], stats: {} })),
      fileDepsData: vi.fn(() => ({ file: 'test', results: [] })),
      fnDepsData: vi.fn(() => ({ name: 'test', results: [] })),
      fnImpactData: vi.fn(() => ({ name: 'test', results: [] })),
      contextData: vi.fn(() => ({ name: 'test', results: [] })),
      explainData: vi.fn(() => ({ target: 'test', kind: 'function', results: [] })),
      exportsData: vi.fn(() => ({
        file: 'test',
        results: [],
        reexports: [],
        totalExported: 0,
        totalInternal: 0,
      })),
      whereData: vi.fn(() => ({ target: 'test', mode: 'symbol', results: [] })),
      diffImpactData: vi.fn(() => ({ changedFiles: 0, affectedFunctions: [] })),
      listFunctionsData: vi.fn(() => ({ count: 0, functions: [] })),
      rolesData: vi.fn(() => ({ count: 0, summary: {}, symbols: [] })),
      pathData: vi.fn(() => ({ from: 'a', to: 'b', found: false })),
    }));

    // Clear module cache and reimport
    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer('/tmp/test.db');

    // Test tools/list — single-repo mode by default (no list_repos)
    const toolsList = await handlers['tools/list']();
    expect(toolsList.tools.length).toBe(ALL_TOOL_NAMES.length - 1);
    expect(toolsList.tools.map((t) => t.name)).not.toContain('list_repos');

    // Test query dispatch
    const result = await handlers['tools/call']({
      params: { name: 'query', arguments: { name: 'test' } },
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

  it('dispatches query deps mode to fnDepsData with options', async () => {
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
    vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
      ListToolsRequestSchema: 'tools/list',
      CallToolRequestSchema: 'tools/call',
    }));

    const fnDepsMock = vi.fn(() => ({ name: 'myFn', results: [{ callers: [] }] }));
    vi.doMock('../../src/queries.js', () => ({
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: fnDepsMock,
      fnImpactData: vi.fn(),
      contextData: vi.fn(),
      explainData: vi.fn(),
      exportsData: vi.fn(),
      whereData: vi.fn(),
      diffImpactData: vi.fn(),
      listFunctionsData: vi.fn(),
      rolesData: vi.fn(),
      pathData: vi.fn(() => ({ from: 'a', to: 'b', found: false })),
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer('/tmp/test.db');

    const result = await handlers['tools/call']({
      params: {
        name: 'query',
        arguments: { name: 'myFn', depth: 5, file: 'src/app.js', kind: 'function', no_tests: true },
      },
    });
    expect(result.isError).toBeUndefined();
    expect(fnDepsMock).toHaveBeenCalledWith('myFn', '/tmp/test.db', {
      depth: 5,
      file: 'src/app.js',
      kind: 'function',
      noTests: true,
      limit: 10,
      offset: 0,
    });

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
    vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
      ListToolsRequestSchema: 'tools/list',
      CallToolRequestSchema: 'tools/call',
    }));

    const fnImpactMock = vi.fn(() => ({ name: 'test', results: [] }));
    vi.doMock('../../src/queries.js', () => ({
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: vi.fn(),
      fnImpactData: fnImpactMock,
      contextData: vi.fn(),
      explainData: vi.fn(),
      exportsData: vi.fn(),
      whereData: vi.fn(),
      diffImpactData: vi.fn(),
      listFunctionsData: vi.fn(),
      rolesData: vi.fn(),
      pathData: vi.fn(() => ({ from: 'a', to: 'b', found: false })),
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer('/tmp/test.db');

    const result = await handlers['tools/call']({
      params: { name: 'fn_impact', arguments: { name: 'handleClick' } },
    });
    expect(result.isError).toBeUndefined();
    expect(fnImpactMock).toHaveBeenCalledWith('handleClick', '/tmp/test.db', {
      depth: undefined,
      file: undefined,
      kind: undefined,
      noTests: undefined,
      limit: 5,
      offset: 0,
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
    vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
      ListToolsRequestSchema: 'tools/list',
      CallToolRequestSchema: 'tools/call',
    }));

    const diffImpactMock = vi.fn(() => ({ changedFiles: 2, affectedFunctions: [] }));
    vi.doMock('../../src/queries.js', () => ({
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: vi.fn(),
      fnImpactData: vi.fn(),
      contextData: vi.fn(),
      explainData: vi.fn(),
      exportsData: vi.fn(),
      whereData: vi.fn(),
      diffImpactData: diffImpactMock,
      listFunctionsData: vi.fn(),
      rolesData: vi.fn(),
      pathData: vi.fn(() => ({ from: 'a', to: 'b', found: false })),
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
      limit: 30,
      offset: 0,
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
    vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
      ListToolsRequestSchema: 'tools/list',
      CallToolRequestSchema: 'tools/call',
    }));

    const listFnMock = vi.fn(() => ({
      count: 3,
      functions: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    }));
    vi.doMock('../../src/queries.js', () => ({
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: vi.fn(),
      fnImpactData: vi.fn(),
      contextData: vi.fn(),
      explainData: vi.fn(),
      exportsData: vi.fn(),
      whereData: vi.fn(),
      diffImpactData: vi.fn(),
      listFunctionsData: listFnMock,
      rolesData: vi.fn(),
      pathData: vi.fn(() => ({ from: 'a', to: 'b', found: false })),
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
      limit: 100,
      offset: 0,
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
    vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
      ListToolsRequestSchema: 'tools/list',
      CallToolRequestSchema: 'tools/call',
    }));
    vi.doMock('../../src/registry.js', () => ({
      resolveRepoDbPath: vi.fn((name) =>
        name === 'my-project' ? '/resolved/path/.codegraph/graph.db' : undefined,
      ),
    }));

    const fnDepsMock = vi.fn(() => ({ name: 'test', results: [] }));
    vi.doMock('../../src/queries.js', () => ({
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: fnDepsMock,
      fnImpactData: vi.fn(),
      contextData: vi.fn(),
      explainData: vi.fn(),
      exportsData: vi.fn(),
      whereData: vi.fn(),
      diffImpactData: vi.fn(),
      listFunctionsData: vi.fn(),
      rolesData: vi.fn(),
      pathData: vi.fn(() => ({ from: 'a', to: 'b', found: false })),
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer(undefined, { multiRepo: true });

    const result = await handlers['tools/call']({
      params: { name: 'query', arguments: { name: 'test', repo: 'my-project' } },
    });
    expect(result.isError).toBeUndefined();
    expect(fnDepsMock).toHaveBeenCalledWith('test', '/resolved/path/.codegraph/graph.db', {
      depth: undefined,
      file: undefined,
      kind: undefined,
      noTests: undefined,
      limit: 10,
      offset: 0,
    });

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
    vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
      ListToolsRequestSchema: 'tools/list',
      CallToolRequestSchema: 'tools/call',
    }));
    vi.doMock('../../src/registry.js', () => ({
      resolveRepoDbPath: vi.fn(() => undefined),
    }));
    vi.doMock('../../src/queries.js', () => ({
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: vi.fn(),
      fnImpactData: vi.fn(),
      contextData: vi.fn(),
      explainData: vi.fn(),
      exportsData: vi.fn(),
      whereData: vi.fn(),
      diffImpactData: vi.fn(),
      listFunctionsData: vi.fn(),
      rolesData: vi.fn(),
      pathData: vi.fn(() => ({ from: 'a', to: 'b', found: false })),
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer(undefined, { multiRepo: true });

    const result = await handlers['tools/call']({
      params: { name: 'query', arguments: { name: 'test', repo: 'unknown-repo' } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unknown-repo');
    expect(result.content[0].text).toContain('not found');

    vi.doUnmock('@modelcontextprotocol/sdk/server/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.doUnmock('../../src/registry.js');
    vi.doUnmock('../../src/queries.js');
  });

  it('rejects repo not in allowedRepos list', async () => {
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
    vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
      ListToolsRequestSchema: 'tools/list',
      CallToolRequestSchema: 'tools/call',
    }));
    vi.doMock('../../src/registry.js', () => ({
      resolveRepoDbPath: vi.fn(() => '/some/path'),
    }));
    vi.doMock('../../src/queries.js', () => ({
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: vi.fn(),
      fnImpactData: vi.fn(),
      contextData: vi.fn(),
      explainData: vi.fn(),
      exportsData: vi.fn(),
      whereData: vi.fn(),
      diffImpactData: vi.fn(),
      listFunctionsData: vi.fn(),
      rolesData: vi.fn(),
      pathData: vi.fn(() => ({ from: 'a', to: 'b', found: false })),
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer(undefined, { allowedRepos: ['allowed-repo'] });

    const result = await handlers['tools/call']({
      params: { name: 'query', arguments: { name: 'test', repo: 'blocked-repo' } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('blocked-repo');
    expect(result.content[0].text).toContain('not in the allowed');

    vi.doUnmock('@modelcontextprotocol/sdk/server/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.doUnmock('../../src/registry.js');
    vi.doUnmock('../../src/queries.js');
  });

  it('allows repo in allowedRepos list', async () => {
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
    vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
      ListToolsRequestSchema: 'tools/list',
      CallToolRequestSchema: 'tools/call',
    }));
    vi.doMock('../../src/registry.js', () => ({
      resolveRepoDbPath: vi.fn(() => '/resolved/db'),
    }));

    const fnDepsMock = vi.fn(() => ({ name: 'test', results: [] }));
    vi.doMock('../../src/queries.js', () => ({
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: fnDepsMock,
      fnImpactData: vi.fn(),
      contextData: vi.fn(),
      explainData: vi.fn(),
      exportsData: vi.fn(),
      whereData: vi.fn(),
      diffImpactData: vi.fn(),
      listFunctionsData: vi.fn(),
      rolesData: vi.fn(),
      pathData: vi.fn(() => ({ from: 'a', to: 'b', found: false })),
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer(undefined, { allowedRepos: ['my-repo'] });

    const result = await handlers['tools/call']({
      params: { name: 'query', arguments: { name: 'test', repo: 'my-repo' } },
    });
    expect(result.isError).toBeUndefined();
    expect(fnDepsMock).toHaveBeenCalledWith('test', '/resolved/db', {
      depth: undefined,
      file: undefined,
      kind: undefined,
      noTests: undefined,
      limit: 10,
      offset: 0,
    });

    vi.doUnmock('@modelcontextprotocol/sdk/server/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.doUnmock('../../src/registry.js');
    vi.doUnmock('../../src/queries.js');
  });

  it('list_repos filters by allowedRepos', async () => {
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
    vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
      ListToolsRequestSchema: 'tools/list',
      CallToolRequestSchema: 'tools/call',
    }));
    vi.doMock('../../src/registry.js', () => ({
      resolveRepoDbPath: vi.fn(),
      listRepos: vi.fn(() => [
        { name: 'alpha', path: '/alpha' },
        { name: 'beta', path: '/beta' },
        { name: 'gamma', path: '/gamma' },
      ]),
      pruneRegistry: vi.fn(),
    }));
    vi.doMock('../../src/queries.js', () => ({
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: vi.fn(),
      fnImpactData: vi.fn(),
      contextData: vi.fn(),
      explainData: vi.fn(),
      exportsData: vi.fn(),
      whereData: vi.fn(),
      diffImpactData: vi.fn(),
      listFunctionsData: vi.fn(),
      rolesData: vi.fn(),
      pathData: vi.fn(() => ({ from: 'a', to: 'b', found: false })),
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer(undefined, { allowedRepos: ['alpha', 'gamma'] });

    const result = await handlers['tools/call']({
      params: { name: 'list_repos', arguments: {} },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.repos).toHaveLength(2);
    expect(data.repos.map((r) => r.name)).toEqual(['alpha', 'gamma']);

    vi.doUnmock('@modelcontextprotocol/sdk/server/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.doUnmock('../../src/registry.js');
    vi.doUnmock('../../src/queries.js');
  });

  it('list_repos returns all repos when no allowlist', async () => {
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
    vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
      ListToolsRequestSchema: 'tools/list',
      CallToolRequestSchema: 'tools/call',
    }));
    vi.doMock('../../src/registry.js', () => ({
      resolveRepoDbPath: vi.fn(),
      listRepos: vi.fn(() => [
        { name: 'alpha', path: '/alpha' },
        { name: 'beta', path: '/beta' },
      ]),
      pruneRegistry: vi.fn(),
    }));
    vi.doMock('../../src/queries.js', () => ({
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: vi.fn(),
      fnImpactData: vi.fn(),
      contextData: vi.fn(),
      explainData: vi.fn(),
      exportsData: vi.fn(),
      whereData: vi.fn(),
      diffImpactData: vi.fn(),
      listFunctionsData: vi.fn(),
      rolesData: vi.fn(),
      pathData: vi.fn(() => ({ from: 'a', to: 'b', found: false })),
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer(undefined, { multiRepo: true });

    const result = await handlers['tools/call']({
      params: { name: 'list_repos', arguments: {} },
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.repos).toHaveLength(2);

    vi.doUnmock('@modelcontextprotocol/sdk/server/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.doUnmock('../../src/registry.js');
    vi.doUnmock('../../src/queries.js');
  });

  it('rejects repo param in single-repo mode', async () => {
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
    vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
      ListToolsRequestSchema: 'tools/list',
      CallToolRequestSchema: 'tools/call',
    }));
    vi.doMock('../../src/queries.js', () => ({
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: vi.fn(),
      fnImpactData: vi.fn(),
      contextData: vi.fn(),
      explainData: vi.fn(),
      exportsData: vi.fn(),
      whereData: vi.fn(),
      diffImpactData: vi.fn(),
      listFunctionsData: vi.fn(),
      rolesData: vi.fn(),
      pathData: vi.fn(() => ({ from: 'a', to: 'b', found: false })),
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer('/tmp/test.db');

    const result = await handlers['tools/call']({
      params: { name: 'query', arguments: { name: 'test', repo: 'some-repo' } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Multi-repo access is disabled');
    expect(result.content[0].text).toContain('--multi-repo');

    vi.doUnmock('@modelcontextprotocol/sdk/server/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.doUnmock('../../src/queries.js');
  });

  it('rejects list_repos in single-repo mode', async () => {
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
    vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
      ListToolsRequestSchema: 'tools/list',
      CallToolRequestSchema: 'tools/call',
    }));
    vi.doMock('../../src/queries.js', () => ({
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: vi.fn(),
      fnImpactData: vi.fn(),
      contextData: vi.fn(),
      explainData: vi.fn(),
      exportsData: vi.fn(),
      whereData: vi.fn(),
      diffImpactData: vi.fn(),
      listFunctionsData: vi.fn(),
      rolesData: vi.fn(),
      pathData: vi.fn(() => ({ from: 'a', to: 'b', found: false })),
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer('/tmp/test.db');

    const result = await handlers['tools/call']({
      params: { name: 'list_repos', arguments: {} },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Multi-repo access is disabled');
    expect(result.content[0].text).toContain('--multi-repo');

    vi.doUnmock('@modelcontextprotocol/sdk/server/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.doUnmock('../../src/queries.js');
  });

  it('tools/list in single-repo mode has no repo property and no list_repos', async () => {
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
    vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
      ListToolsRequestSchema: 'tools/list',
      CallToolRequestSchema: 'tools/call',
    }));
    vi.doMock('../../src/queries.js', () => ({
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: vi.fn(),
      fnImpactData: vi.fn(),
      contextData: vi.fn(),
      explainData: vi.fn(),
      exportsData: vi.fn(),
      whereData: vi.fn(),
      diffImpactData: vi.fn(),
      listFunctionsData: vi.fn(),
      rolesData: vi.fn(),
      pathData: vi.fn(() => ({ from: 'a', to: 'b', found: false })),
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer('/tmp/test.db');

    const toolsList = await handlers['tools/list']();
    const names = toolsList.tools.map((t) => t.name);
    expect(names).not.toContain('list_repos');
    for (const tool of toolsList.tools) {
      expect(tool.inputSchema.properties).not.toHaveProperty('repo');
    }

    vi.doUnmock('@modelcontextprotocol/sdk/server/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.doUnmock('../../src/queries.js');
  });

  it('dispatches complexity to complexityData', async () => {
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
    vi.doMock('@modelcontextprotocol/sdk/types.js', () => ({
      ListToolsRequestSchema: 'tools/list',
      CallToolRequestSchema: 'tools/call',
    }));

    vi.doMock('../../src/queries.js', () => ({
      impactAnalysisData: vi.fn(),
      moduleMapData: vi.fn(),
      fileDepsData: vi.fn(),
      fnDepsData: vi.fn(),
      fnImpactData: vi.fn(),
      contextData: vi.fn(),
      explainData: vi.fn(),
      exportsData: vi.fn(),
      whereData: vi.fn(),
      diffImpactData: vi.fn(),
      listFunctionsData: vi.fn(),
      rolesData: vi.fn(),
      pathData: vi.fn(() => ({ from: 'a', to: 'b', found: false })),
    }));

    const complexityMock = vi.fn(() => ({
      functions: [{ name: 'buildGraph', cognitive: 50, cyclomatic: 20, maxNesting: 5 }],
      summary: { analyzed: 1, avgCognitive: 50, avgCyclomatic: 20 },
      thresholds: { cognitive: { warn: 15 }, cyclomatic: { warn: 10 }, maxNesting: { warn: 4 } },
    }));
    vi.doMock('../../src/complexity.js', () => ({
      complexityData: complexityMock,
    }));

    const { startMCPServer } = await import('../../src/mcp.js');
    await startMCPServer('/tmp/test.db');

    const result = await handlers['tools/call']({
      params: {
        name: 'complexity',
        arguments: {
          name: 'buildGraph',
          file: 'src/builder.js',
          limit: 10,
          sort: 'cyclomatic',
          above_threshold: true,
          no_tests: true,
          kind: 'function',
        },
      },
    });
    expect(result.isError).toBeUndefined();
    expect(complexityMock).toHaveBeenCalledWith('/tmp/test.db', {
      target: 'buildGraph',
      file: 'src/builder.js',
      limit: 10,
      offset: 0,
      sort: 'cyclomatic',
      aboveThreshold: true,
      health: undefined,
      noTests: true,
      kind: 'function',
    });

    vi.doUnmock('@modelcontextprotocol/sdk/server/index.js');
    vi.doUnmock('@modelcontextprotocol/sdk/server/stdio.js');
    vi.doUnmock('../../src/queries.js');
    vi.doUnmock('../../src/complexity.js');
  });
});
