import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema } from '../../../src/db/index.js';
import { InMemoryRepository } from '../../../src/db/repository/in-memory-repository.js';
import { buildDependencyGraph } from '../../../src/graph/builders/dependency.js';
import { createTestRepo } from '../../helpers/fixtures.js';

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

// ── InMemoryRepository dispatch path ────────────────────────────────────────

describe('buildDependencyGraph — file-level via InMemoryRepository', () => {
  it('builds graph from file nodes and import edges', () => {
    const { repo, ids } = createTestRepo()
      .file('a.js')
      .file('b.js')
      .file('c.js')
      .imports('a.js', 'b.js')
      .imports('b.js', 'c.js')
      .build();

    const graph = buildDependencyGraph(repo);
    expect(graph.nodeCount).toBe(3);
    expect(graph.edgeCount).toBe(2);
    expect(graph.hasEdge(String(ids.get('a.js')), String(ids.get('b.js')))).toBe(true);
    expect(graph.hasEdge(String(ids.get('b.js')), String(ids.get('c.js')))).toBe(true);
  });

  it('excludes test files when noTests is set', () => {
    const { repo } = createTestRepo()
      .file('src/a.js')
      .file('tests/a.test.js')
      .imports('tests/a.test.js', 'src/a.js')
      .build();

    const graph = buildDependencyGraph(repo, { noTests: true });
    expect(graph.nodeCount).toBe(1);
  });

  it('skips self-loops', () => {
    const repo = new InMemoryRepository();
    const a = repo.addNode({ name: 'a.js', kind: 'file', file: 'a.js', line: 0 });
    repo.addEdge({ source_id: a, target_id: a, kind: 'imports' });

    const graph = buildDependencyGraph(repo);
    expect(graph.edgeCount).toBe(0);
  });
});

describe('buildDependencyGraph — function-level via InMemoryRepository', () => {
  it('builds graph from callable nodes and call edges', () => {
    const { repo, ids } = createTestRepo()
      .fn('foo', 'a.js', 5)
      .fn('bar', 'b.js', 10)
      .calls('foo', 'bar')
      .build();

    const graph = buildDependencyGraph(repo, { fileLevel: false });
    expect(graph.nodeCount).toBe(2);
    expect(graph.edgeCount).toBe(1);
    expect(graph.hasEdge(String(ids.get('foo')), String(ids.get('bar')))).toBe(true);
  });

  it('respects minConfidence filter', () => {
    const repo = new InMemoryRepository();
    const fn1 = repo.addNode({ name: 'foo', kind: 'function', file: 'a.js', line: 5 });
    const fn2 = repo.addNode({ name: 'bar', kind: 'function', file: 'b.js', line: 10 });
    const fn3 = repo.addNode({ name: 'baz', kind: 'function', file: 'c.js', line: 15 });
    repo.addEdge({ source_id: fn1, target_id: fn2, kind: 'calls', confidence: 0.9 });
    repo.addEdge({ source_id: fn1, target_id: fn3, kind: 'calls', confidence: 0.3 });

    const graph = buildDependencyGraph(repo, { fileLevel: false, minConfidence: 0.5 });
    expect(graph.edgeCount).toBe(1);
    expect(graph.hasEdge(String(fn1), String(fn2))).toBe(true);
    expect(graph.hasEdge(String(fn1), String(fn3))).toBe(false);
  });

  it('returns all call edges when minConfidence is omitted', () => {
    const repo = new InMemoryRepository();
    const fn1 = repo.addNode({ name: 'foo', kind: 'function', file: 'a.js', line: 5 });
    const fn2 = repo.addNode({ name: 'bar', kind: 'function', file: 'b.js', line: 10 });
    repo.addEdge({ source_id: fn1, target_id: fn2, kind: 'calls', confidence: 0.1 });

    const graph = buildDependencyGraph(repo, { fileLevel: false });
    expect(graph.edgeCount).toBe(1);
  });
});
