/**
 * Interactive HTML viewer tests.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { generatePlotHTML, loadPlotConfig, prepareGraphData } from '../../src/features/viewer.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

function insertNode(db, name, kind, file, line, role) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line, role) VALUES (?, ?, ?, ?, ?)')
    .run(name, kind, file, line, role || null).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, 1.0, 0)',
  ).run(sourceId, targetId, kind);
}

function insertComplexity(db, nodeId, cognitive, cyclomatic, mi) {
  db.prepare(
    'INSERT INTO function_complexity (node_id, cognitive, cyclomatic, max_nesting, maintainability_index) VALUES (?, ?, ?, 2, ?)',
  ).run(nodeId, cognitive, cyclomatic, mi);
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
    expect(html).toContain('var allNodes =');
    expect(html).toContain('var allEdges =');
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
        seedStrategy: 'all',
        seedCount: 30,
        clusterBy: 'none',
        sizeBy: 'uniform',
        overlays: { complexity: false, risk: false },
        riskThresholds: { highBlastRadius: 10, lowMI: 40 },
      },
    });
    expect(html).toContain('<title>My Custom Graph</title>');
    db.close();
  });

  it('handles empty graph without error', () => {
    const db = createTestDb();
    const html = generatePlotHTML(db);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('var allNodes = []');
    expect(html).toContain('var allEdges = []');
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

  it('includes detail panel elements', () => {
    const db = createTestDb();
    const html = generatePlotHTML(db);
    expect(html).toContain('id="detail"');
    expect(html).toContain('id="detailContent"');
    expect(html).toContain('id="detailClose"');
    db.close();
  });

  it('includes new control elements', () => {
    const db = createTestDb();
    const html = generatePlotHTML(db);
    expect(html).toContain('id="colorBySelect"');
    expect(html).toContain('id="sizeBySelect"');
    expect(html).toContain('id="clusterBySelect"');
    expect(html).toContain('id="riskToggle"');
    db.close();
  });
});

describe('prepareGraphData', () => {
  it('embeds complexity data into function-level nodes', () => {
    const db = createTestDb();
    const fnA = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fnB = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, fnA, fnB, 'calls');
    insertComplexity(db, fnA, 8, 5, 72.3);
    insertComplexity(db, fnB, 2, 1, 95.0);

    const data = prepareGraphData(db, { fileLevel: false });
    const nodeA = data.nodes.find((n) => n.label === 'doWork');
    const nodeB = data.nodes.find((n) => n.label === 'helper');

    expect(nodeA.cognitive).toBe(8);
    expect(nodeA.cyclomatic).toBe(5);
    expect(nodeA.maintainabilityIndex).toBeCloseTo(72.3, 1);
    expect(nodeB.cognitive).toBe(2);
    expect(nodeB.cyclomatic).toBe(1);
    expect(nodeB.maintainabilityIndex).toBeCloseTo(95.0, 1);
    db.close();
  });

  it('computes fan-in and fan-out', () => {
    const db = createTestDb();
    const fnA = insertNode(db, 'caller1', 'function', 'src/a.js', 1);
    const fnB = insertNode(db, 'caller2', 'function', 'src/a.js', 10);
    const fnC = insertNode(db, 'target', 'function', 'src/b.js', 1);
    insertEdge(db, fnA, fnC, 'calls');
    insertEdge(db, fnB, fnC, 'calls');

    const data = prepareGraphData(db, { fileLevel: false });
    const target = data.nodes.find((n) => n.label === 'target');
    const caller1 = data.nodes.find((n) => n.label === 'caller1');

    expect(target.fanIn).toBe(2);
    expect(caller1.fanOut).toBe(1);
    db.close();
  });

  it('assigns community IDs via Louvain', () => {
    const db = createTestDb();
    // Create two clusters of nodes
    const a1 = insertNode(db, 'a1', 'function', 'src/a.js', 1);
    const a2 = insertNode(db, 'a2', 'function', 'src/a.js', 10);
    const b1 = insertNode(db, 'b1', 'function', 'src/b.js', 1);
    const b2 = insertNode(db, 'b2', 'function', 'src/b.js', 10);
    insertEdge(db, a1, a2, 'calls');
    insertEdge(db, a2, a1, 'calls');
    insertEdge(db, b1, b2, 'calls');
    insertEdge(db, b2, b1, 'calls');
    // One cross-cluster edge
    insertEdge(db, a1, b1, 'calls');

    const data = prepareGraphData(db, { fileLevel: false });
    for (const n of data.nodes) {
      expect(n.community).not.toBeNull();
      expect(typeof n.community).toBe('number');
    }
    db.close();
  });

  it('flags dead-code nodes as risk', () => {
    const db = createTestDb();
    const fnA = insertNode(db, 'alive', 'function', 'src/a.js', 1, 'core');
    const fnB = insertNode(db, 'dead', 'function', 'src/b.js', 1, 'dead');
    insertEdge(db, fnA, fnB, 'calls');

    const data = prepareGraphData(db, { fileLevel: false });
    const deadNode = data.nodes.find((n) => n.label === 'dead');
    expect(deadNode.risk).toContain('dead-code');

    const aliveNode = data.nodes.find((n) => n.label === 'alive');
    expect(aliveNode.risk).not.toContain('dead-code');
    db.close();
  });

  it('flags high-blast-radius nodes', () => {
    const db = createTestDb();
    const target = insertNode(db, 'popular', 'function', 'src/a.js', 1);
    // Create 10 callers to exceed default threshold
    for (let i = 0; i < 10; i++) {
      const caller = insertNode(db, `caller${i}`, 'function', 'src/c.js', i + 1);
      insertEdge(db, caller, target, 'calls');
    }

    const data = prepareGraphData(db, { fileLevel: false });
    const popularNode = data.nodes.find((n) => n.label === 'popular');
    expect(popularNode.risk).toContain('high-blast-radius');
    expect(popularNode.fanIn).toBe(10);
    db.close();
  });

  it('flags low-mi nodes', () => {
    const db = createTestDb();
    const fnA = insertNode(db, 'messy', 'function', 'src/a.js', 1);
    const fnB = insertNode(db, 'clean', 'function', 'src/b.js', 1);
    insertEdge(db, fnA, fnB, 'calls');
    insertComplexity(db, fnA, 30, 20, 25.0); // MI < 40
    insertComplexity(db, fnB, 2, 1, 90.0); // MI >= 40

    const data = prepareGraphData(db, { fileLevel: false });
    const messy = data.nodes.find((n) => n.label === 'messy');
    const clean = data.nodes.find((n) => n.label === 'clean');
    expect(messy.risk).toContain('low-mi');
    expect(clean.risk).not.toContain('low-mi');
    db.close();
  });

  it('seed strategy top-fanin limits seed count', () => {
    const db = createTestDb();
    const nodes = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(insertNode(db, `fn${i}`, 'function', 'src/a.js', i + 1));
    }
    // fn0 calls all others → they all get fan-in
    for (let i = 1; i < 5; i++) {
      insertEdge(db, nodes[0], nodes[i], 'calls');
    }

    const data = prepareGraphData(db, {
      fileLevel: false,
      config: {
        seedStrategy: 'top-fanin',
        seedCount: 2,
        colorBy: 'kind',
        nodeColors: {},
        roleColors: {},
        filter: { kinds: null, roles: null, files: null },
        edgeStyle: { color: '#666', smooth: true },
        riskThresholds: { highBlastRadius: 10, lowMI: 40 },
        overlays: {},
      },
    });
    expect(data.seedNodeIds).toHaveLength(2);
    db.close();
  });

  it('seed strategy entry selects only entry nodes', () => {
    const db = createTestDb();
    const fnA = insertNode(db, 'entryFn', 'function', 'src/a.js', 1, 'entry');
    const fnB = insertNode(db, 'coreFn', 'function', 'src/b.js', 1, 'core');
    insertEdge(db, fnA, fnB, 'calls');

    const data = prepareGraphData(db, {
      fileLevel: false,
      config: {
        seedStrategy: 'entry',
        seedCount: 30,
        colorBy: 'kind',
        nodeColors: {},
        roleColors: {},
        filter: { kinds: null, roles: null, files: null },
        edgeStyle: { color: '#666', smooth: true },
        riskThresholds: { highBlastRadius: 10, lowMI: 40 },
        overlays: {},
      },
    });
    expect(data.seedNodeIds).toHaveLength(1);
    expect(data.seedNodeIds[0]).toBe(Number(fnA));
    db.close();
  });

  it('seed strategy all (default) includes all nodes', () => {
    const db = createTestDb();
    const fnA = insertNode(db, 'fn1', 'function', 'src/a.js', 1);
    const fnB = insertNode(db, 'fn2', 'function', 'src/b.js', 1);
    insertEdge(db, fnA, fnB, 'calls');

    const data = prepareGraphData(db, { fileLevel: false });
    expect(data.seedNodeIds).toHaveLength(data.nodes.length);
    db.close();
  });

  it('handles empty complexity table gracefully', () => {
    const db = createTestDb();
    const fnA = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fnB = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, fnA, fnB, 'calls');

    const data = prepareGraphData(db, { fileLevel: false });
    const nodeA = data.nodes.find((n) => n.label === 'doWork');
    expect(nodeA.cognitive).toBeNull();
    expect(nodeA.cyclomatic).toBeNull();
    expect(nodeA.maintainabilityIndex).toBeNull();
    db.close();
  });

  it('includes directory field derived from file path', () => {
    const db = createTestDb();
    const fnA = insertNode(db, 'doWork', 'function', 'src/lib/a.js', 5);
    const fnB = insertNode(db, 'helper', 'function', 'src/utils/b.js', 10);
    insertEdge(db, fnA, fnB, 'calls');

    const data = prepareGraphData(db, { fileLevel: false });
    const nodeA = data.nodes.find((n) => n.label === 'doWork');
    const nodeB = data.nodes.find((n) => n.label === 'helper');
    expect(nodeA.directory).toContain('lib');
    expect(nodeB.directory).toContain('utils');
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

  it('includes new config fields with defaults', () => {
    const cfg = loadPlotConfig('/nonexistent/path');
    expect(cfg.seedStrategy).toBe('all');
    expect(cfg.seedCount).toBe(30);
    expect(cfg.clusterBy).toBe('none');
    expect(cfg.sizeBy).toBe('uniform');
    expect(cfg.overlays).toEqual({ complexity: false, risk: false });
    expect(cfg.riskThresholds).toEqual({
      highBlastRadius: 10,
      lowMI: 40,
    });
  });
});
