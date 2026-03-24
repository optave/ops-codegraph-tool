/**
 * Unit tests for presentation/queries-cli/ modules.
 *
 * Mocks the domain layer to supply controlled data, then verifies
 * that the CLI formatters produce the expected console output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock domain layer ──────────────────────────────────────────────
const mocks = {
  whereData: vi.fn(),
  queryNameData: vi.fn(),
  contextData: vi.fn(),
  childrenData: vi.fn(),
  explainData: vi.fn(),
  implementationsData: vi.fn(),
  interfacesData: vi.fn(),
  pathData: vi.fn(),
  exportsData: vi.fn(),
  moduleMapData: vi.fn(),
  rolesData: vi.fn(),
  statsData: vi.fn(),
  kindIcon: vi.fn((kind) => kind.charAt(0)),
};

vi.mock('../../src/domain/queries.js', () => mocks);
vi.mock('../../src/infrastructure/result-formatter.js', () => ({
  outputResult: () => false, // never short-circuit — always render CLI output
}));
// Also mock the canonical path so the tests remain correct if imports
// are refactored away from the backward-compat re-export.
vi.mock('../../src/presentation/result-formatter.js', () => ({
  outputResult: () => false,
}));

// ── Import modules under test ──────────────────────────────────────
const { where, queryName, context, children, explain, implementations, interfaces } = await import(
  '../../src/presentation/queries-cli/inspect.js'
);
const { symbolPath } = await import('../../src/presentation/queries-cli/path.js');
const { fileExports } = await import('../../src/presentation/queries-cli/exports.js');
const { moduleMap, roles } = await import('../../src/presentation/queries-cli/overview.js');

// ── Helpers ────────────────────────────────────────────────────────
let lines;

beforeEach(() => {
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function output() {
  return lines.join('\n');
}

// ── inspect.js: where ──────────────────────────────────────────────

describe('where', () => {
  it('prints symbol results with file and line', () => {
    mocks.whereData.mockReturnValue({
      mode: 'symbol',
      results: [
        {
          name: 'foo',
          kind: 'function',
          role: 'core',
          file: 'a.js',
          line: 10,
          exported: true,
          uses: [{ file: 'b.js', line: 5 }],
        },
      ],
    });
    where('foo', '/db');
    const out = output();
    expect(out).toContain('foo');
    expect(out).toContain('a.js:10');
    expect(out).toContain('(exported)');
    expect(out).toContain('[core]');
    expect(out).toContain('b.js:5');
  });

  it('prints file results with symbols and imports', () => {
    mocks.whereData.mockReturnValue({
      mode: 'file',
      results: [
        {
          file: 'utils.js',
          symbols: [{ name: 'add', line: 1 }],
          imports: ['math.js'],
          importedBy: ['index.js'],
          exported: ['add'],
        },
      ],
    });
    where('utils.js', '/db');
    const out = output();
    expect(out).toContain('# utils.js');
    expect(out).toContain('add:1');
    expect(out).toContain('Imports: math.js');
    expect(out).toContain('Imported by: index.js');
    expect(out).toContain('Exported: add');
  });

  it('prints message when no results', () => {
    mocks.whereData.mockReturnValue({ mode: 'symbol', results: [] });
    where('ghost', '/db');
    expect(output()).toContain('No symbol matching "ghost"');
  });

  it('shows "No uses found" when symbol has no uses', () => {
    mocks.whereData.mockReturnValue({
      mode: 'symbol',
      results: [
        {
          name: 'lonely',
          kind: 'function',
          role: null,
          file: 'a.js',
          line: 1,
          exported: false,
          uses: [],
        },
      ],
    });
    where('lonely', '/db');
    expect(output()).toContain('No uses found');
  });
});

// ── inspect.js: queryName ──────────────────────────────────────────

describe('queryName', () => {
  it('prints callees and callers', () => {
    mocks.queryNameData.mockReturnValue({
      results: [
        {
          name: 'build',
          kind: 'function',
          file: 'b.js',
          line: 5,
          callees: [{ name: 'parse', edgeKind: 'calls', file: 'p.js', line: 1 }],
          callers: [{ name: 'main', edgeKind: 'calls', file: 'm.js', line: 10 }],
        },
      ],
    });
    queryName('build', '/db', {});
    const out = output();
    expect(out).toContain('build');
    expect(out).toContain('calls/uses');
    expect(out).toContain('parse');
    expect(out).toContain('called by');
    expect(out).toContain('main');
  });

  it('prints "No results" when empty', () => {
    mocks.queryNameData.mockReturnValue({ results: [] });
    queryName('ghost', '/db', {});
    expect(output()).toContain('No results for "ghost"');
  });

  it('truncates at 15 callees with "more" message', () => {
    const callees = Array.from({ length: 20 }, (_, i) => ({
      name: `fn${i}`,
      edgeKind: 'calls',
      file: 'x.js',
      line: i,
    }));
    mocks.queryNameData.mockReturnValue({
      results: [{ name: 'hub', kind: 'function', file: 'h.js', line: 1, callees, callers: [] }],
    });
    queryName('hub', '/db', {});
    const out = output();
    expect(out).toContain('and 5 more');
  });
});

// ── inspect.js: context ────────────────────────────────────────────

describe('context', () => {
  it('renders full context with sections', () => {
    mocks.contextData.mockReturnValue({
      results: [
        {
          name: 'parse',
          kind: 'function',
          role: 'core',
          file: 'p.js',
          line: 1,
          endLine: 20,
          signature: { params: 'src: string', returnType: 'AST' },
          children: [{ kind: 'parameter', name: 'src', line: 2 }],
          complexity: { cognitive: 5, cyclomatic: 3, maxNesting: 2, maintainabilityIndex: 80 },
          source: 'function parse(src) {\n  return ast(src);\n}',
          callees: [{ kind: 'function', name: 'ast', file: 'a.js', line: 1, summary: 'parse AST' }],
          callers: [{ kind: 'function', name: 'main', file: 'm.js', line: 10 }],
          implementors: [],
          implements: [],
          relatedTests: [
            { file: 'test/p.test.js', testCount: 3, testNames: ['parses JS'], source: null },
          ],
        },
      ],
    });
    context('parse', '/db', {});
    const out = output();
    expect(out).toContain('# parse (function)');
    expect(out).toContain('[core]');
    expect(out).toContain('p.js:1-20');
    expect(out).toContain('Parameters: (src: string)');
    expect(out).toContain('Returns: AST');
    expect(out).toContain('Children (1)');
    expect(out).toContain('Cognitive: 5');
    expect(out).toContain('MI: 80');
    expect(out).toContain('## Source');
    expect(out).toContain('Direct Dependencies (1)');
    expect(out).toContain('parse AST');
    expect(out).toContain('Callers (1)');
    expect(out).toContain('Related Tests');
    expect(out).toContain('3 tests');
  });

  it('prints message for no matches', () => {
    mocks.contextData.mockReturnValue({ results: [] });
    context('ghost', '/db', {});
    expect(output()).toContain('No function/method/class matching "ghost"');
  });
});

// ── inspect.js: children ───────────────────────────────────────────

describe('children', () => {
  it('renders children list', () => {
    mocks.childrenData.mockReturnValue({
      results: [
        {
          name: 'Config',
          kind: 'class',
          file: 'c.js',
          line: 1,
          children: [
            { kind: 'method', name: 'load', line: 5 },
            { kind: 'property', name: 'path', line: 2 },
          ],
        },
      ],
    });
    children('Config', '/db', {});
    const out = output();
    expect(out).toContain('Config');
    expect(out).toContain('load');
    expect(out).toContain('path');
  });

  it('shows "(no children)" for empty list', () => {
    mocks.childrenData.mockReturnValue({
      results: [{ name: 'Leaf', kind: 'function', file: 'l.js', line: 1, children: [] }],
    });
    children('Leaf', '/db', {});
    expect(output()).toContain('(no children)');
  });
});

// ── inspect.js: explain ────────────────────────────────────────────

describe('explain', () => {
  it('renders file explanation', () => {
    mocks.explainData.mockReturnValue({
      kind: 'file',
      results: [
        {
          file: 'utils.js',
          lineCount: 50,
          symbolCount: 3,
          publicApi: [
            {
              kind: 'function',
              name: 'add',
              line: 1,
              signature: { params: 'a, b' },
              role: 'utility',
              summary: 'adds numbers',
            },
          ],
          internal: [
            {
              kind: 'function',
              name: 'helper',
              line: 30,
              signature: null,
              role: null,
              summary: null,
            },
          ],
          imports: [{ file: 'math.js' }],
          importedBy: [{ file: 'index.js' }],
          dataFlow: [{ caller: 'add', callees: ['helper'] }],
        },
      ],
    });
    explain('utils.js', '/db', {});
    const out = output();
    expect(out).toContain('# utils.js');
    expect(out).toContain('50 lines');
    expect(out).toContain('1 exported');
    expect(out).toContain('1 internal');
    expect(out).toContain('Imports: math.js');
    expect(out).toContain('Imported by: index.js');
    expect(out).toContain('## Exported');
    expect(out).toContain('add');
    expect(out).toContain('adds numbers');
    expect(out).toContain('## Internal');
    expect(out).toContain('helper');
    expect(out).toContain('## Data Flow');
  });

  it('renders function explanation with depth-based headings', () => {
    mocks.explainData.mockReturnValue({
      kind: 'function',
      results: [
        {
          name: 'main',
          kind: 'function',
          role: null,
          file: 'm.js',
          line: 1,
          endLine: 10,
          lineCount: 10,
          summary: 'entry point',
          _depth: 0,
          signature: { params: '', returnType: 'void' },
          complexity: { cognitive: 2, cyclomatic: 1, maxNesting: 0 },
          callees: [{ kind: 'function', name: 'run', file: 'r.js', line: 1 }],
          callers: [],
          relatedTests: [],
          depDetails: [],
        },
      ],
    });
    explain('main', '/db', {});
    const out = output();
    expect(out).toContain('# main (function)');
    expect(out).toContain('entry point');
    expect(out).toContain('Calls (1)');
    expect(out).toContain('run');
  });

  it('prints "no function/symbol" when empty', () => {
    mocks.explainData.mockReturnValue({ kind: 'function', results: [] });
    explain('ghost', '/db', {});
    expect(output()).toContain('No function/symbol matching "ghost"');
  });
});

// ── inspect.js: implementations & interfaces ───────────────────────

describe('implementations', () => {
  it('lists implementors', () => {
    mocks.implementationsData.mockReturnValue({
      results: [
        {
          name: 'Parser',
          kind: 'interface',
          file: 'p.ts',
          line: 1,
          implementors: [{ kind: 'class', name: 'JSParser', file: 'js.ts', line: 5 }],
        },
      ],
    });
    implementations('Parser', '/db', {});
    const out = output();
    expect(out).toContain('Parser');
    expect(out).toContain('Implementors (1)');
    expect(out).toContain('JSParser');
  });

  it('shows "(no implementors)" for empty list', () => {
    mocks.implementationsData.mockReturnValue({
      results: [{ name: 'Orphan', kind: 'interface', file: 'o.ts', line: 1, implementors: [] }],
    });
    implementations('Orphan', '/db', {});
    expect(output()).toContain('(no implementors found)');
  });
});

describe('interfaces', () => {
  it('lists interfaces', () => {
    mocks.interfacesData.mockReturnValue({
      results: [
        {
          name: 'JSParser',
          kind: 'class',
          file: 'js.ts',
          line: 5,
          interfaces: [{ kind: 'interface', name: 'Parser', file: 'p.ts', line: 1 }],
        },
      ],
    });
    interfaces('JSParser', '/db', {});
    const out = output();
    expect(out).toContain('JSParser');
    expect(out).toContain('Implements (1)');
    expect(out).toContain('Parser');
  });
});

// ── path.js: symbolPath ────────────────────────────────────────────

describe('symbolPath', () => {
  it('prints path steps with edge kinds', () => {
    mocks.pathData.mockReturnValue({
      found: true,
      hops: 2,
      path: [
        { name: 'a', kind: 'function', file: 'a.js', line: 1, edgeKind: null },
        { name: 'b', kind: 'function', file: 'b.js', line: 5, edgeKind: 'calls' },
        { name: 'c', kind: 'function', file: 'c.js', line: 10, edgeKind: 'calls' },
      ],
      alternateCount: 1,
    });
    symbolPath('a', 'c', '/db');
    const out = output();
    expect(out).toContain('Path from a to c');
    expect(out).toContain('2 hops');
    expect(out).toContain('--[calls]-->');
    expect(out).toContain('1 alternate shortest path');
  });

  it('handles same-symbol (0 hops)', () => {
    mocks.pathData.mockReturnValue({
      found: true,
      hops: 0,
      path: [{ name: 'x', kind: 'function', file: 'x.js', line: 1, edgeKind: null }],
      alternateCount: 0,
    });
    symbolPath('x', 'x', '/db');
    expect(output()).toContain('same symbol (0 hops)');
  });

  it('handles not-found with candidate disambiguation', () => {
    mocks.pathData.mockReturnValue({
      found: false,
      maxDepth: 5,
      reverse: false,
      fromCandidates: [
        { name: 'run', file: 'a.js', line: 1 },
        { name: 'run', file: 'b.js', line: 5 },
      ],
      toCandidates: [{ name: 'stop', file: 'c.js', line: 1 }],
    });
    symbolPath('run', 'stop', '/db');
    const out = output();
    expect(out).toContain('No path from "run" to "stop"');
    expect(out).toContain('matched 2 symbols');
  });

  it('prints error when present', () => {
    mocks.pathData.mockReturnValue({ error: 'Symbol not found' });
    symbolPath('x', 'y', '/db');
    expect(output()).toContain('Symbol not found');
    // ensure we stopped after the error — no path-rendering output
    expect(output()).not.toContain('Path from');
  });
});

// ── exports.js: fileExports ────────────────────────────────────────

describe('fileExports', () => {
  it('renders export list with consumers', () => {
    mocks.exportsData.mockReturnValue({
      file: 'math.js',
      totalExported: 2,
      totalInternal: 1,
      totalUnused: 0,
      results: [
        {
          name: 'add',
          kind: 'function',
          line: 1,
          role: 'utility',
          signature: { params: 'a, b' },
          consumers: [{ name: 'main', file: 'index.js', line: 5 }],
        },
        {
          name: 'subtract',
          kind: 'function',
          line: 10,
          role: null,
          signature: null,
          consumers: [],
        },
      ],
      reexportedSymbols: [],
      reexports: [],
    });
    fileExports('math.js', '/db');
    const out = output();
    expect(out).toContain('math.js');
    expect(out).toContain('2 exported');
    expect(out).toContain('1 internal');
    expect(out).toContain('add(a, b)');
    expect(out).toContain('[utility]');
    expect(out).toContain('main (index.js:5)');
    expect(out).toContain('subtract');
    expect(out).toContain('(no consumers)');
  });

  it('renders barrel file header when no direct exports', () => {
    mocks.exportsData.mockReturnValue({
      file: 'index.js',
      totalExported: 0,
      totalInternal: 0,
      totalUnused: 0,
      results: [],
      reexportedSymbols: [
        {
          name: 'add',
          kind: 'function',
          line: 1,
          role: null,
          signature: null,
          originFile: 'math.js',
          consumers: [],
        },
      ],
      reexports: [],
    });
    fileExports('index.js', '/db');
    const out = output();
    expect(out).toContain('barrel file');
    expect(out).toContain('from math.js');
  });

  it('prints message when no exports found', () => {
    mocks.exportsData.mockReturnValue({
      file: 'empty.js',
      totalExported: 0,
      totalInternal: 0,
      totalUnused: 0,
      results: [],
      reexportedSymbols: [],
      reexports: [],
    });
    fileExports('empty.js', '/db');
    expect(output()).toContain('No exported symbols found');
  });

  it('prints unused header when opts.unused', () => {
    mocks.exportsData.mockReturnValue({
      file: 'lib.js',
      totalExported: 3,
      totalInternal: 0,
      totalUnused: 1,
      results: [
        { name: 'dead', kind: 'function', line: 5, role: 'dead', signature: null, consumers: [] },
      ],
      reexportedSymbols: [],
      reexports: [],
    });
    fileExports('lib.js', '/db', { unused: true });
    const out = output();
    expect(out).toContain('1 unused export');
    expect(out).toContain('of 3 exported');
  });
});

// ── overview.js: moduleMap ─────────────────────────────────────────

describe('moduleMap', () => {
  it('renders grouped directory output with coupling bars', () => {
    mocks.moduleMapData.mockReturnValue({
      topNodes: [
        { file: 'src/parser.js', dir: 'src', inEdges: 10, outEdges: 5 },
        { file: 'src/builder.js', dir: 'src', inEdges: 3, outEdges: 8 },
        { file: 'lib/utils.js', dir: 'lib', inEdges: 2, outEdges: 1 },
      ],
      stats: { totalFiles: 20, totalNodes: 100, totalEdges: 200 },
    });
    moduleMap('/db', 20, {});
    const out = output();
    expect(out).toContain('[src/]');
    expect(out).toContain('[lib/]');
    expect(out).toContain('parser.js');
    expect(out).toContain('<- 10');
    expect(out).toContain('->  5');
    expect(out).toContain('#'); // coupling bar
    expect(out).toContain('Total: 20 files');
  });
});

// ── overview.js: roles ─────────────────────────────────────────────

describe('roles', () => {
  it('renders role groups with truncation at 30', () => {
    const symbols = Array.from({ length: 35 }, (_, i) => ({
      role: 'core',
      kind: 'function',
      name: `fn${i}`,
      file: 'a.js',
      line: i + 1,
    }));
    mocks.rolesData.mockReturnValue({
      count: 35,
      summary: { core: 35 },
      symbols,
    });
    roles('/db', {});
    const out = output();
    expect(out).toContain('Node roles (35 symbols)');
    expect(out).toContain('## core (35)');
    expect(out).toContain('fn0');
    expect(out).toContain('fn29');
    expect(out).toContain('and 5 more');
    expect(out).not.toContain('fn30');
  });

  it('prints message when no symbols classified', () => {
    mocks.rolesData.mockReturnValue({ count: 0, summary: {}, symbols: [] });
    roles('/db', {});
    expect(output()).toContain('No classified symbols found');
  });
});
