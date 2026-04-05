import { describe, expect, it } from 'vitest';
import { classifyRoles } from '../../../src/graph/classifiers/roles.js';

describe('classifyRoles', () => {
  it('returns empty map for empty input', () => {
    expect(classifyRoles([]).size).toBe(0);
  });

  it('classifies entry nodes (no fan-in, exported)', () => {
    const nodes = [{ id: '1', name: 'init', fanIn: 0, fanOut: 3, isExported: true }];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('entry');
  });

  it('classifies framework entry via prefix', () => {
    const nodes = [{ id: '1', name: 'route:/api/users', fanIn: 5, fanOut: 5, isExported: false }];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('entry');
  });

  it('classifies core (high fan-in, low fan-out)', () => {
    const nodes = [
      { id: '1', name: 'coreLib', fanIn: 10, fanOut: 0, isExported: true },
      { id: '2', name: 'caller', fanIn: 0, fanOut: 10, isExported: true },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('core');
  });

  it('classifies utility (high fan-in AND high fan-out)', () => {
    const nodes = [
      { id: '1', name: 'hub', fanIn: 10, fanOut: 10, isExported: true },
      { id: '2', name: 'other', fanIn: 1, fanOut: 1, isExported: true },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('utility');
  });

  it('classifies adapter (low fan-in, high fan-out)', () => {
    const nodes = [
      { id: '1', name: 'adapter', fanIn: 1, fanOut: 10, isExported: true },
      { id: '2', name: 'dep', fanIn: 10, fanOut: 0, isExported: true },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('adapter');
  });

  it('classifies leaf (low everything)', () => {
    const nodes = [
      { id: '1', name: 'leaf', fanIn: 1, fanOut: 0, isExported: false },
      { id: '2', name: 'hub', fanIn: 10, fanOut: 10, isExported: true },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('leaf');
  });

  it('classifies test-only when fanIn is 0 but testOnlyFanIn > 0', () => {
    const nodes = [
      { id: '1', name: 'helperForTests', fanIn: 0, fanOut: 0, isExported: false, testOnlyFanIn: 3 },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('test-only');
  });

  it('ignores testOnlyFanIn when fanIn > 0', () => {
    const nodes = [
      { id: '1', name: 'normalLeaf', fanIn: 1, fanOut: 0, isExported: false, testOnlyFanIn: 2 },
      { id: '2', name: 'hub', fanIn: 10, fanOut: 10, isExported: true },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('leaf');
  });

  // ── Dead sub-category tests ───────────────────────────────────────

  it('classifies dead-unresolved for genuinely unreferenced callables', () => {
    const nodes = [
      {
        id: '1',
        name: 'unused',
        kind: 'function',
        file: 'src/lib.js',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead-unresolved');
  });

  it('classifies dead-leaf for parameters', () => {
    const nodes = [
      {
        id: '1',
        name: 'opts',
        kind: 'parameter',
        file: 'src/lib.js',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead-leaf');
  });

  it('classifies dead-leaf for properties', () => {
    const nodes = [
      {
        id: '1',
        name: 'config.timeout',
        kind: 'property',
        file: 'src/lib.js',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead-leaf');
  });

  it('classifies dead-leaf for constants without active siblings', () => {
    const nodes = [
      {
        id: '1',
        name: 'MAX_RETRIES',
        kind: 'constant',
        file: 'src/lib.js',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead-leaf');
  });

  it('classifies constant as leaf when same file has active callables', () => {
    const nodes = [
      {
        id: '1',
        name: 'DEFAULT_WEIGHTS',
        kind: 'constant',
        file: 'src/risk.ts',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
        hasActiveFileSiblings: true,
      },
      {
        id: '2',
        name: 'scoreRisk',
        kind: 'function',
        file: 'src/risk.ts',
        fanIn: 3,
        fanOut: 2,
        isExported: true,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('leaf');
  });

  it('classifies dead-ffi for Rust files', () => {
    const nodes = [
      {
        id: '1',
        name: 'parse_file',
        kind: 'function',
        file: 'crates/core/src/parser.rs',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead-ffi');
  });

  it('classifies dead-ffi for C files', () => {
    const nodes = [
      {
        id: '1',
        name: 'init_module',
        kind: 'function',
        file: 'native/binding.c',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead-ffi');
  });

  it('classifies dead-ffi for Go files', () => {
    const nodes = [
      {
        id: '1',
        name: 'BuildGraph',
        kind: 'function',
        file: 'pkg/graph.go',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead-ffi');
  });

  it('classifies dead-entry for CLI command files', () => {
    const nodes = [
      {
        id: '1',
        name: 'execute',
        kind: 'function',
        file: 'src/cli/commands/build.js',
        fanIn: 0,
        fanOut: 3,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead-entry');
  });

  it('classifies dead-entry for MCP handler files', () => {
    const nodes = [
      {
        id: '1',
        name: 'handleQuery',
        kind: 'function',
        file: 'src/mcp/handlers.js',
        fanIn: 0,
        fanOut: 2,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead-entry');
  });

  it('classifies dead-entry for route files', () => {
    const nodes = [
      {
        id: '1',
        name: 'getUsers',
        kind: 'function',
        file: 'src/routes/users.js',
        fanIn: 0,
        fanOut: 1,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead-entry');
  });

  it('dead-leaf takes priority over dead-ffi (parameter in .rs file)', () => {
    const nodes = [
      {
        id: '1',
        name: 'ctx',
        kind: 'parameter',
        file: 'crates/core/src/lib.rs',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead-leaf');
  });

  it('dead-leaf takes priority over dead-entry (constant in CLI command)', () => {
    const nodes = [
      {
        id: '1',
        name: 'MAX',
        kind: 'constant',
        file: 'src/cli/commands/build.js',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead-leaf');
  });

  it('classifies constant as leaf when sibling is a pure-sink function (fan_in > 0, fan_out === 0)', () => {
    const nodes = [
      {
        id: '1',
        name: 'MAX_LENGTH',
        kind: 'constant',
        file: 'src/validators.ts',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
        hasActiveFileSiblings: true,
      },
      {
        id: '2',
        name: 'validate',
        kind: 'function',
        file: 'src/validators.ts',
        fanIn: 10,
        fanOut: 0,
        isExported: true,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('leaf');
  });

  it('classifies constant as leaf even in CLI command file when active siblings exist', () => {
    const nodes = [
      {
        id: '1',
        name: 'MAX',
        kind: 'constant',
        file: 'src/cli/commands/build.js',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
        hasActiveFileSiblings: true,
      },
      {
        id: '2',
        name: 'execute',
        kind: 'function',
        file: 'src/cli/commands/build.js',
        fanIn: 0,
        fanOut: 3,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('leaf');
  });

  it('falls back to dead-unresolved when no kind/file info', () => {
    const nodes = [{ id: '1', name: 'mystery', fanIn: 0, fanOut: 0, isExported: false }];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead-unresolved');
  });

  it('classifies dead-unresolved when fanIn is 0 and testOnlyFanIn is 0', () => {
    const nodes = [
      {
        id: '1',
        name: 'reallyDead',
        kind: 'function',
        file: 'src/lib.js',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
        testOnlyFanIn: 0,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead-unresolved');
  });
});
