import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../../src/db/repository/in-memory-repository.js';
import { createTestRepo } from '../helpers/fixtures.js';

describe('InMemoryRepository', () => {
  // ── Test graph ──────────────────────────────────────────────────────
  // foo (function, src/foo.js:1, core) ← called by bar, Baz
  // bar (method, src/bar.js:10, utility) → calls foo
  // Baz (class, src/baz.js:20, entry) → calls foo
  // qux (interface, src/qux.js:30)
  // testFn (function, tests/foo.test.js:1)
  function makeRepo() {
    return createTestRepo()
      .fn('foo', 'src/foo.js', 1, { role: 'core' })
      .method('bar', 'src/bar.js', 10, { role: 'utility' })
      .cls('Baz', 'src/baz.js', 20, { role: 'entry' })
      .node('qux', 'interface', 'src/qux.js', 30)
      .fn('testFn', 'tests/foo.test.js', 1)
      .calls('bar', 'foo')
      .calls('Baz', 'foo')
      .complexity('foo', { cognitive: 5, cyclomatic: 3, max_nesting: 2 })
      .build();
  }

  describe('countNodes / countEdges / countFiles', () => {
    it('counts correctly', () => {
      const { repo } = makeRepo();
      expect(repo.countNodes()).toBe(5);
      expect(repo.countEdges()).toBe(2);
      expect(repo.countFiles()).toBe(5);
    });
  });

  describe('findNodeById', () => {
    it('returns node by id', () => {
      const { repo, ids } = makeRepo();
      const node = repo.findNodeById(ids.get('foo'));
      expect(node).toBeDefined();
      expect(node.name).toBe('foo');
      expect(node.kind).toBe('function');
    });

    it('returns undefined for missing id', () => {
      const { repo } = makeRepo();
      expect(repo.findNodeById(9999)).toBeUndefined();
    });
  });

  describe('findNodesByFile', () => {
    it('returns non-file nodes for a file, sorted by line', () => {
      const { repo } = makeRepo();
      const nodes = repo.findNodesByFile('src/foo.js');
      expect(nodes.length).toBe(1);
      expect(nodes[0].name).toBe('foo');
    });

    it('excludes file-kind nodes', () => {
      const { repo } = createTestRepo().file('src/app.js').fn('main', 'src/app.js', 1).build();
      const nodes = repo.findNodesByFile('src/app.js');
      expect(nodes.length).toBe(1);
      expect(nodes[0].name).toBe('main');
    });
  });

  describe('findFileNodes', () => {
    it('finds file-kind nodes matching LIKE pattern', () => {
      const { repo } = createTestRepo()
        .file('src/app.js')
        .file('src/utils.js')
        .fn('main', 'src/app.js', 1)
        .build();
      const nodes = repo.findFileNodes('%app%');
      expect(nodes.length).toBe(1);
      expect(nodes[0].name).toBe('src/app.js');
    });
  });

  describe('findNodesWithFanIn', () => {
    it('returns nodes with fan-in count', () => {
      const { repo } = makeRepo();
      const rows = repo.findNodesWithFanIn('%foo%');
      const foo = rows.find((r) => r.name === 'foo');
      expect(foo).toBeDefined();
      expect(foo.fan_in).toBe(2);
    });

    it('filters by kinds', () => {
      const { repo } = makeRepo();
      const rows = repo.findNodesWithFanIn('%foo%', { kinds: ['method'] });
      expect(rows.length).toBe(0);
    });

    it('filters by file', () => {
      const { repo } = makeRepo();
      const rows = repo.findNodesWithFanIn('%foo%', { file: 'src' });
      expect(rows.every((r) => r.file.includes('src'))).toBe(true);
    });
  });

  describe('getNodeId / getFunctionNodeId', () => {
    it('getNodeId returns id for exact tuple match', () => {
      const { repo, ids } = makeRepo();
      expect(repo.getNodeId('foo', 'function', 'src/foo.js', 1)).toBe(ids.get('foo'));
    });

    it('getNodeId returns undefined for no match', () => {
      const { repo } = makeRepo();
      expect(repo.getNodeId('nope', 'function', 'x.js', 1)).toBeUndefined();
    });

    it('getFunctionNodeId restricts to function/method', () => {
      const { repo, ids } = makeRepo();
      expect(repo.getFunctionNodeId('foo', 'src/foo.js', 1)).toBe(ids.get('foo'));
      expect(repo.getFunctionNodeId('Baz', 'src/baz.js', 20)).toBeUndefined(); // class, not function
    });
  });

  describe('bulkNodeIdsByFile', () => {
    it('returns all nodes in a file', () => {
      const { repo } = makeRepo();
      const rows = repo.bulkNodeIdsByFile('src/foo.js');
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe('foo');
    });
  });

  describe('findNodeChildren', () => {
    it('finds children by parent_id', () => {
      const repo2 = new InMemoryRepository();
      const classId = repo2.addNode({
        name: 'MyClass',
        kind: 'class',
        file: 'src/cls.js',
        line: 1,
      });
      repo2.addNode({
        name: 'doThing',
        kind: 'method',
        file: 'src/cls.js',
        line: 5,
        parent_id: classId,
      });
      const children = repo2.findNodeChildren(classId);
      expect(children.length).toBe(1);
      expect(children[0].name).toBe('doThing');
    });
  });

  describe('findNodesByScope', () => {
    it('filters by scope name', () => {
      const repo = new InMemoryRepository();
      repo.addNode({ name: 'MyClass', kind: 'class', file: 'src/cls.js', line: 1 });
      repo.addNode({
        name: 'doThing',
        kind: 'method',
        file: 'src/cls.js',
        line: 5,
        scope: 'MyClass',
      });
      repo.addNode({
        name: 'helper',
        kind: 'function',
        file: 'src/cls.js',
        line: 20,
        scope: 'MyClass',
      });
      repo.addNode({ name: 'other', kind: 'function', file: 'src/other.js', line: 1 });

      const scoped = repo.findNodesByScope('MyClass');
      expect(scoped.length).toBe(2);
    });

    it('filters by scope + kind', () => {
      const repo = new InMemoryRepository();
      repo.addNode({
        name: 'doThing',
        kind: 'method',
        file: 'src/cls.js',
        line: 5,
        scope: 'MyClass',
      });
      repo.addNode({
        name: 'helper',
        kind: 'function',
        file: 'src/cls.js',
        line: 20,
        scope: 'MyClass',
      });

      const methods = repo.findNodesByScope('MyClass', { kind: 'method' });
      expect(methods.length).toBe(1);
      expect(methods[0].name).toBe('doThing');
    });
  });

  describe('findNodeByQualifiedName', () => {
    it('finds nodes by qualified name', () => {
      const repo = new InMemoryRepository();
      repo.addNode({
        name: 'format',
        kind: 'method',
        file: 'src/a.js',
        line: 10,
        qualified_name: 'DateHelper.format',
      });
      repo.addNode({
        name: 'format',
        kind: 'method',
        file: 'src/b.js',
        line: 20,
        qualified_name: 'DateHelper.format',
      });

      const nodes = repo.findNodeByQualifiedName('DateHelper.format');
      expect(nodes.length).toBe(2);
    });

    it('filters by file', () => {
      const repo = new InMemoryRepository();
      repo.addNode({
        name: 'format',
        kind: 'method',
        file: 'src/a.js',
        line: 10,
        qualified_name: 'DateHelper.format',
      });
      repo.addNode({
        name: 'format',
        kind: 'method',
        file: 'src/b.js',
        line: 20,
        qualified_name: 'DateHelper.format',
      });

      const nodes = repo.findNodeByQualifiedName('DateHelper.format', { file: 'a.js' });
      expect(nodes.length).toBe(1);
    });
  });

  describe('listFunctionNodes / iterateFunctionNodes', () => {
    it('returns function/method/class nodes', () => {
      const { repo } = makeRepo();
      const rows = repo.listFunctionNodes();
      expect(rows.length).toBe(4); // foo, bar, Baz, testFn
      expect(rows.every((r) => ['function', 'method', 'class'].includes(r.kind))).toBe(true);
    });

    it('filters by file', () => {
      const { repo } = makeRepo();
      const rows = repo.listFunctionNodes({ file: 'foo' });
      expect(rows.every((r) => r.file.includes('foo'))).toBe(true);
    });

    it('filters by pattern', () => {
      const { repo } = makeRepo();
      const rows = repo.listFunctionNodes({ pattern: 'Baz' });
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe('Baz');
    });

    it('excludes test files when noTests is set', () => {
      const { repo } = makeRepo();
      const rows = repo.listFunctionNodes({ noTests: true });
      expect(rows.every((r) => !r.file.includes('.test.'))).toBe(true);
      expect(rows.length).toBe(3);
    });

    it('orders by file, line', () => {
      const { repo } = makeRepo();
      const rows = repo.listFunctionNodes();
      for (let i = 1; i < rows.length; i++) {
        const prev = `${rows[i - 1].file}:${String(rows[i - 1].line).padStart(6, '0')}`;
        const curr = `${rows[i].file}:${String(rows[i].line).padStart(6, '0')}`;
        expect(prev <= curr).toBe(true);
      }
    });

    it('iterateFunctionNodes returns an iterator', () => {
      const { repo } = makeRepo();
      const rows = [...repo.iterateFunctionNodes()];
      expect(rows.length).toBe(4);
    });

    it('iterateFunctionNodes respects filters', () => {
      const { repo } = makeRepo();
      const rows = [...repo.iterateFunctionNodes({ noTests: true })];
      expect(rows.length).toBe(3);
    });
  });

  describe('findNodesForTriage', () => {
    it('returns nodes with triage signals', () => {
      const { repo } = makeRepo();
      const rows = repo.findNodesForTriage();
      expect(rows.length).toBe(4);
      const foo = rows.find((r) => r.name === 'foo');
      expect(foo.fan_in).toBe(2);
      expect(foo.cognitive).toBe(5);
    });

    it('excludes test files when noTests is set', () => {
      const { repo } = makeRepo();
      const rows = repo.findNodesForTriage({ noTests: true });
      expect(rows.every((r) => !r.file.includes('.test.'))).toBe(true);
    });

    it('filters by kind', () => {
      const { repo } = makeRepo();
      const rows = repo.findNodesForTriage({ kind: 'class' });
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe('Baz');
    });

    it('filters by role', () => {
      const { repo } = makeRepo();
      const rows = repo.findNodesForTriage({ role: 'core' });
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe('foo');
    });

    it('throws on invalid kind', () => {
      const { repo } = makeRepo();
      expect(() => repo.findNodesForTriage({ kind: 'bogus' })).toThrow('Invalid kind');
    });

    it('throws on invalid role', () => {
      const { repo } = makeRepo();
      expect(() => repo.findNodesForTriage({ role: 'supervisor' })).toThrow('Invalid role');
    });
  });

  // ── Edge queries ──────────────────────────────────────────────────

  describe('findCallees / findCallers', () => {
    it('finds callees', () => {
      const { repo, ids } = makeRepo();
      const callees = repo.findCallees(ids.get('bar'));
      expect(callees.length).toBe(1);
      expect(callees[0].name).toBe('foo');
    });

    it('finds callers', () => {
      const { repo, ids } = makeRepo();
      const callers = repo.findCallers(ids.get('foo'));
      expect(callers.length).toBe(2);
      const names = callers.map((c) => c.name).sort();
      expect(names).toEqual(['Baz', 'bar']);
    });
  });

  describe('findDistinctCallers', () => {
    it('deduplicates callers', () => {
      const { repo, ids } = createTestRepo()
        .fn('target', 'src/t.js', 1)
        .fn('caller', 'src/c.js', 1)
        .calls('caller', 'target')
        .calls('caller', 'target') // duplicate edge
        .build();
      const callers = repo.findDistinctCallers(ids.get('target'));
      expect(callers.length).toBe(1);
    });
  });

  describe('findAllOutgoingEdges / findAllIncomingEdges', () => {
    it('returns all outgoing edges with edge_kind', () => {
      const { repo, ids } = makeRepo();
      const edges = repo.findAllOutgoingEdges(ids.get('bar'));
      expect(edges.length).toBe(1);
      expect(edges[0].edge_kind).toBe('calls');
      expect(edges[0].name).toBe('foo');
    });

    it('returns all incoming edges with edge_kind', () => {
      const { repo, ids } = makeRepo();
      const edges = repo.findAllIncomingEdges(ids.get('foo'));
      expect(edges.length).toBe(2);
      expect(edges.every((e) => e.edge_kind === 'calls')).toBe(true);
    });
  });

  describe('findCalleeNames / findCallerNames', () => {
    it('returns sorted callee names', () => {
      const { repo, ids } = createTestRepo()
        .fn('main', 'src/m.js', 1)
        .fn('beta', 'src/b.js', 1)
        .fn('alpha', 'src/a.js', 1)
        .calls('main', 'beta')
        .calls('main', 'alpha')
        .build();
      expect(repo.findCalleeNames(ids.get('main'))).toEqual(['alpha', 'beta']);
    });

    it('returns sorted caller names', () => {
      const { repo, ids } = makeRepo();
      expect(repo.findCallerNames(ids.get('foo'))).toEqual(['Baz', 'bar']);
    });
  });

  describe('import edge queries', () => {
    it('finds import targets and sources', () => {
      const { repo, ids } = createTestRepo()
        .file('src/app.js')
        .file('src/utils.js')
        .imports('src/app.js', 'src/utils.js')
        .build();
      const targets = repo.findImportTargets(ids.get('src/app.js'));
      expect(targets.length).toBe(1);
      expect(targets[0].file).toBe('src/utils.js');

      const sources = repo.findImportSources(ids.get('src/utils.js'));
      expect(sources.length).toBe(1);
      expect(sources[0].file).toBe('src/app.js');
    });

    it('finds import dependents', () => {
      const { repo, ids } = createTestRepo()
        .file('src/app.js')
        .file('src/utils.js')
        .imports('src/app.js', 'src/utils.js')
        .build();
      const deps = repo.findImportDependents(ids.get('src/utils.js'));
      expect(deps.length).toBe(1);
      expect(deps[0].name).toBe('src/app.js');
    });
  });

  describe('findCrossFileCallTargets', () => {
    it('returns set of IDs called from other files', () => {
      const { repo, ids } = makeRepo();
      const targets = repo.findCrossFileCallTargets('src/foo.js');
      expect(targets.size).toBe(1);
      expect(targets.has(ids.get('foo'))).toBe(true);
    });
  });

  describe('countCrossFileCallers', () => {
    it('counts callers from different files', () => {
      const { repo, ids } = makeRepo();
      expect(repo.countCrossFileCallers(ids.get('foo'), 'src/foo.js')).toBe(2);
    });
  });

  describe('getClassHierarchy', () => {
    it('returns empty set for no extends', () => {
      const { repo, ids } = makeRepo();
      expect(repo.getClassHierarchy(ids.get('Baz')).size).toBe(0);
    });

    it('resolves multi-level hierarchy', () => {
      const { repo, ids } = createTestRepo()
        .cls('Child', 'src/c.js', 1)
        .cls('Parent', 'src/p.js', 1)
        .cls('Grandparent', 'src/g.js', 1)
        .extends('Child', 'Parent')
        .extends('Parent', 'Grandparent')
        .build();
      const ancestors = repo.getClassHierarchy(ids.get('Child'));
      expect(ancestors.size).toBe(2);
      expect(ancestors.has(ids.get('Parent'))).toBe(true);
      expect(ancestors.has(ids.get('Grandparent'))).toBe(true);
    });

    it('handles diamond inheritance', () => {
      const { repo, ids } = createTestRepo()
        .cls('D', 'src/d.js', 1)
        .cls('B1', 'src/b1.js', 1)
        .cls('B2', 'src/b2.js', 1)
        .cls('Top', 'src/top.js', 1)
        .extends('D', 'B1')
        .extends('D', 'B2')
        .extends('B1', 'Top')
        .extends('B2', 'Top')
        .build();
      const ancestors = repo.getClassHierarchy(ids.get('D'));
      expect(ancestors.size).toBe(3);
    });
  });

  describe('findIntraFileCallEdges', () => {
    it('returns intra-file call pairs', () => {
      const { repo } = createTestRepo()
        .fn('a', 'src/f.js', 1)
        .fn('b', 'src/f.js', 10)
        .fn('c', 'src/other.js', 1)
        .calls('a', 'b')
        .calls('a', 'c')
        .build();
      const edges = repo.findIntraFileCallEdges('src/f.js');
      expect(edges.length).toBe(1);
      expect(edges[0]).toEqual({ caller_name: 'a', callee_name: 'b' });
    });
  });

  // ── Graph-read queries ────────────────────────────────────────────

  describe('getCallableNodes', () => {
    it('returns core symbol kind nodes', () => {
      const { repo } = makeRepo();
      const nodes = repo.getCallableNodes();
      // foo, bar, Baz, qux, testFn — all are core kinds
      expect(nodes.length).toBe(5);
    });
  });

  describe('getCallEdges / getImportEdges', () => {
    it('returns call edges', () => {
      const { repo } = makeRepo();
      expect(repo.getCallEdges().length).toBe(2);
    });

    it('returns import edges', () => {
      const { repo } = createTestRepo().file('a.js').file('b.js').imports('a.js', 'b.js').build();
      expect(repo.getImportEdges().length).toBe(1);
    });
  });

  describe('getFileNodesAll', () => {
    it('returns file-kind nodes', () => {
      const { repo } = createTestRepo().file('src/a.js').fn('main', 'src/a.js', 1).build();
      const files = repo.getFileNodesAll();
      expect(files.length).toBe(1);
      expect(files[0].name).toBe('src/a.js');
    });
  });

  // ── Optional table checks ─────────────────────────────────────────

  describe('optional table stubs', () => {
    it('returns false for hasCfgTables, hasEmbeddings, hasDataflowTable', () => {
      const { repo } = makeRepo();
      expect(repo.hasCfgTables()).toBe(false);
      expect(repo.hasEmbeddings()).toBe(false);
      expect(repo.hasDataflowTable()).toBe(false);
    });
  });

  describe('getComplexityForNode', () => {
    it('returns complexity metrics', () => {
      const { repo, ids } = makeRepo();
      const cx = repo.getComplexityForNode(ids.get('foo'));
      expect(cx.cognitive).toBe(5);
      expect(cx.cyclomatic).toBe(3);
      expect(cx.max_nesting).toBe(2);
    });

    it('returns undefined for nodes without complexity', () => {
      const { repo, ids } = makeRepo();
      expect(repo.getComplexityForNode(ids.get('bar'))).toBeUndefined();
    });
  });
});
