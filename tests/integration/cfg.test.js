/**
 * Integration tests for CFG queries.
 *
 * Uses a hand-crafted in-memory DB with known CFG topology.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { cfgData, cfgToDOT, cfgToMermaid } from '../../src/features/cfg.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function insertNode(db, name, kind, file, line) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid;
}

function insertBlock(db, fnNodeId, blockIndex, blockType, startLine, endLine, label) {
  return db
    .prepare(
      'INSERT INTO cfg_blocks (function_node_id, block_index, block_type, start_line, end_line, label) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(fnNodeId, blockIndex, blockType, startLine, endLine, label).lastInsertRowid;
}

function insertEdge(db, fnNodeId, sourceBlockId, targetBlockId, kind) {
  db.prepare(
    'INSERT INTO cfg_edges (function_node_id, source_block_id, target_block_id, kind) VALUES (?, ?, ?, ?)',
  ).run(fnNodeId, sourceBlockId, targetBlockId, kind);
}

// ─── Fixture DB ────────────────────────────────────────────────────────

let tmpDir, dbPath;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cfg-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // Insert function nodes
  const processId = insertNode(db, 'processItems', 'function', 'src/process.js', 10);
  const helperId = insertNode(db, 'helper', 'function', 'src/helper.js', 5);
  insertNode(db, 'testFn', 'function', 'tests/process.test.js', 1);

  // CFG for processItems: entry → body → condition → [true, false] → join → exit
  const b0 = insertBlock(db, processId, 0, 'entry', null, null, null);
  const b1 = insertBlock(db, processId, 1, 'exit', null, null, null);
  const b2 = insertBlock(db, processId, 2, 'body', 10, 12, null);
  const b3 = insertBlock(db, processId, 3, 'condition', 13, 13, 'if');
  const b4 = insertBlock(db, processId, 4, 'branch_true', 14, 15, 'then');
  const b5 = insertBlock(db, processId, 5, 'branch_false', 16, 17, 'else');
  const b6 = insertBlock(db, processId, 6, 'body', 18, 19, null);

  insertEdge(db, processId, b0, b2, 'fallthrough');
  insertEdge(db, processId, b2, b3, 'fallthrough');
  insertEdge(db, processId, b3, b4, 'branch_true');
  insertEdge(db, processId, b3, b5, 'branch_false');
  insertEdge(db, processId, b4, b6, 'fallthrough');
  insertEdge(db, processId, b5, b6, 'fallthrough');
  insertEdge(db, processId, b6, b1, 'fallthrough');

  // CFG for helper: entry → body → exit (simple)
  const h0 = insertBlock(db, helperId, 0, 'entry', null, null, null);
  const h1 = insertBlock(db, helperId, 1, 'exit', null, null, null);
  const h2 = insertBlock(db, helperId, 2, 'body', 5, 8, null);

  insertEdge(db, helperId, h0, h2, 'fallthrough');
  insertEdge(db, helperId, h2, h1, 'return');

  db.close();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────────────────

describe('cfgData', () => {
  test('returns CFG blocks and edges for a known function', () => {
    const data = cfgData('processItems', dbPath);
    expect(data.results.length).toBe(1);

    const r = data.results[0];
    expect(r.name).toBe('processItems');
    expect(r.file).toBe('src/process.js');
    expect(r.summary.blockCount).toBe(7);
    expect(r.summary.edgeCount).toBe(7);
    expect(r.blocks[0].type).toBe('entry');
    expect(r.blocks[1].type).toBe('exit');
  });

  test('returns edges with correct kinds', () => {
    const data = cfgData('processItems', dbPath);
    const r = data.results[0];
    const edgeKinds = r.edges.map((e) => e.kind);
    expect(edgeKinds).toContain('branch_true');
    expect(edgeKinds).toContain('branch_false');
    expect(edgeKinds).toContain('fallthrough');
  });

  test('simple function has return edge', () => {
    const data = cfgData('helper', dbPath);
    expect(data.results.length).toBe(1);
    const r = data.results[0];
    expect(r.summary.blockCount).toBe(3);
    expect(r.edges.some((e) => e.kind === 'return')).toBe(true);
  });

  test('returns empty results for non-existent function', () => {
    const data = cfgData('nonexistent', dbPath);
    expect(data.results.length).toBe(0);
  });

  test('noTests option excludes test file functions', () => {
    const data = cfgData('testFn', dbPath, { noTests: true });
    expect(data.results.length).toBe(0);
  });

  test('file filter scopes results', () => {
    const data = cfgData('processItems', dbPath, { file: 'helper.js' });
    expect(data.results.length).toBe(0);

    const data2 = cfgData('processItems', dbPath, { file: 'process.js' });
    expect(data2.results.length).toBe(1);
  });
});

describe('cfgToDOT', () => {
  test('produces valid DOT output', () => {
    const data = cfgData('processItems', dbPath);
    const dot = cfgToDOT(data);
    expect(dot).toContain('digraph');
    expect(dot).toContain('B0');
    expect(dot).toContain('->');
    expect(dot).toContain('branch_true');
    expect(dot).toContain('}');
  });

  test('entry/exit nodes use ellipse shape', () => {
    const data = cfgData('processItems', dbPath);
    const dot = cfgToDOT(data);
    expect(dot).toMatch(/B0.*shape=ellipse/);
    expect(dot).toMatch(/B1.*shape=ellipse/);
  });
});

describe('cfgToMermaid', () => {
  test('produces valid Mermaid output', () => {
    const data = cfgData('processItems', dbPath);
    const mermaid = cfgToMermaid(data);
    expect(mermaid).toContain('graph TD');
    expect(mermaid).toContain('B0');
    expect(mermaid).toContain('-->');
    expect(mermaid).toContain('branch_true');
  });

  test('entry/exit use stadium shape', () => {
    const data = cfgData('processItems', dbPath);
    const mermaid = cfgToMermaid(data);
    // Stadium shapes use (["..."])
    expect(mermaid).toMatch(/B0\(\[/);
    expect(mermaid).toMatch(/B1\(\[/);
  });
});

describe('warning when no CFG tables', () => {
  test('returns warning when DB has no CFG data', () => {
    // Create a bare DB without cfg tables
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cfg-bare-'));
    fs.mkdirSync(path.join(bareDir, '.codegraph'));
    const bareDbPath = path.join(bareDir, '.codegraph', 'graph.db');

    const db = new Database(bareDbPath);
    db.pragma('journal_mode = WAL');
    // Only create nodes table, skip migrations
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL DEFAULT 0);
      INSERT INTO schema_version VALUES (8);
      CREATE TABLE nodes (id INTEGER PRIMARY KEY, name TEXT, kind TEXT, file TEXT, line INTEGER);
    `);
    db.close();

    const data = cfgData('anything', bareDbPath);
    expect(data.warning).toMatch(/No CFG data/);

    fs.rmSync(bareDir, { recursive: true, force: true });
  });
});
