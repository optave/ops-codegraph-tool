/**
 * Incremental build parity test.
 *
 * Verifies that an incremental rebuild after touching a single file
 * produces the same nodes and edges as a full build.
 * Uses a barrel-file fixture to exercise re-export resolution.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'barrel-project');

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readGraph(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const nodes = db
    .prepare('SELECT name, kind, file, line FROM nodes ORDER BY name, kind, file, line')
    .all();
  const edges = db
    .prepare(
      `SELECT n1.name AS source_name, n2.name AS target_name, e.kind
       FROM edges e
       JOIN nodes n1 ON e.source_id = n1.id
       JOIN nodes n2 ON e.target_id = n2.id
       ORDER BY n1.name, n2.name, e.kind`,
    )
    .all();
  db.close();
  return { nodes, edges };
}

function readAnalysisTables(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const result = {};
  try {
    try {
      result.complexity = db
        .prepare(
          `SELECT fc.node_id, fc.cognitive, fc.cyclomatic, n.name, n.file
           FROM function_complexity fc JOIN nodes n ON fc.node_id = n.id
           ORDER BY n.name, n.file`,
        )
        .all();
    } catch {
      result.complexity = [];
    }
    try {
      result.cfgBlocks = db
        .prepare(
          `SELECT cb.function_node_id, cb.block_index, cb.block_type, n.name, n.file
           FROM cfg_blocks cb JOIN nodes n ON cb.function_node_id = n.id
           ORDER BY n.name, n.file, cb.block_index`,
        )
        .all();
    } catch {
      result.cfgBlocks = [];
    }
    try {
      result.dataflow = db
        .prepare(
          `SELECT d.source_id, d.kind, n.name, n.file
           FROM dataflow d JOIN nodes n ON d.source_id = n.id
           ORDER BY n.name, n.file, d.kind`,
        )
        .all();
    } catch {
      result.dataflow = [];
    }
  } finally {
    db.close();
  }
  return result;
}

describe('Incremental build parity: full vs incremental', () => {
  let fullDir: string;
  let incrDir: string;
  let tmpBase: string;

  beforeAll(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-incr-parity-'));
    fullDir = path.join(tmpBase, 'full');
    incrDir = path.join(tmpBase, 'incr');
    copyDirSync(FIXTURE_DIR, fullDir);
    copyDirSync(FIXTURE_DIR, incrDir);

    // Step 1: Full build both copies
    await buildGraph(fullDir, { incremental: false, skipRegistry: true });
    await buildGraph(incrDir, { incremental: false, skipRegistry: true });

    // Step 2: Touch app.js in the incr copy (append a comment)
    const appPath = path.join(incrDir, 'app.js');
    fs.appendFileSync(appPath, '\n// touched\n');

    // Step 3: Incremental rebuild
    await buildGraph(incrDir, { incremental: true, skipRegistry: true });

    // Step 4: Full rebuild the full copy so both have identical source
    const fullAppPath = path.join(fullDir, 'app.js');
    fs.appendFileSync(fullAppPath, '\n// touched\n');
    await buildGraph(fullDir, { incremental: false, skipRegistry: true });
  }, 60_000);

  afterAll(() => {
    try {
      if (tmpBase) fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('produces the same node count', () => {
    const fullGraph = readGraph(path.join(fullDir, '.codegraph', 'graph.db'));
    const incrGraph = readGraph(path.join(incrDir, '.codegraph', 'graph.db'));
    expect(incrGraph.nodes.length).toBe(fullGraph.nodes.length);
  });

  it('produces the same edge count', () => {
    const fullGraph = readGraph(path.join(fullDir, '.codegraph', 'graph.db'));
    const incrGraph = readGraph(path.join(incrDir, '.codegraph', 'graph.db'));
    expect(incrGraph.edges.length).toBe(fullGraph.edges.length);
  });

  it('produces identical nodes', () => {
    const fullGraph = readGraph(path.join(fullDir, '.codegraph', 'graph.db'));
    const incrGraph = readGraph(path.join(incrDir, '.codegraph', 'graph.db'));
    expect(incrGraph.nodes).toEqual(fullGraph.nodes);
  });

  it('produces identical edges', () => {
    const fullGraph = readGraph(path.join(fullDir, '.codegraph', 'graph.db'));
    const incrGraph = readGraph(path.join(incrDir, '.codegraph', 'graph.db'));
    expect(incrGraph.edges).toEqual(fullGraph.edges);
  });

  it('preserves complexity metrics for changed file (#468)', () => {
    const fullAnalysis = readAnalysisTables(path.join(fullDir, '.codegraph', 'graph.db'));
    const incrAnalysis = readAnalysisTables(path.join(incrDir, '.codegraph', 'graph.db'));
    expect(incrAnalysis.complexity.length).toBeGreaterThan(0);
    expect(incrAnalysis.complexity.length).toBe(fullAnalysis.complexity.length);
  });

  it('preserves CFG blocks for changed file (#468)', () => {
    const fullAnalysis = readAnalysisTables(path.join(fullDir, '.codegraph', 'graph.db'));
    const incrAnalysis = readAnalysisTables(path.join(incrDir, '.codegraph', 'graph.db'));
    expect(incrAnalysis.cfgBlocks.length).toBeGreaterThan(0);
    expect(incrAnalysis.cfgBlocks.length).toBe(fullAnalysis.cfgBlocks.length);
  });

  it('preserves dataflow edges for changed file (#468)', () => {
    const fullAnalysis = readAnalysisTables(path.join(fullDir, '.codegraph', 'graph.db'));
    const incrAnalysis = readAnalysisTables(path.join(incrDir, '.codegraph', 'graph.db'));
    expect(incrAnalysis.dataflow.length).toBeGreaterThan(0);
    expect(incrAnalysis.dataflow.length).toBe(fullAnalysis.dataflow.length);
  });
});
