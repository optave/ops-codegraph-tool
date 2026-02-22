/**
 * Graph export tests.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema } from '../../src/db.js';
import { exportDOT, exportJSON, exportMermaid } from '../../src/export.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

function insertNode(db, name, kind, file, line) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, 1.0, 0)',
  ).run(sourceId, targetId, kind);
}

describe('exportDOT', () => {
  it('generates valid DOT syntax', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertEdge(db, a, b, 'imports');

    const dot = exportDOT(db);
    expect(dot).toContain('digraph codegraph');
    expect(dot).toContain('src/a.js');
    expect(dot).toContain('src/b.js');
    expect(dot).toContain('->');
    db.close();
  });
});

describe('exportMermaid', () => {
  it('generates valid Mermaid syntax', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertEdge(db, a, b, 'imports');

    const mermaid = exportMermaid(db);
    expect(mermaid).toContain('graph LR');
    expect(mermaid).toContain('-->');
    db.close();
  });
});

describe('exportDOT — function-level', () => {
  it('generates function-level DOT with fileLevel: false', () => {
    const db = createTestDb();
    insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    const fnA = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fnB = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, fnA, fnB, 'calls');

    const dot = exportDOT(db, { fileLevel: false });
    expect(dot).toContain('digraph codegraph');
    expect(dot).toContain('doWork');
    expect(dot).toContain('helper');
    expect(dot).toContain('->');
    db.close();
  });

  it('generates multi-directory subgraph clusters', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'lib/b.js', 'file', 'lib/b.js', 0);
    insertEdge(db, a, b, 'imports');

    const dot = exportDOT(db);
    expect(dot).toContain('cluster_');
    expect(dot).toContain('label="src"');
    expect(dot).toContain('label="lib"');
    db.close();
  });
});

describe('exportDOT — empty graph', () => {
  it('produces minimal DOT for empty graph', () => {
    const db = createTestDb();
    const dot = exportDOT(db);
    expect(dot).toContain('digraph codegraph');
    expect(dot).toContain('}');
    db.close();
  });
});

describe('exportMermaid — function-level', () => {
  it('generates function-level Mermaid with fileLevel: false', () => {
    const db = createTestDb();
    insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    const fnA = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fnB = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, fnA, fnB, 'calls');

    const mermaid = exportMermaid(db, { fileLevel: false });
    expect(mermaid).toContain('graph LR');
    expect(mermaid).toContain('doWork');
    expect(mermaid).toContain('helper');
    expect(mermaid).toContain('-->');
    db.close();
  });
});

describe('exportJSON', () => {
  it('returns structured data', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertEdge(db, a, b, 'imports');

    const data = exportJSON(db);
    expect(data).toHaveProperty('nodes');
    expect(data).toHaveProperty('edges');
    expect(data.nodes.length).toBeGreaterThanOrEqual(2);
    expect(data.edges.length).toBeGreaterThanOrEqual(1);
    db.close();
  });
});
