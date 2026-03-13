import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema } from '../../../src/db.js';
import { buildTemporalGraph } from '../../../src/graph/builders/temporal.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

describe('buildTemporalGraph', () => {
  it('returns empty graph when co_changes table has no rows', () => {
    const db = createTestDb();
    // initSchema creates co_changes; just leave it empty
    const graph = buildTemporalGraph(db);
    expect(graph.nodeCount).toBe(0);
    expect(graph.directed).toBe(false);
    db.close();
  });

  it('builds undirected graph from co_changes table', () => {
    const db = createTestDb();
    db.exec(`
      INSERT INTO co_changes (file_a, file_b, commit_count, jaccard) VALUES ('a.js', 'b.js', 5, 0.8);
      INSERT INTO co_changes (file_a, file_b, commit_count, jaccard) VALUES ('b.js', 'c.js', 2, 0.3);
    `);

    const graph = buildTemporalGraph(db);
    expect(graph.nodeCount).toBe(3);
    expect(graph.hasEdge('a.js', 'b.js')).toBe(true);
    expect(graph.hasEdge('b.js', 'a.js')).toBe(true); // undirected
    db.close();
  });

  it('filters by minJaccard', () => {
    const db = createTestDb();
    db.exec(`
      INSERT INTO co_changes (file_a, file_b, commit_count, jaccard) VALUES ('a.js', 'b.js', 5, 0.8);
      INSERT INTO co_changes (file_a, file_b, commit_count, jaccard) VALUES ('b.js', 'c.js', 2, 0.3);
    `);

    const graph = buildTemporalGraph(db, { minJaccard: 0.5 });
    expect([...graph.edges()]).toHaveLength(1);
    expect(graph.hasEdge('a.js', 'b.js')).toBe(true);
    expect(graph.hasEdge('b.js', 'c.js')).toBe(false);
    db.close();
  });
});
