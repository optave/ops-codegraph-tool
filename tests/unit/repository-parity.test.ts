import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSchema } from '../../src/db/migrations.js';
import { InMemoryRepository } from '../../src/db/repository/in-memory-repository.js';
import { SqliteRepository } from '../../src/db/repository/sqlite-repository.js';

/**
 * Parity tests — run the same assertions against both SqliteRepository and
 * InMemoryRepository to verify behavioral equivalence.
 */

function seedSqliteRepo() {
  const db = new Database(':memory:');
  initSchema(db);

  const insertNode = db.prepare(
    'INSERT INTO nodes (name, kind, file, line, end_line, role, scope, qualified_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertNode.run('foo', 'function', 'src/foo.js', 1, 15, 'core', null, 'foo');
  insertNode.run('bar', 'method', 'src/bar.js', 10, 30, 'utility', 'BarClass', 'BarClass.bar');
  insertNode.run('Baz', 'class', 'src/baz.js', 20, 50, 'entry', null, 'Baz');
  insertNode.run('qux', 'interface', 'src/qux.js', 30, 40, null, null, null);
  insertNode.run('testFn', 'function', 'tests/foo.test.js', 1, 10, null, null, null);
  insertNode.run('jestFn', 'function', 'src/__tests__/helper.js', 1, 10, null, null, null);
  insertNode.run('storyFn', 'function', 'src/Button.stories.js', 1, 10, null, null, null);
  // File-kind node for findFileNodes / getFileNodesAll
  db.prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)').run(
    'src/foo.js',
    'file',
    'src/foo.js',
    0,
  );
  // Child node with parent_id for findNodeChildren
  db.prepare(
    'INSERT INTO nodes (name, kind, file, line, end_line, parent_id, scope) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('bazMethod', 'method', 'src/baz.js', 25, 35, null, 'Baz');

  const fooId = db.prepare("SELECT id FROM nodes WHERE name = 'foo'").get().id;
  const barId = db.prepare("SELECT id FROM nodes WHERE name = 'bar'").get().id;
  const bazId = db.prepare("SELECT id FROM nodes WHERE name = 'Baz'").get().id;
  const fooFileId = db.prepare("SELECT id FROM nodes WHERE name = 'src/foo.js'").get().id;
  const bazMethodId = db.prepare("SELECT id FROM nodes WHERE name = 'bazMethod'").get().id;
  // Set parent_id for bazMethod -> Baz
  db.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?').run(bazId, bazMethodId);

  const insertEdge = db.prepare('INSERT INTO edges (source_id, target_id, kind) VALUES (?, ?, ?)');
  insertEdge.run(barId, fooId, 'calls');
  insertEdge.run(bazId, fooId, 'calls');
  insertEdge.run(bazId, barId, 'extends');
  // Import edge: foo.js imports bar.js
  insertEdge.run(fooId, barId, 'imports');

  db.prepare(
    'INSERT INTO function_complexity (node_id, cognitive, cyclomatic, max_nesting, maintainability_index, halstead_volume) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(fooId, 5, 3, 2, 80, 100);

  return {
    repo: new SqliteRepository(db),
    ids: { foo: fooId, bar: barId, baz: bazId, fooFile: fooFileId, bazMethod: bazMethodId },
  };
}

function seedInMemoryRepo() {
  const repo = new InMemoryRepository();
  const fooId = repo.addNode({
    name: 'foo',
    kind: 'function',
    file: 'src/foo.js',
    line: 1,
    end_line: 15,
    role: 'core',
    qualified_name: 'foo',
  });
  const barId = repo.addNode({
    name: 'bar',
    kind: 'method',
    file: 'src/bar.js',
    line: 10,
    end_line: 30,
    role: 'utility',
    scope: 'BarClass',
    qualified_name: 'BarClass.bar',
  });
  const bazId = repo.addNode({
    name: 'Baz',
    kind: 'class',
    file: 'src/baz.js',
    line: 20,
    end_line: 50,
    role: 'entry',
    qualified_name: 'Baz',
  });
  repo.addNode({ name: 'qux', kind: 'interface', file: 'src/qux.js', line: 30, end_line: 40 });
  repo.addNode({
    name: 'testFn',
    kind: 'function',
    file: 'tests/foo.test.js',
    line: 1,
    end_line: 10,
  });
  repo.addNode({
    name: 'jestFn',
    kind: 'function',
    file: 'src/__tests__/helper.js',
    line: 1,
    end_line: 10,
  });
  repo.addNode({
    name: 'storyFn',
    kind: 'function',
    file: 'src/Button.stories.js',
    line: 1,
    end_line: 10,
  });
  // File-kind node for findFileNodes / getFileNodesAll
  const fooFileId = repo.addNode({ name: 'src/foo.js', kind: 'file', file: 'src/foo.js', line: 0 });
  // Child node with parent_id for findNodeChildren
  const bazMethodId = repo.addNode({
    name: 'bazMethod',
    kind: 'method',
    file: 'src/baz.js',
    line: 25,
    end_line: 35,
    parent_id: bazId,
    scope: 'Baz',
  });

  repo.addEdge({ source_id: barId, target_id: fooId, kind: 'calls' });
  repo.addEdge({ source_id: bazId, target_id: fooId, kind: 'calls' });
  repo.addEdge({ source_id: bazId, target_id: barId, kind: 'extends' });
  // Import edge: foo imports bar
  repo.addEdge({ source_id: fooId, target_id: barId, kind: 'imports' });

  repo.addComplexity(fooId, {
    cognitive: 5,
    cyclomatic: 3,
    max_nesting: 2,
    maintainability_index: 80,
    halstead_volume: 100,
  });

  return {
    repo,
    ids: { foo: fooId, bar: barId, baz: bazId, fooFile: fooFileId, bazMethod: bazMethodId },
  };
}

describe.each([
  { label: 'SqliteRepository', seed: seedSqliteRepo },
  { label: 'InMemoryRepository', seed: seedInMemoryRepo },
])('Repository parity: $label', ({ seed }) => {
  let repo: any;
  let ids: any;
  let dbToClose: any;

  beforeEach(() => {
    const result = seed();
    repo = result.repo;
    ids = result.ids;
    if (repo.db) dbToClose = repo.db;
  });

  afterEach(() => {
    if (dbToClose) dbToClose.close();
  });

  // ── Counts ──────────────────────────────────────────────────────────

  it('countNodes', () => {
    expect(repo.countNodes()).toBe(9);
  });

  it('countEdges', () => {
    expect(repo.countEdges()).toBe(4); // 2 calls + 1 extends + 1 imports
  });

  it('countFiles', () => {
    expect(repo.countFiles()).toBe(7); // foo.js, bar.js, baz.js, qux.js, foo.test.js, __tests__/helper.js, Button.stories.js
  });

  // ── Node lookups ────────────────────────────────────────────────────

  it('findNodeById', () => {
    const node = repo.findNodeById(ids.foo);
    expect(node).toBeDefined();
    expect(node.name).toBe('foo');
    expect(node.kind).toBe('function');
  });

  it('findNodeById returns undefined for missing', () => {
    expect(repo.findNodeById(9999)).toBeUndefined();
  });

  it('findNodesByFile', () => {
    const nodes = repo.findNodesByFile('src/foo.js');
    expect(nodes.length).toBe(1);
    expect(nodes[0].name).toBe('foo');
  });

  it('getNodeId', () => {
    expect(repo.getNodeId('foo', 'function', 'src/foo.js', 1)).toBe(ids.foo);
    expect(repo.getNodeId('nope', 'function', 'x.js', 1)).toBeUndefined();
  });

  it('getFunctionNodeId', () => {
    expect(repo.getFunctionNodeId('foo', 'src/foo.js', 1)).toBe(ids.foo);
    // class is not function/method
    expect(repo.getFunctionNodeId('Baz', 'src/baz.js', 20)).toBeUndefined();
  });

  it('bulkNodeIdsByFile', () => {
    const rows = repo.bulkNodeIdsByFile('src/foo.js');
    expect(rows.length).toBe(2); // foo (function) + src/foo.js (file)
    expect(rows.map((r) => r.name).sort()).toEqual(['foo', 'src/foo.js']);
  });

  // ── Listing / iteration ─────────────────────────────────────────────

  it('listFunctionNodes returns fn/method/class', () => {
    const rows = repo.listFunctionNodes();
    expect(rows.length).toBe(7); // foo, bar, Baz, testFn, bazMethod, jestFn, storyFn
    expect(rows.every((r) => ['function', 'method', 'class'].includes(r.kind))).toBe(true);
  });

  it('listFunctionNodes excludes tests', () => {
    const rows = repo.listFunctionNodes({ noTests: true });
    expect(rows.length).toBe(4); // foo, bar, Baz, bazMethod
    expect(rows.every((r) => !r.file.includes('.test.'))).toBe(true);
    expect(rows.every((r) => !r.file.includes('__tests__'))).toBe(true);
    expect(rows.every((r) => !r.file.includes('.stories.'))).toBe(true);
  });

  it('listFunctionNodes filters by pattern', () => {
    const rows = repo.listFunctionNodes({ pattern: 'Baz' });
    expect(rows.length).toBe(2); // Baz + bazMethod (LIKE is case-insensitive)
  });

  it('iterateFunctionNodes matches listFunctionNodes', () => {
    const list = repo.listFunctionNodes();
    const iter = [...repo.iterateFunctionNodes()];
    expect(iter.length).toBe(list.length);
  });

  // ── Edge queries ────────────────────────────────────────────────────

  it('findCallees', () => {
    const callees = repo.findCallees(ids.bar);
    expect(callees.length).toBe(1);
    expect(callees[0].name).toBe('foo');
  });

  it('findCallers', () => {
    const callers = repo.findCallers(ids.foo);
    expect(callers.length).toBe(2);
    const names = callers.map((c) => c.name).sort();
    expect(names).toEqual(['Baz', 'bar']);
  });

  it('findDistinctCallers', () => {
    const callers = repo.findDistinctCallers(ids.foo);
    expect(callers.length).toBe(2);
  });

  it('findCalleeNames / findCallerNames', () => {
    const calleeNames = repo.findCalleeNames(ids.bar);
    expect(calleeNames).toEqual(['foo']);

    const callerNames = repo.findCallerNames(ids.foo);
    expect(callerNames).toEqual(['Baz', 'bar']);
  });

  it('findAllOutgoingEdges', () => {
    const edges = repo.findAllOutgoingEdges(ids.baz);
    expect(edges.length).toBe(2); // calls foo, extends bar
    const kinds = edges.map((e) => e.edge_kind).sort();
    expect(kinds).toEqual(['calls', 'extends']);
  });

  it('findAllIncomingEdges', () => {
    const edges = repo.findAllIncomingEdges(ids.foo);
    expect(edges.length).toBe(2);
    expect(edges.every((e) => e.edge_kind === 'calls')).toBe(true);
  });

  it('findCrossFileCallTargets', () => {
    const targets = repo.findCrossFileCallTargets('src/foo.js');
    expect(targets.size).toBe(1);
    expect(targets.has(ids.foo)).toBe(true);
  });

  it('countCrossFileCallers', () => {
    expect(repo.countCrossFileCallers(ids.foo, 'src/foo.js')).toBe(2);
  });

  it('findIntraFileCallEdges', () => {
    // No intra-file calls in our graph (foo, bar, Baz are all different files)
    const edges = repo.findIntraFileCallEdges('src/foo.js');
    expect(edges.length).toBe(0);
  });

  // ── Class hierarchy ─────────────────────────────────────────────────

  it('getClassHierarchy', () => {
    const ancestors = repo.getClassHierarchy(ids.baz);
    expect(ancestors.size).toBe(1); // Baz extends bar
    expect(ancestors.has(ids.bar)).toBe(true);
  });

  // ── Graph-read queries ──────────────────────────────────────────────

  it('getCallEdges', () => {
    const edges = repo.getCallEdges();
    expect(edges.length).toBe(2); // only 'calls' edges, not 'extends'
  });

  // ── Complexity ──────────────────────────────────────────────────────

  it('getComplexityForNode', () => {
    const cx = repo.getComplexityForNode(ids.foo);
    expect(cx).toBeDefined();
    expect(cx.cognitive).toBe(5);
    expect(cx.cyclomatic).toBe(3);
    expect(cx.max_nesting).toBe(2);
  });

  it('getComplexityForNode returns undefined for no data', () => {
    expect(repo.getComplexityForNode(ids.bar)).toBeUndefined();
  });

  // ── Optional table checks ──────────────────────────────────────────

  it('hasDataflowTable returns false', () => {
    expect(repo.hasDataflowTable()).toBe(false);
  });

  // ── Validation ────────────────────────────────────────────────────

  it('findNodesForTriage throws on invalid kind', () => {
    expect(() => repo.findNodesForTriage({ kind: 'bogus' })).toThrow('Invalid kind');
  });

  it('findNodesForTriage throws on invalid role', () => {
    expect(() => repo.findNodesForTriage({ role: 'supervisor' })).toThrow('Invalid role');
  });

  // ── Scope / qualified-name lookups ──────────────────────────────────

  it('findNodesByScope', () => {
    const nodes = repo.findNodesByScope('BarClass');
    expect(nodes.length).toBe(1); // only bar has scope 'BarClass'
    expect(nodes[0].name).toBe('bar');
  });

  it('findNodesByScope with file filter', () => {
    const nodes = repo.findNodesByScope('BarClass', { file: 'bar.js' });
    expect(nodes.length).toBe(1);
    expect(nodes[0].name).toBe('bar');
  });

  it('findNodeByQualifiedName', () => {
    const nodes = repo.findNodeByQualifiedName('BarClass.bar');
    expect(nodes.length).toBe(1);
    expect(nodes[0].name).toBe('bar');
  });

  it('findNodeByQualifiedName with file filter', () => {
    const nodes = repo.findNodeByQualifiedName('BarClass.bar', { file: 'bar.js' });
    expect(nodes.length).toBe(1);
    expect(nodes[0].name).toBe('bar');
  });

  // ── LIKE escaping ─────────────────────────────────────────────────

  it('findNodesByScope treats _ as literal in file filter', () => {
    // "_" is a LIKE wildcard — must not match arbitrary single chars
    const nodes = repo.findNodesByScope('BarClass', { file: '_ar.js' });
    expect(nodes.length).toBe(0);
  });

  // ── Fan-in ─────────────────────────────────────────────────────────

  it('findNodesWithFanIn', () => {
    const nodes = repo.findNodesWithFanIn('%foo%');
    expect(nodes.length).toBeGreaterThanOrEqual(1);
    const foo = nodes.find((n) => n.name === 'foo');
    expect(foo).toBeDefined();
    expect(foo.fan_in).toBe(2); // bar calls foo, Baz calls foo
  });

  it('findNodesWithFanIn treats _ as literal in file filter', () => {
    // "_" is a LIKE wildcard — must not match arbitrary single chars
    const nodes = repo.findNodesWithFanIn('%foo%', { file: '_oo.js' });
    expect(nodes.length).toBe(0);
  });

  // ── File nodes ────────────────────────────────────────────────────

  it('findFileNodes', () => {
    const nodes = repo.findFileNodes('%foo%');
    expect(nodes.length).toBe(1);
    expect(nodes[0].kind).toBe('file');
    expect(nodes[0].file).toBe('src/foo.js');
  });

  it('getFileNodesAll', () => {
    const nodes = repo.getFileNodesAll();
    expect(nodes.length).toBe(1);
    expect(nodes[0].file).toBe('src/foo.js');
  });

  // ── Node children ─────────────────────────────────────────────────

  it('findNodeChildren', () => {
    const children = repo.findNodeChildren(ids.baz);
    expect(children.length).toBe(1);
    expect(children[0].name).toBe('bazMethod');
    expect(children[0].kind).toBe('method');
  });

  it('findNodeChildren returns empty for leaf', () => {
    expect(repo.findNodeChildren(ids.foo).length).toBe(0);
  });

  // ── Import queries ────────────────────────────────────────────────

  it('findImportTargets', () => {
    const targets = repo.findImportTargets(ids.foo);
    expect(targets.length).toBe(1);
    expect(targets[0].file).toBe('src/bar.js');
    expect(targets[0].edge_kind).toBe('imports');
  });

  it('findImportSources', () => {
    const sources = repo.findImportSources(ids.bar);
    expect(sources.length).toBe(1);
    expect(sources[0].file).toBe('src/foo.js');
  });

  it('findImportDependents', () => {
    const deps = repo.findImportDependents(ids.bar);
    expect(deps.length).toBe(1);
    expect(deps[0].name).toBe('foo');
  });

  it('getImportEdges', () => {
    const edges = repo.getImportEdges();
    expect(edges.length).toBe(1);
    expect(edges[0].source_id).toBe(ids.foo);
    expect(edges[0].target_id).toBe(ids.bar);
  });

  // ── Callable nodes ────────────────────────────────────────────────

  it('getCallableNodes', () => {
    const nodes = repo.getCallableNodes();
    // CORE_SYMBOL_KINDS includes function, method, class, interface, etc.
    expect(nodes.length).toBeGreaterThanOrEqual(7);
    expect(nodes.every((n) => n.id && n.name && n.kind && n.file)).toBe(true);
  });

  // ── Optional table checks ─────────────────────────────────────────

  it('hasCfgTables', () => {
    // SQLite returns true (initSchema creates cfg tables), InMemory returns false.
    // Both are correct — just verify the method exists and returns a boolean.
    expect(typeof repo.hasCfgTables()).toBe('boolean');
  });

  it('hasEmbeddings returns false', () => {
    expect(repo.hasEmbeddings()).toBe(false);
  });
});
