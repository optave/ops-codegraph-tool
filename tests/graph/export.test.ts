/**
 * Graph export tests.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import {
  exportDOT,
  exportGraphML,
  exportGraphSON,
  exportJSON,
  exportMermaid,
  exportNeo4jCSV,
} from '../../src/features/export.js';

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

describe('exportGraphML', () => {
  it('generates valid XML wrapper with graphml element', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertEdge(db, a, b, 'imports');

    const xml = exportGraphML(db);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<graphml');
    expect(xml).toContain('</graphml>');
    db.close();
  });

  it('declares key elements for node and edge attributes', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertEdge(db, a, b, 'imports');

    const xml = exportGraphML(db);
    expect(xml).toContain('<key id="d0"');
    expect(xml).toContain('attr.name="name"');
    db.close();
  });

  it('emits node and edge data elements', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertEdge(db, a, b, 'imports');

    const xml = exportGraphML(db);
    expect(xml).toContain('<node id=');
    expect(xml).toContain('<edge id=');
    expect(xml).toContain('<data key=');
    db.close();
  });

  it('supports function-level mode', () => {
    const db = createTestDb();
    const fnA = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fnB = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, fnA, fnB, 'calls');

    const xml = exportGraphML(db, { fileLevel: false });
    expect(xml).toContain('doWork');
    expect(xml).toContain('helper');
    expect(xml).toContain('attr.name="kind"');
    expect(xml).toContain('attr.name="line"');
    db.close();
  });

  it('produces valid output for empty graph', () => {
    const db = createTestDb();
    const xml = exportGraphML(db);
    expect(xml).toContain('<graphml');
    expect(xml).toContain('<graph id="codegraph"');
    expect(xml).toContain('</graph>');
    expect(xml).toContain('</graphml>');
    db.close();
  });

  it('escapes XML special characters', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/<a>.js', 'file', 'src/<a>.js', 0);
    const b = insertNode(db, 'src/b&c.js', 'file', 'src/b&c.js', 0);
    insertEdge(db, a, b, 'imports');

    const xml = exportGraphML(db);
    expect(xml).toContain('&lt;a&gt;');
    expect(xml).toContain('b&amp;c');
    expect(xml).not.toContain('<a>');
    db.close();
  });
});

describe('exportGraphSON', () => {
  it('returns TinkerPop structure with vertices and edges', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertEdge(db, a, b, 'imports');

    const data = exportGraphSON(db);
    expect(data).toHaveProperty('vertices');
    expect(data).toHaveProperty('edges');
    expect(data.vertices.length).toBeGreaterThanOrEqual(2);
    db.close();
  });

  it('uses multi-valued property format', () => {
    const db = createTestDb();
    const fn = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fn2 = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, fn, fn2, 'calls');

    const data = exportGraphSON(db);
    const vertex = data.vertices.find((v) => v.properties.name[0].value === 'doWork');
    expect(vertex).toBeDefined();
    expect(vertex.properties.name).toEqual([{ id: 0, value: 'doWork' }]);
    expect(vertex.label).toBe('function');
    db.close();
  });

  it('has inV and outV on edges', () => {
    const db = createTestDb();
    const fn = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fn2 = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, fn, fn2, 'calls');

    const data = exportGraphSON(db);
    expect(data.edges.length).toBeGreaterThanOrEqual(1);
    const edge = data.edges[0];
    expect(edge).toHaveProperty('inV');
    expect(edge).toHaveProperty('outV');
    expect(edge).toHaveProperty('label');
    expect(edge).toHaveProperty('properties');
    db.close();
  });

  it('includes confidence in edge properties', () => {
    const db = createTestDb();
    const fn = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fn2 = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, fn, fn2, 'calls');

    const data = exportGraphSON(db);
    const edge = data.edges[0];
    expect(edge.properties).toHaveProperty('confidence');
    expect(edge.properties.confidence).toBe(1.0);
    db.close();
  });
});

describe('exportNeo4jCSV', () => {
  it('returns object with nodes and relationships strings', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertEdge(db, a, b, 'imports');

    const csv = exportNeo4jCSV(db);
    expect(csv).toHaveProperty('nodes');
    expect(csv).toHaveProperty('relationships');
    expect(typeof csv.nodes).toBe('string');
    expect(typeof csv.relationships).toBe('string');
    db.close();
  });

  it('has correct CSV headers for file-level', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertEdge(db, a, b, 'imports');

    const csv = exportNeo4jCSV(db);
    expect(csv.nodes.split('\n')[0]).toBe('nodeId:ID,name,file:string,:LABEL');
    expect(csv.relationships.split('\n')[0]).toBe(':START_ID,:END_ID,:TYPE,confidence:float');
    db.close();
  });

  it('capitalizes kind to Label for function-level', () => {
    const db = createTestDb();
    const fnA = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fnB = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, fnA, fnB, 'calls');

    const csv = exportNeo4jCSV(db, { fileLevel: false });
    expect(csv.nodes).toContain(',Function');
    db.close();
  });

  it('uppercases edge type and replaces hyphens', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertEdge(db, a, b, 'imports-type');

    const csv = exportNeo4jCSV(db);
    expect(csv.relationships).toContain('IMPORTS_TYPE');
    db.close();
  });

  it('has correct function-level CSV headers', () => {
    const db = createTestDb();
    const fnA = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fnB = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, fnA, fnB, 'calls');

    const csv = exportNeo4jCSV(db, { fileLevel: false });
    expect(csv.nodes.split('\n')[0]).toBe('nodeId:ID,name,kind,file:string,line:int,role,:LABEL');
    db.close();
  });
});
