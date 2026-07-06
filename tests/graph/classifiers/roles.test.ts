import { describe, expect, it } from 'vitest';
import { classifyRoles } from '../../../src/graph/classifiers/roles.js';

describe('classifyRoles', () => {
  it('returns empty map for empty input', () => {
    expect(classifyRoles([]).size).toBe(0);
  });

  it('classifies entry nodes (no fan-in, exported, function kind)', () => {
    const nodes = [
      { id: '1', name: 'init', kind: 'function', fanIn: 0, fanOut: 3, isExported: true },
    ];
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

  it('classifies execute/validate as entry (not dead-entry) in CLI command files (#1585)', () => {
    // Commander.js dispatch methods (execute, validate) in cli/commands/ are
    // confirmed entry points — promoted directly to `entry` so they don't
    // appear in `--role dead` output.
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
    expect(roles.get('1')).toBe('entry');
  });

  it('classifies non-Commander functions as dead-entry in CLI command files', () => {
    // Functions other than execute/validate in cli/commands/ are still dead-entry.
    const nodes = [
      {
        id: '1',
        name: 'handleQuery',
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

  // ── Pattern 2: interface dispatch via conditional property access ──────────

  it('classifies method as leaf when same file has active callables (pattern 2: interface dispatch)', () => {
    // Simulates enterFunction/exitFunction/etc. in cfg-visitor.ts — methods implementing
    // the Visitor interface, dispatched via `if (v.enterFunction) v.enterFunction(...)`.
    // The method itself has fanIn === 0 because codegraph resolves the call to the
    // property accessor, not to the concrete method implementation.
    const nodes = [
      {
        id: '1',
        name: 'enterFunction',
        kind: 'method',
        file: 'src/ast-analysis/visitors/cfg-visitor.ts',
        fanIn: 0,
        fanOut: 3,
        isExported: false,
        hasActiveFileSiblings: true,
      },
      {
        id: '2',
        name: 'createCfgVisitor',
        kind: 'function',
        file: 'src/ast-analysis/visitors/cfg-visitor.ts',
        fanIn: 5,
        fanOut: 2,
        isExported: true,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('leaf');
    // The factory function is properly connected
    expect(roles.get('2')).toBe('core');
  });

  it('classifies method as dead-unresolved when no active file siblings (pattern 2: no siblings)', () => {
    // A method in an isolated file (no connected callables) remains dead-unresolved.
    const nodes = [
      {
        id: '1',
        name: 'extractParamName',
        kind: 'method',
        file: 'src/ast-analysis/rules/csharp.ts',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
        hasActiveFileSiblings: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead-unresolved');
  });

  it('classifies method as dead-unresolved when fanOut === 0 even with active file siblings (pattern 2: inert)', () => {
    // A method with no callers and no outgoing calls in a busy file is a genuinely dead
    // helper — the fanOut > 0 guard keeps it visible in --role dead output.
    const nodes = [
      {
        id: '1',
        name: 'unusedHelper',
        kind: 'method',
        file: 'src/graph/classifiers/roles.ts',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
        hasActiveFileSiblings: true,
      },
      {
        id: '2',
        name: 'classifyUnreferencedNode',
        kind: 'function',
        file: 'src/graph/classifiers/roles.ts',
        fanIn: 5,
        fanOut: 3,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead-unresolved');
  });

  // ── Pattern 3: logical-or fallback defaults ────────────────────────────────

  it('classifies function as leaf when used as logical-or default and file has active callables (pattern 3)', () => {
    // Simulates fetchLatestVersion in update-check.ts:
    //   `const fetchFn = options._fetchLatest || fetchLatestVersion`
    // The function is referenced as a value, not called directly, so no call edge is produced.
    // fanOut > 0 indicates the function is non-trivial (it calls something internally).
    const nodes = [
      {
        id: '1',
        name: 'fetchLatestVersion',
        kind: 'function',
        file: 'src/infrastructure/update-check.ts',
        fanIn: 0,
        fanOut: 1, // fetchLatestVersion calls https.get internally
        isExported: false,
        hasActiveFileSiblings: true,
      },
      {
        id: '2',
        name: 'checkForUpdates',
        kind: 'function',
        file: 'src/infrastructure/update-check.ts',
        fanIn: 3,
        fanOut: 4,
        isExported: true,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('leaf');
  });

  it('classifies function as dead-unresolved when isolated (no active siblings)', () => {
    // A function in a file with no connected callables remains dead-unresolved.
    const nodes = [
      {
        id: '1',
        name: 'trulySilent',
        kind: 'function',
        file: 'src/lib.js',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
        hasActiveFileSiblings: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('dead-unresolved');
  });

  // ── Interface/type member exemption (#1723) ─────────────────────────

  it('classifies interface method-signature member as leaf, not dead', () => {
    // TS `interface Foo { bar(): void }` extracts `bar` as a top-level
    // `method`-kind definition named `Foo.bar`. It can never gain an inbound
    // call edge (nothing "calls" a type-level declaration), so fanIn === 0
    // carries zero dead-code signal here — unlike a real function/method.
    const nodes = [
      {
        id: '1',
        name: 'Foo',
        kind: 'interface',
        file: 'src/a.ts',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
      },
      {
        id: '2',
        name: 'Foo.bar',
        kind: 'method',
        file: 'src/a.ts',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('2')).toBe('leaf');
  });

  it('classifies type-alias property-signature member as leaf, not dead', () => {
    // TS `type Foo = { bar: string }` — a property-kind member of a `type` owner.
    const nodes = [
      {
        id: '1',
        name: 'Foo',
        kind: 'type',
        file: 'src/a.ts',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
      },
      {
        id: '2',
        name: 'Foo.bar',
        kind: 'property',
        file: 'src/a.ts',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('2')).toBe('leaf');
  });

  it('classifies interface member as leaf even when the interface is isolated (no active siblings)', () => {
    // Unlike bare TYPE_DEF_KINDS nodes (which need hasActiveFileSiblings to
    // avoid being marked dead), members are exempt unconditionally — "no call
    // edges" is a structural certainty for them, not merely a likelihood.
    const nodes = [
      {
        id: '1',
        name: 'Isolated',
        kind: 'interface',
        file: 'src/isolated.ts',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
      },
      {
        id: '2',
        name: 'Isolated.onlyMember',
        kind: 'method',
        file: 'src/isolated.ts',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('2')).toBe('leaf');
  });

  it('does not exempt class methods sharing the Owner.member naming convention', () => {
    // Class methods are qualified identically to interface members
    // (`ClassName.method`), but `class` is not in TYPE_DEF_KINDS — they must
    // remain subject to normal dead-code detection.
    const nodes = [
      {
        id: '1',
        name: 'Foo',
        kind: 'class',
        file: 'src/a.ts',
        fanIn: 5,
        fanOut: 0,
        isExported: true,
      },
      {
        id: '2',
        name: 'Foo.deadMethod',
        kind: 'method',
        file: 'src/a.ts',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('2')).toBe('dead-unresolved');
  });

  // ── entry role requires function/method kind (#1780) ───────────────

  it('classifies an exported interface with zero fan-in as leaf, not entry', () => {
    // Mirrors the #1780 repro: `interface ParsedUserConfig { ... }` in
    // src/infrastructure/config.ts. Even if the symbol were exported, an
    // interface is a data-shape declaration, never a callable entry point.
    const nodes = [
      {
        id: '1',
        name: 'ParsedUserConfig',
        kind: 'interface',
        file: 'src/infrastructure/config.ts',
        fanIn: 0,
        fanOut: 0,
        isExported: true,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('leaf');
  });

  it('classifies an exported constant with zero fan-in as leaf, not entry', () => {
    // Mirrors the #1780 repro: module-level `const BUILD_HASH_KEYS = [...]`.
    // A constant can never be an invoked entry point regardless of export status.
    const nodes = [
      {
        id: '1',
        name: 'BUILD_HASH_KEYS',
        kind: 'constant',
        file: 'src/infrastructure/config.ts',
        fanIn: 0,
        fanOut: 0,
        isExported: true,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('leaf');
  });

  it('classifies an exported class with zero fan-in as leaf, not entry', () => {
    // A class declaration itself is instantiated via `new`, not "invoked" the
    // way a CLI command handler or API function is — not a real entry point.
    const nodes = [
      {
        id: '1',
        name: 'Widget',
        kind: 'class',
        file: 'src/widget.ts',
        fanIn: 0,
        fanOut: 0,
        isExported: true,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('leaf');
  });

  it('classifies an exported type alias with zero fan-in as leaf, not entry', () => {
    const nodes = [
      {
        id: '1',
        name: 'WorkspaceEntry',
        kind: 'type',
        file: 'src/infrastructure/config.ts',
        fanIn: 0,
        fanOut: 0,
        isExported: true,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('leaf');
  });

  it('still classifies an exported function with zero fan-in as entry (no over-correction)', () => {
    // Genuine entry points (CLI handlers, MCP tool handlers, ESM loader hooks)
    // are, by definition, called from outside the codebase, so zero in-repo
    // fan-in is expected and correct for them — the fix must not lose this.
    const nodes = [
      {
        id: '1',
        name: 'handler',
        kind: 'function',
        file: 'src/mcp/tools/audit.ts',
        fanIn: 0,
        fanOut: 4,
        isExported: true,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('entry');
  });

  it('still classifies an exported method with zero fan-in as entry (no over-correction)', () => {
    const nodes = [
      {
        id: '1',
        name: 'run',
        kind: 'method',
        file: 'src/cli/commands/custom.ts',
        fanIn: 0,
        fanOut: 2,
        isExported: true,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('entry');
  });

  it('classifies a non-exported interface with zero fan-in the same as an exported one (leaf, active siblings)', () => {
    // Whether or not the interface itself is exported, it's still not a
    // callable entry point — both must land on the same non-entry path.
    const nodes = [
      {
        id: '1',
        name: 'ConsentResolutionResult',
        kind: 'interface',
        file: 'src/infrastructure/config.ts',
        fanIn: 0,
        fanOut: 0,
        isExported: false,
        hasActiveFileSiblings: true,
      },
      {
        id: '2',
        name: 'loadConfig',
        kind: 'function',
        file: 'src/infrastructure/config.ts',
        fanIn: 5,
        fanOut: 3,
        isExported: true,
      },
    ];
    const roles = classifyRoles(nodes);
    expect(roles.get('1')).toBe('leaf');
  });
});
