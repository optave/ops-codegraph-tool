import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema } from '../../../src/db.js';
import { buildStructureGraph } from '../../../src/graph/builders/structure.js';

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

function insertEdge(db, sourceId, targetId, kind) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, 1.0, 0)',
  ).run(sourceId, targetId, kind);
}

describe('buildStructureGraph', () => {
  it('builds containment graph from directories and files', () => {
    const db = createTestDb();
    const dir = insertNode(db, 'src', 'directory', 'src');
    const file = insertNode(db, 'src/a.js', 'file', 'src/a.js');
    insertEdge(db, dir, file, 'contains');

    const graph = buildStructureGraph(db);
    expect(graph.nodeCount).toBe(2);
    expect(graph.edgeCount).toBe(1);
    expect(graph.hasEdge(String(dir), String(file))).toBe(true);
    db.close();
  });

  it('returns empty graph for DB with no directories', () => {
    const db = createTestDb();
    insertNode(db, 'a.js', 'file', 'a.js');
    const graph = buildStructureGraph(db);
    expect(graph.nodeCount).toBe(1);
    expect(graph.edgeCount).toBe(0);
    db.close();
  });
});
