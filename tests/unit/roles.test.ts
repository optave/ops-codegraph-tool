/**
 * Unit tests for classifyNodeRoles in src/structure.js
 *
 * Uses an in-memory SQLite database with hand-crafted nodes/edges
 * to verify each role classification.
 *
 * Test graph:
 *   entryFn    - exported (cross-file caller), fan_in=0 from non-test → entry
 *   coreFn     - high fan_in, low fan_out → core
 *   utilityFn  - high fan_in, high fan_out → utility
 *   adapterFn  - low fan_in, high fan_out → adapter
 *   deadFn     - fan_in=0, not exported → dead-unresolved
 *   leafFn     - low fan_in, low fan_out → leaf
 */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { classifyNodeRoles } from '../../src/features/structure.js';

let db: any;

function setup() {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

function insertNode(name, kind, file, line) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid;
}

function insertEdge(sourceId, targetId, kind) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, 1.0, 0)',
  ).run(sourceId, targetId, kind);
}

/**
 * Build a graph where median fan_in = 2 and median fan_out = 2.
 * This allows clear high/low classification.
 */
function buildTestGraph() {
  // File nodes (these should NOT get roles)
  const fA = insertNode('a.js', 'file', 'a.js', 0);
  const fB = insertNode('b.js', 'file', 'b.js', 0);

  // Function nodes
  const entryFn = insertNode('entryFn', 'function', 'a.js', 1);
  const coreFn = insertNode('coreFn', 'function', 'a.js', 10);
  const utilityFn = insertNode('utilityFn', 'function', 'a.js', 20);
  const adapterFn = insertNode('adapterFn', 'function', 'b.js', 1);
  const deadFn = insertNode('deadFn', 'function', 'b.js', 10);
  const leafFn = insertNode('leafFn', 'function', 'b.js', 20);

  // Helper targets for fan_out edges
  const helperA = insertNode('helperA', 'function', 'a.js', 30);
  const helperB = insertNode('helperB', 'function', 'a.js', 40);
  const helperC = insertNode('helperC', 'function', 'b.js', 30);
  const helperD = insertNode('helperD', 'function', 'b.js', 40);

  // entryFn: fan_in=0, but exported (cross-file caller) → entry
  // No callers from same file, but one cross-file caller
  const crossCaller = insertNode('crossCaller', 'function', 'b.js', 50);
  insertEdge(crossCaller, entryFn, 'calls');

  // coreFn: high fan_in (3 callers), low fan_out (0) → core
  insertEdge(entryFn, coreFn, 'calls');
  insertEdge(adapterFn, coreFn, 'calls');
  insertEdge(leafFn, coreFn, 'calls');

  // utilityFn: high fan_in (3 callers), high fan_out (3 callees) → utility
  insertEdge(entryFn, utilityFn, 'calls');
  insertEdge(adapterFn, utilityFn, 'calls');
  insertEdge(crossCaller, utilityFn, 'calls');
  insertEdge(utilityFn, helperA, 'calls');
  insertEdge(utilityFn, helperB, 'calls');
  insertEdge(utilityFn, helperC, 'calls');

  // adapterFn: low fan_in (1 caller), high fan_out (3 callees) → adapter
  insertEdge(entryFn, adapterFn, 'calls');
  // adapterFn already calls coreFn and utilityFn above
  insertEdge(adapterFn, helperD, 'calls');

  // deadFn: fan_in=0, not exported → dead
  // No callers at all

  // leafFn: low fan_in (1 caller), low fan_out (1 callee) → leaf
  insertEdge(crossCaller, leafFn, 'calls');
  // leafFn already calls coreFn above

  return { fA, fB, entryFn, coreFn, utilityFn, adapterFn, deadFn, leafFn };
}

describe('classifyNodeRoles', () => {
  beforeEach(() => {
    setup();
  });

  it('classifies each role correctly', () => {
    buildTestGraph();
    const summary = classifyNodeRoles(db);

    // Verify summary has all roles
    expect(summary).toHaveProperty('entry');
    expect(summary).toHaveProperty('core');
    expect(summary).toHaveProperty('utility');
    expect(summary).toHaveProperty('adapter');
    expect(summary).toHaveProperty('dead');
    expect(summary).toHaveProperty('leaf');

    // Verify specific node roles
    const getRole = (name) => db.prepare('SELECT role FROM nodes WHERE name = ?').get(name)?.role;

    expect(getRole('deadFn')).toBe('dead-unresolved');
    expect(getRole('coreFn')).toBe('core');
    expect(getRole('utilityFn')).toBe('utility');
  });

  it('marks file and directory nodes as NULL role', () => {
    buildTestGraph();
    // Insert a directory node
    insertNode('src', 'directory', 'src', 0);
    classifyNodeRoles(db);

    const fileRole = db.prepare("SELECT role FROM nodes WHERE kind = 'file' LIMIT 1").get();
    expect(fileRole.role).toBeNull();

    const dirRole = db.prepare("SELECT role FROM nodes WHERE kind = 'directory' LIMIT 1").get();
    expect(dirRole.role).toBeNull();
  });

  it('is idempotent (running twice gives same results)', () => {
    buildTestGraph();
    const summary1 = classifyNodeRoles(db);
    const roles1 = db
      .prepare('SELECT name, role FROM nodes WHERE role IS NOT NULL ORDER BY name')
      .all();

    const summary2 = classifyNodeRoles(db);
    const roles2 = db
      .prepare('SELECT name, role FROM nodes WHERE role IS NOT NULL ORDER BY name')
      .all();

    expect(summary1).toEqual(summary2);
    expect(roles1).toEqual(roles2);
  });

  it('handles empty graph without crashing', () => {
    const summary = classifyNodeRoles(db);
    expect(summary).toEqual({
      entry: 0,
      core: 0,
      utility: 0,
      adapter: 0,
      dead: 0,
      'dead-leaf': 0,
      'dead-entry': 0,
      'dead-ffi': 0,
      'dead-unresolved': 0,
      'test-only': 0,
      leaf: 0,
    });
  });

  it('adapts median thresholds to data', () => {
    // Create a small graph: 2 functions with fan_in=[1,1], fan_out=[1,1]
    // median of non-zero = 1 for both, so fan_in >= 1 = high, fan_out >= 1 = high
    insertNode('a.js', 'file', 'a.js', 0);
    const fn1 = insertNode('fn1', 'function', 'a.js', 1);
    const fn2 = insertNode('fn2', 'function', 'a.js', 10);

    // fn1 calls fn2, fn2 calls fn1 (mutual)
    insertEdge(fn1, fn2, 'calls');
    insertEdge(fn2, fn1, 'calls');

    const summary = classifyNodeRoles(db);
    // Both have fan_in=1 (>= median 1) and fan_out=1 (>= median 1) → utility
    expect(summary.utility).toBe(2);
  });

  it('classifies nodes with only non-call edges as dead-unresolved', () => {
    const fA = insertNode('a.js', 'file', 'a.js', 0);
    const fn1 = insertNode('fn1', 'function', 'a.js', 1);
    // Only import edge, no call edge
    insertEdge(fA, fn1, 'imports');

    classifyNodeRoles(db);
    const role = db.prepare("SELECT role FROM nodes WHERE name = 'fn1'").get();
    expect(role.role).toBe('dead-unresolved');
  });

  it('does not classify type-imported interfaces as dead (#840)', () => {
    // Simulate: file b.ts has `import type { MyInterface } from './a'`
    // This should create a symbol-level imports-type edge from b.ts file node
    // to the MyInterface symbol, giving it fan-in > 0.
    const fA = insertNode('a.ts', 'file', 'a.ts', 0);
    const fB = insertNode('b.ts', 'file', 'b.ts', 0);
    const iface = insertNode('MyInterface', 'interface', 'a.ts', 5);

    // File-level imports-type edge (file → file)
    insertEdge(fB, fA, 'imports-type');
    // Symbol-level imports-type edge (file → symbol) — the fix creates these
    insertEdge(fB, iface, 'imports-type');

    classifyNodeRoles(db);
    const role = db.prepare("SELECT role FROM nodes WHERE name = 'MyInterface'").get();
    // Should NOT be dead — it has a type-import consumer
    expect(role.role).not.toMatch(/^dead/);
  });

  it('classifies interface with no type-import edges as dead', () => {
    insertNode('a.ts', 'file', 'a.ts', 0);
    insertNode('UnusedInterface', 'interface', 'a.ts', 5);

    classifyNodeRoles(db);
    const role = db.prepare("SELECT role FROM nodes WHERE name = 'UnusedInterface'").get();
    expect(role.role).toBe('dead-unresolved');
  });

  it('does not classify exported interface as dead when used only as same-file type annotation (#1583)', () => {
    // Simulate: exported interface whose only usage is as a parameter type in the same file.
    // No cross-file imports-type edge exists because same-file type annotations don't produce edges.
    // The extractor marks the interface as exported=1. The classifier must honour that flag.
    db.prepare('INSERT INTO nodes (name, kind, file, line, exported) VALUES (?, ?, ?, ?, ?)').run(
      'MyOpts',
      'interface',
      'src/helpers.ts',
      10,
      1,
    );

    classifyNodeRoles(db);
    const role = db.prepare("SELECT role FROM nodes WHERE name = 'MyOpts'").get();
    // Should be leaf (exported, fan-in 0), not dead-unresolved. An interface is a
    // data-shape declaration, never a callable entry point, so exported+zero-fanin
    // interfaces land on `leaf` rather than `entry` (#1780) — but #1583's original
    // guarantee (never `dead-*`) still holds.
    expect(role.role).toBe('leaf');
  });

  it('classifies exported constant with no callers as leaf, not entry (#1780)', () => {
    // A module-level constant is a data value, never a callable entry point,
    // regardless of its exported=1 flag.
    db.prepare('INSERT INTO nodes (name, kind, file, line, exported) VALUES (?, ?, ?, ?, ?)').run(
      'DEFAULT_OPTIONS',
      'constant',
      'src/helpers.ts',
      5,
      1,
    );

    classifyNodeRoles(db);
    const role = db.prepare("SELECT role FROM nodes WHERE name = 'DEFAULT_OPTIONS'").get();
    expect(role.role).toBe('leaf');
  });

  it('still classifies an exported function with no callers as entry (#1780 no over-correction)', () => {
    // A genuinely exported, callable function with zero fan-in is exactly what
    // `entry` is meant to capture — e.g. a public API function invoked only by
    // external consumers of the package. The kind-gate fix must not lose this.
    db.prepare('INSERT INTO nodes (name, kind, file, line, exported) VALUES (?, ?, ?, ?, ?)').run(
      'publicApiFn',
      'function',
      'src/helpers.ts',
      40,
      1,
    );

    classifyNodeRoles(db);
    const role = db.prepare("SELECT role FROM nodes WHERE name = 'publicApiFn'").get();
    expect(role.role).toBe('entry');
  });

  it('classifies non-exported interface with no callers as dead-unresolved (#1583 boundary)', () => {
    // An interface without export keyword and without cross-file references is genuinely dead.
    db.prepare('INSERT INTO nodes (name, kind, file, line, exported) VALUES (?, ?, ?, ?, ?)').run(
      'InternalOpts',
      'interface',
      'src/helpers.ts',
      20,
      0,
    );

    classifyNodeRoles(db);
    const role = db.prepare("SELECT role FROM nodes WHERE name = 'InternalOpts'").get();
    expect(role.role).toBe('dead-unresolved');
  });

  it('does not classify struct/enum/trait as dead when file has active callables (#1584)', () => {
    // Simulate a Rust file with struct definitions used as type parameters.
    // The structs have fan_in=0 (no call edges — type annotations don't produce edges),
    // but the file has active functions. The structs are almost certainly live.
    insertNode('build_edges.rs', 'file', 'build_edges.rs', 0);
    // An external caller that makes build_graph "active" (fan_in > 0)
    const externalCaller = insertNode('main', 'function', 'main.rs', 1);
    const fn1 = insertNode('build_graph', 'function', 'build_edges.rs', 10);
    const fn2 = insertNode('resolve_imports', 'function', 'build_edges.rs', 50);
    insertNode('NodeInfo', 'struct', 'build_edges.rs', 5);
    insertNode('CallInfo', 'struct', 'build_edges.rs', 15);
    insertNode('EdgeKind', 'enum', 'build_edges.rs', 25);
    insertNode('Resolvable', 'trait', 'build_edges.rs', 35);

    // The file has active callables: fn1 is called externally, fn1 calls fn2
    insertEdge(externalCaller, fn1, 'calls');
    insertEdge(fn1, fn2, 'calls');
    // Structs have no call edges (they are used as type annotations only)

    classifyNodeRoles(db);

    const getRole = (name) => db.prepare('SELECT role FROM nodes WHERE name = ?').get(name)?.role;

    // Functions are classified normally (they have edges)
    expect(getRole('build_graph')).not.toMatch(/^dead/);
    // Struct/enum/trait with active file siblings should be leaf, not dead
    expect(getRole('NodeInfo')).toBe('leaf');
    expect(getRole('CallInfo')).toBe('leaf');
    expect(getRole('EdgeKind')).toBe('leaf');
    expect(getRole('Resolvable')).toBe('leaf');
  });

  it('classifies struct with no active file siblings as dead (#1584 boundary)', () => {
    // A struct in a file with no other active callables is genuinely dead.
    insertNode('orphan.rs', 'file', 'orphan.rs', 0);
    insertNode('OrphanStruct', 'struct', 'orphan.rs', 5);

    classifyNodeRoles(db);
    const role = db.prepare("SELECT role FROM nodes WHERE name = 'OrphanStruct'").get();
    // No active callables in the file — the struct is dead (dead-ffi for .rs files)
    expect(role.role).toMatch(/^dead/);
  });

  it('classifies Commander.js execute/validate methods in cli/commands/ as entry (#1585)', () => {
    // Simulate the Commander.js command object pattern:
    //   export const command = { execute(args, opts, ctx) { ... }, validate(args) { ... } }
    // These methods have fan_in=0 because Commander dispatches them dynamically.
    // They must be classified as `entry`, not `dead-entry`, so they don't appear
    // in `--role dead` output and don't pollute dead-code analysis.
    insertNode('src/cli/commands/roles.ts', 'file', 'src/cli/commands/roles.ts', 0);
    insertNode('execute', 'method', 'src/cli/commands/roles.ts', 26);
    insertNode('validate', 'method', 'src/cli/commands/roles.ts', 21);

    classifyNodeRoles(db);

    const getRole = (name) => db.prepare('SELECT role FROM nodes WHERE name = ?').get(name)?.role;

    expect(getRole('execute')).toBe('entry');
    expect(getRole('validate')).toBe('entry');
  });

  it('does not classify execute/validate as entry when not in a framework directory (#1585 boundary)', () => {
    // An `execute` method in a non-CLI file (e.g. a utility class) should NOT
    // be promoted to `entry` just because of its name.
    insertNode('src/utils/executor.ts', 'file', 'src/utils/executor.ts', 0);
    insertNode('execute', 'method', 'src/utils/executor.ts', 10);

    classifyNodeRoles(db);

    const role = db.prepare("SELECT role FROM nodes WHERE name = 'execute'").get()?.role;
    // Not in a framework directory — should be dead-unresolved (no callers)
    expect(role).not.toBe('entry');
    expect(role).toMatch(/^dead/);
  });

  it('does not promote sole function with fanIn=0, fanOut>0 to leaf via self-sibling (#1586 boundary)', () => {
    // A function with fanIn=0, fanOut>0 that is the ONLY callable in its file
    // must NOT see its own file as "active" and thereby promote itself to leaf.
    // Previously buildActiveFilesSet used (fan_in > 0 || fan_out > 0), causing
    // this node to add its own file to activeFiles, discover hasActiveFileSiblings=true,
    // and be promoted to leaf despite having zero callers.
    insertNode('src/helpers/isolated.ts', 'file', 'src/helpers/isolated.ts', 0);
    const helper = insertNode('helperB', 'function', 'src/helpers/isolated.ts', 5);
    // A callee for helperB so fanOut > 0
    const callee = insertNode('callee', 'function', 'src/helpers/other.ts', 10);
    insertEdge(helper, callee, 'calls');

    classifyNodeRoles(db);

    const role = db.prepare("SELECT role FROM nodes WHERE name = 'helperB'").get()?.role;
    // helperB has fanIn=0, fanOut=1, sole callable in its file — must stay dead-unresolved
    expect(role).toBe('dead-unresolved');
  });

  it('does not promote sole method with fanIn=0, fanOut>0 to leaf via self-sibling (#1586 boundary)', () => {
    // Same self-sibling false-negative as above, but for a method kind.
    insertNode('src/helpers/isolated2.ts', 'file', 'src/helpers/isolated2.ts', 0);
    const method = insertNode('doWork', 'method', 'src/helpers/isolated2.ts', 5);
    const callee = insertNode('calleeM', 'function', 'src/helpers/other2.ts', 10);
    insertEdge(method, callee, 'calls');

    classifyNodeRoles(db);

    const role = db.prepare("SELECT role FROM nodes WHERE name = 'doWork'").get()?.role;
    // doWork has fanIn=0, fanOut=1, sole callable in its file — must stay dead-unresolved
    expect(role).toBe('dead-unresolved');
  });

  it('promotes function with fanIn=0, fanOut>0 to leaf when a real active sibling exists in the file (#1911)', () => {
    // Counterpart to the #1586 self-sibling boundary tests above: this time the
    // file has a genuine OTHER callable with fanIn > 0, so hasActiveFileSiblings
    // must be populated (true) for the function/method group, not left
    // `undefined` as the stale JSDoc on RoleClassificationNode.hasActiveFileSiblings
    // used to claim for "regular callables (functions, methods, classes, etc.)".
    insertNode('src/helpers/mixed.ts', 'file', 'src/helpers/mixed.ts', 0);
    const isolated = insertNode('isolatedHelper', 'function', 'src/helpers/mixed.ts', 5);
    const callee = insertNode('callee', 'function', 'src/helpers/other3.ts', 10);
    insertEdge(isolated, callee, 'calls');
    // A genuine sibling in the same file that IS called (fanIn > 0).
    const sibling = insertNode('activeSibling', 'function', 'src/helpers/mixed.ts', 15);
    const caller = insertNode('caller', 'function', 'src/helpers/other3.ts', 20);
    insertEdge(caller, sibling, 'calls');

    classifyNodeRoles(db);

    const role = db.prepare("SELECT role FROM nodes WHERE name = 'isolatedHelper'").get()?.role;
    // isolatedHelper has fanIn=0, fanOut=1, and a real active sibling in its
    // file — must be promoted to leaf, not dead-unresolved.
    expect(role).toBe('leaf');
  });

  it('incremental path: does not classify exported interface as dead when used only as same-file type annotation (#1583)', () => {
    // Exercises classifyNodeRolesIncremental (triggered by passing changedFiles).
    // An exported=1 interface with no cross-file edges must be promoted to leaf,
    // not dead-unresolved, on the incremental path just as on the full path.
    db.prepare('INSERT INTO nodes (name, kind, file, line, exported) VALUES (?, ?, ?, ?, ?)').run(
      'IncrementalOpts',
      'interface',
      'src/helpers.ts',
      30,
      1,
    );

    // Pass the file as the changed-files list to trigger the incremental path.
    classifyNodeRoles(db, ['src/helpers.ts']);
    const role = db.prepare("SELECT role FROM nodes WHERE name = 'IncrementalOpts'").get();
    // Should be leaf (exported, fan-in 0), not dead-unresolved or entry — an
    // interface is a data-shape declaration, never a callable entry point (#1780).
    expect(role.role).toBe('leaf');
  });

  // ── Parameters and interface members are not dead-code targets (#1723) ──

  it('excludes parameter-kind nodes from role classification entirely', () => {
    // A parameter's liveness is a local dataflow question (is it referenced
    // within its own function body), not a call-graph reachability question.
    // "No incoming call edges" is guaranteed for every parameter regardless of
    // usage, so parameters must never receive a `dead-*` role — or any role at
    // all, the same treatment as file/directory nodes.
    insertNode('src/helpers.ts', 'file', 'src/helpers.ts', 0);
    const fn = insertNode('findChild', 'function', 'src/helpers.ts', 26);
    insertNode('node', 'parameter', 'src/helpers.ts', 26);
    insertNode('type', 'parameter', 'src/helpers.ts', 26);
    // An external caller so findChild itself is not incidentally dead too —
    // isolates the assertion to parameter handling specifically.
    const caller = insertNode('caller', 'function', 'other.ts', 1);
    insertEdge(caller, fn, 'calls');

    classifyNodeRoles(db);

    const paramRoles = db.prepare("SELECT role FROM nodes WHERE kind = 'parameter'").all() as {
      role: string | null;
    }[];
    expect(paramRoles).toHaveLength(2);
    for (const row of paramRoles) {
      expect(row.role).toBeNull();
    }
  });

  it('does not classify interface members as dead', () => {
    // TS `interface ExtractParametersOptions { typeMap?: Map<...> }` extracts
    // `typeMap` as a top-level `property`-kind definition named
    // `ExtractParametersOptions.typeMap` (property-signature members).
    // It has no callers by construction; it must not be flagged dead.
    insertNode('src/helpers.ts', 'file', 'src/helpers.ts', 0);
    insertNode('ExtractParametersOptions', 'interface', 'src/helpers.ts', 359);
    insertNode('ExtractParametersOptions.typeMap', 'property', 'src/helpers.ts', 361);

    classifyNodeRoles(db);

    const role = db
      .prepare("SELECT role FROM nodes WHERE name = 'ExtractParametersOptions.typeMap'")
      .get() as { role: string | null };
    expect(role.role).toBe('leaf');
  });

  it('excludes genuine (non-interface) class property-kind nodes from role classification entirely (#1810)', () => {
    // A plain class field with no owning interface/type declaration in the
    // file must get no role at all — the same treatment as `parameter` (#1723).
    // A field's liveness (is it read/written anywhere in its owning class) is
    // a dataflow question codegraph has no property-access/write edge tracking
    // to answer, so "zero inbound call edges" (guaranteed by construction)
    // carries zero dead-code signal. The #1809 partition still must not
    // promote every property-kind node to `leaf` — only ones owned by a
    // TYPE_DEF_KINDS symbol get `leaf`; the rest get `null`, never `dead-leaf`.
    insertNode('src/widget.ts', 'file', 'src/widget.ts', 0);
    insertNode('Widget', 'class', 'src/widget.ts', 1);
    insertNode('Widget.label', 'property', 'src/widget.ts', 2);

    classifyNodeRoles(db);

    const role = db.prepare("SELECT role FROM nodes WHERE name = 'Widget.label'").get() as {
      role: string | null;
    };
    expect(role.role).toBeNull();
  });

  it('incremental path: does not classify property-kind interface members as dead (#1809)', () => {
    // Exercises classifyNodeRolesIncremental (triggered by passing changedFiles).
    // Property-kind interface members must land on `leaf`, not `dead-leaf`, on
    // the incremental path just as on the full path — the fast-path property
    // query in classifyNodeRolesIncremental must not blanket-classify every
    // `kind = 'property'` row as dead-leaf without first ruling out interface/
    // type ownership.
    insertNode('src/helpers.ts', 'file', 'src/helpers.ts', 0);
    insertNode('Widget', 'interface', 'src/helpers.ts', 10);
    insertNode('Widget.name', 'property', 'src/helpers.ts', 11);

    classifyNodeRoles(db, ['src/helpers.ts']);

    const role = db.prepare("SELECT role FROM nodes WHERE name = 'Widget.name'").get() as {
      role: string | null;
    };
    expect(role.role).toBe('leaf');
  });

  it('incremental path: excludes genuine (non-interface) class property-kind nodes from role classification entirely (#1810)', () => {
    // Exercises classifyNodeRolesIncremental (triggered by passing changedFiles).
    // A genuine class field must get no role on the incremental path just as
    // on the full path — the fast-path property query must not blanket-classify
    // every `kind = 'property'` row owned by a non-type-def symbol.
    insertNode('src/widget.ts', 'file', 'src/widget.ts', 0);
    insertNode('Widget', 'class', 'src/widget.ts', 1);
    insertNode('Widget.label', 'property', 'src/widget.ts', 2);

    classifyNodeRoles(db, ['src/widget.ts']);

    const role = db.prepare("SELECT role FROM nodes WHERE name = 'Widget.label'").get() as {
      role: string | null;
    };
    expect(role.role).toBeNull();
  });

  it('regression: used parameters, unused properties, interface members, and a genuinely dead function are classified correctly together', () => {
    // Mirrors the exact issue #1723 repro: `findChild(node, type)` in
    // src/extractors/helpers.ts, alongside an interface and a truly dead function.
    // Also covers #1810: a genuine class property with no other graph
    // connections must land alongside the parameters (no role), not dead-leaf.
    insertNode('src/helpers.ts', 'file', 'src/helpers.ts', 0);
    const findChildFn = insertNode('findChild', 'function', 'src/helpers.ts', 26);
    insertNode('node', 'parameter', 'src/helpers.ts', 26);
    insertNode('type', 'parameter', 'src/helpers.ts', 26);
    insertNode('ChaContext', 'interface', 'src/helpers.ts', 18);
    insertNode('ChaContext.implementors', 'method', 'src/helpers.ts', 20);
    insertNode('trulyDeadHelper', 'function', 'src/helpers.ts', 400);
    insertNode('Widget', 'class', 'src/helpers.ts', 500);
    insertNode('Widget.label', 'property', 'src/helpers.ts', 501);

    const caller = insertNode('caller', 'function', 'other.ts', 1);
    insertEdge(caller, findChildFn, 'calls');

    classifyNodeRoles(db);
    const getRole = (name) => db.prepare('SELECT role FROM nodes WHERE name = ?').get(name)?.role;

    expect(getRole('node')).toBeNull();
    expect(getRole('type')).toBeNull();
    expect(getRole('ChaContext.implementors')).toBe('leaf');
    expect(getRole('trulyDeadHelper')).toBe('dead-unresolved');
    expect(getRole('Widget.label')).toBeNull();
  });
});
