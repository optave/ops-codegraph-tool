/**
 * Interactive HTML viewer tests.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema } from '../../src/db.js';
import { generatePlotHTML, loadPlotConfig } from '../../src/viewer.js';

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

describe('generatePlotHTML', () => {
  it('returns a valid HTML document', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertEdge(db, a, b, 'imports');

    const html = generatePlotHTML(db);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    db.close();
  });

  it('embeds graph data as JSON', () => {
    const db = createTestDb();
    const a = insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    const b = insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertEdge(db, a, b, 'imports');

    const html = generatePlotHTML(db);
    expect(html).toContain('var graphNodes =');
    expect(html).toContain('var graphEdges =');
    expect(html).toContain('a.js');
    expect(html).toContain('b.js');
    db.close();
  });

  it('includes vis-network CDN script', () => {
    const db = createTestDb();
    const html = generatePlotHTML(db);
    expect(html).toContain('vis-network');
    expect(html).toContain('unpkg.com');
    db.close();
  });

  it('applies custom config title', () => {
    const db = createTestDb();
    const html = generatePlotHTML(db, {
      config: {
        title: 'My Custom Graph',
        layout: { algorithm: 'hierarchical', direction: 'LR' },
        physics: { enabled: true, nodeDistance: 150 },
        nodeColors: {},
        roleColors: {},
        colorBy: 'kind',
        edgeStyle: { color: '#666', smooth: true },
        filter: { kinds: null, roles: null, files: null },
      },
    });
    expect(html).toContain('<title>My Custom Graph</title>');
    db.close();
  });

  it('handles empty graph without error', () => {
    const db = createTestDb();
    const html = generatePlotHTML(db);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('var graphNodes = []');
    expect(html).toContain('var graphEdges = []');
    db.close();
  });

  it('supports function-level mode', () => {
    const db = createTestDb();
    const fnA = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fnB = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, fnA, fnB, 'calls');

    const html = generatePlotHTML(db, { fileLevel: false });
    expect(html).toContain('doWork');
    expect(html).toContain('helper');
    db.close();
  });
});

describe('loadPlotConfig', () => {
  it('returns default config when no config file exists', () => {
    const cfg = loadPlotConfig('/nonexistent/path');
    expect(cfg).toHaveProperty('layout');
    expect(cfg).toHaveProperty('physics');
    expect(cfg).toHaveProperty('nodeColors');
    expect(cfg.layout.algorithm).toBe('hierarchical');
    expect(cfg.title).toBe('Codegraph');
  });
});
