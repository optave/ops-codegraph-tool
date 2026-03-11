import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSchema } from '../../src/db/migrations.js';
import { getClassHierarchy } from '../../src/db/repository/edges.js';
import {
  countEdges,
  countFiles,
  countNodes,
  findNodesForTriage,
  findNodesWithFanIn,
  iterateFunctionNodes,
  listFunctionNodes,
} from '../../src/db/repository/nodes.js';

describe('repository', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);

    const insertNode = db.prepare(
      'INSERT INTO nodes (name, kind, file, line, role) VALUES (?, ?, ?, ?, ?)',
    );
    insertNode.run('foo', 'function', 'src/foo.js', 1, 'core');
    insertNode.run('bar', 'method', 'src/bar.js', 10, 'utility');
    insertNode.run('Baz', 'class', 'src/baz.js', 20, 'entry');
    insertNode.run('qux', 'interface', 'src/qux.js', 30, null);
    insertNode.run('testFn', 'function', 'tests/foo.test.js', 1, null);

    // Edges
    const fooId = db.prepare("SELECT id FROM nodes WHERE name = 'foo'").get().id;
    const barId = db.prepare("SELECT id FROM nodes WHERE name = 'bar'").get().id;
    const bazId = db.prepare("SELECT id FROM nodes WHERE name = 'Baz'").get().id;
    db.prepare('INSERT INTO edges (source_id, target_id, kind) VALUES (?, ?, ?)').run(
      barId,
      fooId,
      'calls',
    );
    db.prepare('INSERT INTO edges (source_id, target_id, kind) VALUES (?, ?, ?)').run(
      bazId,
      fooId,
      'calls',
    );

    // Complexity
    db.prepare(
      'INSERT INTO function_complexity (node_id, cognitive, cyclomatic, max_nesting) VALUES (?, ?, ?, ?)',
    ).run(fooId, 5, 3, 2);
  });

  afterEach(() => {
    db.close();
  });

  describe('findNodesWithFanIn', () => {
    it('returns nodes with fan-in count', () => {
      const rows = findNodesWithFanIn(db, '%foo%');
      const foo = rows.find((r) => r.name === 'foo');
      expect(foo).toBeDefined();
      expect(foo.fan_in).toBe(2);
    });

    it('filters by kinds', () => {
      const rows = findNodesWithFanIn(db, '%foo%', { kinds: ['method'] });
      expect(rows.length).toBe(0);
    });

    it('filters by file', () => {
      const rows = findNodesWithFanIn(db, '%foo%', { file: 'src' });
      expect(rows.every((r) => r.file.includes('src'))).toBe(true);
    });
  });

  describe('findNodesForTriage', () => {
    it('returns function/method/class nodes with signals', () => {
      const rows = findNodesForTriage(db);
      expect(rows.length).toBe(4); // foo, bar, Baz, testFn
      const foo = rows.find((r) => r.name === 'foo');
      expect(foo.fan_in).toBe(2);
      expect(foo.cognitive).toBe(5);
    });

    it('excludes test files when noTests is set', () => {
      const rows = findNodesForTriage(db, { noTests: true });
      expect(rows.every((r) => !r.file.includes('.test.'))).toBe(true);
    });

    it('filters by kind', () => {
      const rows = findNodesForTriage(db, { kind: 'class' });
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe('Baz');
    });

    it('filters by role', () => {
      const rows = findNodesForTriage(db, { role: 'core' });
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe('foo');
    });

    it('filters by file', () => {
      const rows = findNodesForTriage(db, { file: 'bar' });
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe('bar');
    });

    it('throws on invalid role', () => {
      expect(() => findNodesForTriage(db, { role: 'supervisor' })).toThrow('Invalid role');
    });
  });

  describe('listFunctionNodes', () => {
    it('returns function/method/class nodes', () => {
      const rows = listFunctionNodes(db);
      expect(rows.length).toBe(4); // foo, bar, Baz, testFn
      expect(rows.every((r) => ['function', 'method', 'class'].includes(r.kind))).toBe(true);
    });

    it('filters by file', () => {
      const rows = listFunctionNodes(db, { file: 'foo' });
      expect(rows.every((r) => r.file.includes('foo'))).toBe(true);
    });

    it('filters by pattern', () => {
      const rows = listFunctionNodes(db, { pattern: 'Baz' });
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe('Baz');
    });

    it('excludes test files when noTests is set', () => {
      const rows = listFunctionNodes(db, { noTests: true });
      expect(rows.every((r) => !r.file.includes('.test.'))).toBe(true);
      expect(rows.length).toBe(3); // foo, bar, Baz — excludes testFn
    });

    it('orders by file, line', () => {
      const rows = listFunctionNodes(db);
      for (let i = 1; i < rows.length; i++) {
        const prev = `${rows[i - 1].file}:${String(rows[i - 1].line).padStart(6, '0')}`;
        const curr = `${rows[i].file}:${String(rows[i].line).padStart(6, '0')}`;
        expect(prev <= curr).toBe(true);
      }
    });
  });

  describe('iterateFunctionNodes', () => {
    it('returns an iterator over function nodes', () => {
      const iter = iterateFunctionNodes(db);
      const rows = [...iter];
      expect(rows.length).toBe(4);
      expect(rows.every((r) => ['function', 'method', 'class'].includes(r.kind))).toBe(true);
    });

    it('filters by file and pattern', () => {
      const rows = [...iterateFunctionNodes(db, { file: 'foo', pattern: 'foo' })];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.file.includes('foo'))).toBe(true);
    });

    it('excludes test files when noTests is set', () => {
      const rows = [...iterateFunctionNodes(db, { noTests: true })];
      expect(rows.every((r) => !r.file.includes('.test.'))).toBe(true);
      expect(rows.length).toBe(3);
    });
  });

  describe('getClassHierarchy', () => {
    it('returns empty set for node with no extends edges', () => {
      const fooId = db.prepare("SELECT id FROM nodes WHERE name = 'foo'").get().id;
      const ancestors = getClassHierarchy(db, fooId);
      expect(ancestors.size).toBe(0);
    });

    it('resolves single-level class hierarchy', () => {
      // Create Parent class and extends edge: Baz -> Parent
      const insertNode = db.prepare(
        'INSERT INTO nodes (name, kind, file, line, role) VALUES (?, ?, ?, ?, ?)',
      );
      insertNode.run('Parent', 'class', 'src/parent.js', 1, null);

      const bazId = db.prepare("SELECT id FROM nodes WHERE name = 'Baz'").get().id;
      const parentId = db.prepare("SELECT id FROM nodes WHERE name = 'Parent'").get().id;
      db.prepare('INSERT INTO edges (source_id, target_id, kind) VALUES (?, ?, ?)').run(
        bazId,
        parentId,
        'extends',
      );

      const ancestors = getClassHierarchy(db, bazId);
      expect(ancestors.size).toBe(1);
      expect(ancestors.has(parentId)).toBe(true);
    });

    it('resolves multi-level class hierarchy', () => {
      const insertNode = db.prepare(
        'INSERT INTO nodes (name, kind, file, line, role) VALUES (?, ?, ?, ?, ?)',
      );
      insertNode.run('Parent', 'class', 'src/parent.js', 1, null);
      insertNode.run('Grandparent', 'class', 'src/grandparent.js', 1, null);

      const bazId = db.prepare("SELECT id FROM nodes WHERE name = 'Baz'").get().id;
      const parentId = db.prepare("SELECT id FROM nodes WHERE name = 'Parent'").get().id;
      const grandparentId = db.prepare("SELECT id FROM nodes WHERE name = 'Grandparent'").get().id;

      const insertEdge = db.prepare(
        'INSERT INTO edges (source_id, target_id, kind) VALUES (?, ?, ?)',
      );
      insertEdge.run(bazId, parentId, 'extends');
      insertEdge.run(parentId, grandparentId, 'extends');

      const ancestors = getClassHierarchy(db, bazId);
      expect(ancestors.size).toBe(2);
      expect(ancestors.has(parentId)).toBe(true);
      expect(ancestors.has(grandparentId)).toBe(true);
    });

    it('handles diamond inheritance without infinite loops', () => {
      const insertNode = db.prepare(
        'INSERT INTO nodes (name, kind, file, line, role) VALUES (?, ?, ?, ?, ?)',
      );
      insertNode.run('A', 'class', 'src/a.js', 1, null);
      insertNode.run('B', 'class', 'src/b.js', 1, null);
      insertNode.run('Top', 'class', 'src/top.js', 1, null);

      const bazId = db.prepare("SELECT id FROM nodes WHERE name = 'Baz'").get().id;
      const aId = db.prepare("SELECT id FROM nodes WHERE name = 'A'").get().id;
      const bId = db.prepare("SELECT id FROM nodes WHERE name = 'B'").get().id;
      const topId = db.prepare("SELECT id FROM nodes WHERE name = 'Top'").get().id;

      const insertEdge = db.prepare(
        'INSERT INTO edges (source_id, target_id, kind) VALUES (?, ?, ?)',
      );
      // Baz -> A, Baz -> B, A -> Top, B -> Top
      insertEdge.run(bazId, aId, 'extends');
      insertEdge.run(bazId, bId, 'extends');
      insertEdge.run(aId, topId, 'extends');
      insertEdge.run(bId, topId, 'extends');

      const ancestors = getClassHierarchy(db, bazId);
      expect(ancestors.size).toBe(3); // A, B, Top
      expect(ancestors.has(aId)).toBe(true);
      expect(ancestors.has(bId)).toBe(true);
      expect(ancestors.has(topId)).toBe(true);
    });
  });

  describe('countNodes / countEdges / countFiles', () => {
    it('countNodes returns total', () => {
      expect(countNodes(db)).toBe(5);
    });

    it('countEdges returns total', () => {
      expect(countEdges(db)).toBe(2);
    });

    it('countFiles returns distinct file count', () => {
      expect(countFiles(db)).toBe(5);
    });
  });
});
