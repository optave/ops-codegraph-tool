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
  it('generates valid Mermaid syntax with flowchart LR default', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertEdge(db, a, b, 'imports');

    const mermaid = exportMermaid(db);
    expect(mermaid).toContain('flowchart LR');
    expect(mermaid).toContain('-->');
    db.close();
  });

  it('uses custom direction option', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertEdge(db, a, b, 'imports');

    const mermaid = exportMermaid(db, { direction: 'TB' });
    expect(mermaid).toContain('flowchart TB');
    db.close();
  });

  it('groups files into directory subgraphs', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'lib/b.js', 'file', 'lib/b.js', 0);
    insertEdge(db, a, b, 'imports');

    const mermaid = exportMermaid(db);
    expect(mermaid).toContain('subgraph');
    expect(mermaid).toContain('"src"');
    expect(mermaid).toContain('"lib"');
    expect(mermaid).toContain('end');
    db.close();
  });

  it('adds edge labels from edge kind', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertEdge(db, a, b, 'imports');

    const mermaid = exportMermaid(db);
    expect(mermaid).toContain('-->|imports|');
    db.close();
  });

  it('collapses imports-type to imports label', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertEdge(db, a, b, 'imports-type');

    const mermaid = exportMermaid(db);
    expect(mermaid).toContain('-->|imports|');
    expect(mermaid).not.toContain('imports-type');
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
    expect(mermaid).toContain('flowchart LR');
    expect(mermaid).toContain('doWork');
    expect(mermaid).toContain('helper');
    expect(mermaid).toContain('-->');
    db.close();
  });

  it('uses stadium shape for functions', () => {
    const db = createTestDb();
    const fnA = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fnB = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, fnA, fnB, 'calls');

    const mermaid = exportMermaid(db, { fileLevel: false });
    expect(mermaid).toContain('(["doWork"])');
    expect(mermaid).toContain('(["helper"])');
    db.close();
  });

  it('uses hexagon shape for classes', () => {
    const db = createTestDb();
    const cls = insertNode(db, 'MyClass', 'class', 'src/a.js', 5);
    const fn = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, cls, fn, 'calls');

    const mermaid = exportMermaid(db, { fileLevel: false });
    expect(mermaid).toContain('{{"MyClass"}}');
    db.close();
  });

  it('uses subroutine shape for modules', () => {
    const db = createTestDb();
    const mod = insertNode(db, 'MyModule', 'module', 'src/a.js', 5);
    const fn = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, mod, fn, 'calls');

    const mermaid = exportMermaid(db, { fileLevel: false });
    expect(mermaid).toContain('[["MyModule"]]');
    db.close();
  });

  it('adds edge labels for calls', () => {
    const db = createTestDb();
    const fnA = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fnB = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, fnA, fnB, 'calls');

    const mermaid = exportMermaid(db, { fileLevel: false });
    expect(mermaid).toContain('-->|calls|');
    db.close();
  });

  it('groups functions by file into subgraphs', () => {
    const db = createTestDb();
    const fnA = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fnB = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, fnA, fnB, 'calls');

    const mermaid = exportMermaid(db, { fileLevel: false });
    expect(mermaid).toContain('subgraph');
    expect(mermaid).toContain('"src/a.js"');
    expect(mermaid).toContain('"src/b.js"');
    expect(mermaid).toContain('end');
    db.close();
  });

  it('applies role styling', () => {
    const db = createTestDb();
    const fnA = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fnB = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    // Add role to the nodes
    db.prepare('UPDATE nodes SET role = ? WHERE id = ?').run('entry', fnA);
    db.prepare('UPDATE nodes SET role = ? WHERE id = ?').run('utility', fnB);
    insertEdge(db, fnA, fnB, 'calls');

    const mermaid = exportMermaid(db, { fileLevel: false });
    expect(mermaid).toContain('fill:#e8f5e9,stroke:#4caf50');
    expect(mermaid).toContain('fill:#f5f5f5,stroke:#9e9e9e');
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
