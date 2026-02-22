/**
 * Circular dependency detection tests.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../../src/db.js';
import { findCycles, findCyclesJS } from '../../src/cycles.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

function insertNode(db, name, kind, file, line) {
  return db.prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)').run(name, kind, file, line).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind) {
  db.prepare('INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, 1.0, 0)').run(sourceId, targetId, kind);
}

describe('findCycles', () => {
  it('detects no cycles in acyclic graph', () => {
    const db = createTestDb();
    const a = insertNode(db, 'a.js', 'file', 'a.js', 0);
    const b = insertNode(db, 'b.js', 'file', 'b.js', 0);
    const c = insertNode(db, 'c.js', 'file', 'c.js', 0);
    insertEdge(db, a, b, 'imports');
    insertEdge(db, b, c, 'imports');

    const cycles = findCycles(db);
    expect(cycles).toHaveLength(0);
    db.close();
  });

  it('detects a simple 2-node cycle', () => {
    const db = createTestDb();
    const a = insertNode(db, 'a.js', 'file', 'a.js', 0);
    const b = insertNode(db, 'b.js', 'file', 'b.js', 0);
    insertEdge(db, a, b, 'imports');
    insertEdge(db, b, a, 'imports');

    const cycles = findCycles(db);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(2);
    db.close();
  });

  it('detects a 3-node cycle', () => {
    const db = createTestDb();
    const a = insertNode(db, 'a.js', 'file', 'a.js', 0);
    const b = insertNode(db, 'b.js', 'file', 'b.js', 0);
    const c = insertNode(db, 'c.js', 'file', 'c.js', 0);
    insertEdge(db, a, b, 'imports');
    insertEdge(db, b, c, 'imports');
    insertEdge(db, c, a, 'imports');

    const cycles = findCycles(db);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(3);
    db.close();
  });
});

describe('findCyclesJS (pure JS Tarjan)', () => {
  it('detects no cycles in acyclic edges', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    const cycles = findCyclesJS(edges);
    expect(cycles).toHaveLength(0);
  });

  it('detects a 2-node cycle from raw edges', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ];
    const cycles = findCyclesJS(edges);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(2);
  });

  it('detects a 3-node cycle from raw edges', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' },
    ];
    const cycles = findCyclesJS(edges);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(3);
  });
});
