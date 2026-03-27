/**
 * Unit tests for src/structure.js
 *
 * Tests buildStructure metrics computation and query functions
 * using an in-memory SQLite database.
 */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { buildStructure } from '../../src/features/structure.js';

let db: any;

function setup() {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

function insertFileNode(name, file) {
  db.prepare(
    'INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
  ).run(name, 'file', file, 0, null);
}

function insertImportEdge(sourceFile, targetFile) {
  const src = db
    .prepare('SELECT id FROM nodes WHERE name = ? AND kind = ?')
    .get(sourceFile, 'file');
  const tgt = db
    .prepare('SELECT id FROM nodes WHERE name = ? AND kind = ?')
    .get(targetFile, 'file');
  if (src && tgt) {
    db.prepare(
      'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)',
    ).run(src.id, tgt.id, 'imports', 1.0, 0);
  }
}

describe('buildStructure', () => {
  beforeEach(() => {
    setup();
  });

  it('creates directory nodes and contains edges', () => {
    // Set up: two files in src/
    insertFileNode('src/a.js', 'src/a.js');
    insertFileNode('src/b.js', 'src/b.js');

    const fileSymbols = new Map([
      [
        'src/a.js',
        {
          definitions: [{ name: 'foo', kind: 'function', line: 1 }],
          imports: [],
          exports: [],
          calls: [],
        },
      ],
      [
        'src/b.js',
        {
          definitions: [{ name: 'bar', kind: 'function', line: 1 }],
          imports: [],
          exports: [],
          calls: [],
        },
      ],
    ]);
    const lineCountMap = new Map([
      ['src/a.js', 10],
      ['src/b.js', 20],
    ]);
    const directories = new Set(['src']);

    buildStructure(db, fileSymbols, '/root', lineCountMap, directories);

    // Check directory node was created
    const dirNode = db
      .prepare("SELECT * FROM nodes WHERE kind = 'directory' AND name = 'src'")
      .get();
    expect(dirNode).toBeDefined();

    // Check contains edges exist
    const containsEdges = db
      .prepare("SELECT COUNT(*) as c FROM edges WHERE kind = 'contains'")
      .get();
    expect(containsEdges.c).toBeGreaterThanOrEqual(2); // src -> a.js, src -> b.js
  });

  it('computes per-file metrics', () => {
    insertFileNode('src/a.js', 'src/a.js');
    insertFileNode('src/b.js', 'src/b.js');
    insertImportEdge('src/b.js', 'src/a.js');

    const fileSymbols = new Map([
      [
        'src/a.js',
        {
          definitions: [
            { name: 'foo', kind: 'function', line: 1 },
            { name: 'bar', kind: 'function', line: 5 },
          ],
          imports: [],
          exports: [{ name: 'foo', kind: 'function', line: 1 }],
          calls: [],
        },
      ],
      [
        'src/b.js',
        {
          definitions: [{ name: 'baz', kind: 'function', line: 1 }],
          imports: [{ source: './a.js', names: ['foo'] }],
          exports: [],
          calls: [],
        },
      ],
    ]);
    const lineCountMap = new Map([
      ['src/a.js', 10],
      ['src/b.js', 5],
    ]);

    buildStructure(db, fileSymbols, '/root', lineCountMap, new Set(['src']));

    // Check file metrics
    const aNode = db
      .prepare("SELECT id FROM nodes WHERE name = 'src/a.js' AND kind = 'file'")
      .get();
    const aMetrics = db.prepare('SELECT * FROM node_metrics WHERE node_id = ?').get(aNode.id);
    expect(aMetrics.line_count).toBe(10);
    expect(aMetrics.symbol_count).toBe(2);
    expect(aMetrics.fan_in).toBe(1); // b.js imports a.js
    expect(aMetrics.export_count).toBe(1);

    const bNode = db
      .prepare("SELECT id FROM nodes WHERE name = 'src/b.js' AND kind = 'file'")
      .get();
    const bMetrics = db.prepare('SELECT * FROM node_metrics WHERE node_id = ?').get(bNode.id);
    expect(bMetrics.fan_out).toBe(1); // b.js imports a.js
    expect(bMetrics.import_count).toBe(1);
  });

  it('computes directory cohesion', () => {
    // Set up: src/a.js imports src/b.js (intra), lib/c.js imports src/a.js (cross)
    insertFileNode('src/a.js', 'src/a.js');
    insertFileNode('src/b.js', 'src/b.js');
    insertFileNode('lib/c.js', 'lib/c.js');
    insertImportEdge('src/a.js', 'src/b.js'); // intra-src edge
    insertImportEdge('lib/c.js', 'src/a.js'); // cross edge (lib -> src)

    const fileSymbols = new Map([
      [
        'src/a.js',
        { definitions: [], imports: [{ source: './b.js', names: [] }], exports: [], calls: [] },
      ],
      ['src/b.js', { definitions: [], imports: [], exports: [], calls: [] }],
      [
        'lib/c.js',
        {
          definitions: [],
          imports: [{ source: '../src/a.js', names: [] }],
          exports: [],
          calls: [],
        },
      ],
    ]);
    const lineCountMap = new Map([
      ['src/a.js', 5],
      ['src/b.js', 5],
      ['lib/c.js', 5],
    ]);

    buildStructure(db, fileSymbols, '/root', lineCountMap, new Set(['src', 'lib']));

    // src directory has 1 intra edge (a->b) and 1 cross edge (c->a)
    // cohesion = 1 / (1 + 1) = 0.5
    const srcDir = db
      .prepare("SELECT id FROM nodes WHERE kind = 'directory' AND name = 'src'")
      .get();
    const srcMetrics = db.prepare('SELECT * FROM node_metrics WHERE node_id = ?').get(srcDir.id);
    expect(srcMetrics.cohesion).toBeCloseTo(0.5);
  });

  it('deduplicates definitions in symbol count', () => {
    insertFileNode('src/a.js', 'src/a.js');

    const fileSymbols = new Map([
      [
        'src/a.js',
        {
          definitions: [
            { name: 'foo', kind: 'function', line: 1 },
            { name: 'foo', kind: 'function', line: 1 }, // duplicate
            { name: 'bar', kind: 'function', line: 5 },
          ],
          imports: [],
          exports: [],
          calls: [],
        },
      ],
    ]);
    const lineCountMap = new Map([['src/a.js', 10]]);

    buildStructure(db, fileSymbols, '/root', lineCountMap, new Set(['src']));

    const aNode = db
      .prepare("SELECT id FROM nodes WHERE name = 'src/a.js' AND kind = 'file'")
      .get();
    const metrics = db.prepare('SELECT * FROM node_metrics WHERE node_id = ?').get(aNode.id);
    expect(metrics.symbol_count).toBe(2); // foo + bar (not 3)
  });

  it('creates intermediate directory nodes', () => {
    insertFileNode('src/utils/helper.js', 'src/utils/helper.js');

    const fileSymbols = new Map([
      ['src/utils/helper.js', { definitions: [], imports: [], exports: [], calls: [] }],
    ]);
    const lineCountMap = new Map([['src/utils/helper.js', 5]]);

    buildStructure(db, fileSymbols, '/root', lineCountMap, new Set(['src/utils']));

    // Both src and src/utils should exist as directory nodes
    const srcDir = db
      .prepare("SELECT * FROM nodes WHERE kind = 'directory' AND name = 'src'")
      .get();
    const utilsDir = db
      .prepare("SELECT * FROM nodes WHERE kind = 'directory' AND name = 'src/utils'")
      .get();
    expect(srcDir).toBeDefined();
    expect(utilsDir).toBeDefined();

    // src -> src/utils contains edge
    const containsEdge = db
      .prepare("SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND kind = 'contains'")
      .get(srcDir.id, utilsDir.id);
    expect(containsEdge).toBeDefined();
  });

  it('handles empty fileSymbols gracefully', () => {
    const fileSymbols = new Map();
    const lineCountMap = new Map();

    buildStructure(db, fileSymbols, '/root', lineCountMap, new Set());

    const dirCount = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'directory'").get().c;
    expect(dirCount).toBe(0);
  });

  it('is idempotent — rebuilding clears old directory data', () => {
    insertFileNode('src/a.js', 'src/a.js');

    const fileSymbols = new Map([
      [
        'src/a.js',
        {
          definitions: [{ name: 'foo', kind: 'function', line: 1 }],
          imports: [],
          exports: [],
          calls: [],
        },
      ],
    ]);
    const lineCountMap = new Map([['src/a.js', 10]]);
    const dirs = new Set(['src']);

    buildStructure(db, fileSymbols, '/root', lineCountMap, dirs);
    buildStructure(db, fileSymbols, '/root', lineCountMap, dirs);

    // Should only have 1 directory node, not 2
    const dirCount = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'directory'").get().c;
    expect(dirCount).toBe(1);
  });
});
