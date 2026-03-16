import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema } from '../../../src/db/index.js';
import { buildDependencyGraph } from '../../../src/graph/builders/dependency.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

function insertNode(db, name, kind, file, line = 0) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind, confidence = 1.0) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, 0)',
  ).run(sourceId, targetId, kind, confidence);
}

describe('buildDependencyGraph — file-level', () => {
  it('builds graph from file nodes and import edges', () => {
    const db = createTestDb();
    const a = insertNode(db, 'a.js', 'file', 'a.js');
    const b = insertNode(db, 'b.js', 'file', 'b.js');
    const c = insertNode(db, 'c.js', 'file', 'c.js');
    insertEdge(db, a, b, 'imports');
    insertEdge(db, b, c, 'imports-type');

    const graph = buildDependencyGraph(db);
    expect(graph.nodeCount).toBe(3);
    expect(graph.edgeCount).toBe(2);
    expect(graph.hasEdge(String(a), String(b))).toBe(true);
    expect(graph.hasEdge(String(b), String(c))).toBe(true);
    db.close();
  });

  it('excludes test files when noTests is set', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js');
    const t = insertNode(db, 'tests/a.test.js', 'file', 'tests/a.test.js');
    insertEdge(db, t, a, 'imports');

    const graph = buildDependencyGraph(db, { noTests: true });
    expect(graph.nodeCount).toBe(1);
    db.close();
  });

  it('skips self-loops', () => {
    const db = createTestDb();
    const a = insertNode(db, 'a.js', 'file', 'a.js');
    insertEdge(db, a, a, 'imports');

    const graph = buildDependencyGraph(db);
    expect(graph.edgeCount).toBe(0);
    db.close();
  });
});

describe('buildDependencyGraph — function-level', () => {
  it('builds graph from callable nodes and call edges', () => {
    const db = createTestDb();
    insertNode(db, 'a.js', 'file', 'a.js');
    insertNode(db, 'b.js', 'file', 'b.js');
    const fn1 = insertNode(db, 'foo', 'function', 'a.js', 5);
    const fn2 = insertNode(db, 'bar', 'function', 'b.js', 10);
    insertEdge(db, fn1, fn2, 'calls');

    const graph = buildDependencyGraph(db, { fileLevel: false });
    expect(graph.nodeCount).toBe(2);
    expect(graph.edgeCount).toBe(1);
    expect(graph.hasEdge(String(fn1), String(fn2))).toBe(true);
    db.close();
  });

  it('respects minConfidence filter', () => {
    const db = createTestDb();
    const fn1 = insertNode(db, 'foo', 'function', 'a.js', 5);
    const fn2 = insertNode(db, 'bar', 'function', 'b.js', 10);
    const fn3 = insertNode(db, 'baz', 'function', 'c.js', 15);
    insertEdge(db, fn1, fn2, 'calls', 0.9);
    insertEdge(db, fn1, fn3, 'calls', 0.3);

    const graph = buildDependencyGraph(db, { fileLevel: false, minConfidence: 0.5 });
    expect(graph.edgeCount).toBe(1);
    expect(graph.hasEdge(String(fn1), String(fn2))).toBe(true);
    expect(graph.hasEdge(String(fn1), String(fn3))).toBe(false);
    db.close();
  });
});
