/**
 * Reproduction test for #533: incremental builds produce fewer edges than full builds.
 * Uses a deeper dependency graph to exercise reverse-dep cascade.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'deep-deps-project');

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readEdges(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const edges = db.prepare(`
    SELECT n1.name AS src_name, n1.kind AS src_kind, n1.file AS src_file,
           n2.name AS tgt_name, n2.kind AS tgt_kind, n2.file AS tgt_file,
           e.kind AS edge_kind, e.confidence
    FROM edges e
    JOIN nodes n1 ON e.source_id = n1.id
    JOIN nodes n2 ON e.target_id = n2.id
    ORDER BY src_file, src_name, tgt_file, tgt_name, e.kind
  `).all();
  const nodes = db.prepare(
    'SELECT name, kind, file, line FROM nodes ORDER BY name, kind, file, line'
  ).all();
  db.close();
  return { edges, nodes };
}

function edgeKey(e) {
  return `[${e.edge_kind}] ${e.src_name}(${e.src_kind}@${e.src_file}) -> ${e.tgt_name}(${e.tgt_kind}@${e.tgt_file})`;
}

describe('Issue #533: incremental edge gap', () => {
  it('touching leaf file: full vs incremental produce identical edges', async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-533-'));
    const fullDir = path.join(tmpBase, 'full');
    const incrDir = path.join(tmpBase, 'incr');
    copyDirSync(FIXTURE_DIR, fullDir);
    copyDirSync(FIXTURE_DIR, incrDir);

    try {
      // Initial full build on incr copy
      await buildGraph(incrDir, { incremental: false, skipRegistry: true });

      // Touch the deeply-imported leaf file
      fs.appendFileSync(path.join(incrDir, 'shared', 'constants.js'), '\n// touched\n');
      // Incremental rebuild
      await buildGraph(incrDir, { incremental: true, skipRegistry: true });

      // Full build on full copy (with same change)
      fs.appendFileSync(path.join(fullDir, 'shared', 'constants.js'), '\n// touched\n');
      await buildGraph(fullDir, { incremental: false, skipRegistry: true });

      const fullGraph = readEdges(path.join(fullDir, '.codegraph', 'graph.db'));
      const incrGraph = readEdges(path.join(incrDir, '.codegraph', 'graph.db'));

      // Nodes should match
      expect(incrGraph.nodes.length).toBe(fullGraph.nodes.length);

      // Detailed edge comparison
      const fullKeys = new Set(fullGraph.edges.map(edgeKey));
      const incrKeys = new Set(incrGraph.edges.map(edgeKey));
      const missing = [...fullKeys].filter(k => !incrKeys.has(k));
      const extra = [...incrKeys].filter(k => !fullKeys.has(k));

      if (missing.length > 0 || extra.length > 0) {
        console.log(`\nFull build: ${fullGraph.edges.length} edges`);
        console.log(`Incremental: ${incrGraph.edges.length} edges`);
        console.log(`\nMissing in incremental (${missing.length}):`);
        for (const e of missing) console.log(`  - ${e}`);
        console.log(`\nExtra in incremental (${extra.length}):`);
        for (const e of extra) console.log(`  + ${e}`);
      }

      expect(missing).toEqual([]);
      expect(extra).toEqual([]);
      expect(incrGraph.edges.length).toBe(fullGraph.edges.length);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  }, 60_000);

  it('touching mid-level file: full vs incremental produce identical edges', async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-533b-'));
    const fullDir = path.join(tmpBase, 'full');
    const incrDir = path.join(tmpBase, 'incr');
    copyDirSync(FIXTURE_DIR, fullDir);
    copyDirSync(FIXTURE_DIR, incrDir);

    try {
      await buildGraph(incrDir, { incremental: false, skipRegistry: true });

      // Touch a mid-level file (imported by features but imports from shared)
      fs.appendFileSync(path.join(incrDir, 'shared', 'helpers.js'), '\n// touched\n');
      await buildGraph(incrDir, { incremental: true, skipRegistry: true });

      fs.appendFileSync(path.join(fullDir, 'shared', 'helpers.js'), '\n// touched\n');
      await buildGraph(fullDir, { incremental: false, skipRegistry: true });

      const fullGraph = readEdges(path.join(fullDir, '.codegraph', 'graph.db'));
      const incrGraph = readEdges(path.join(incrDir, '.codegraph', 'graph.db'));

      const fullKeys = new Set(fullGraph.edges.map(edgeKey));
      const incrKeys = new Set(incrGraph.edges.map(edgeKey));
      const missing = [...fullKeys].filter(k => !incrKeys.has(k));
      const extra = [...incrKeys].filter(k => !fullKeys.has(k));

      if (missing.length > 0 || extra.length > 0) {
        console.log(`\nFull: ${fullGraph.edges.length}, Incr: ${incrGraph.edges.length}`);
        console.log(`Missing (${missing.length}):`);
        for (const e of missing) console.log(`  - ${e}`);
        console.log(`Extra (${extra.length}):`);
        for (const e of extra) console.log(`  + ${e}`);
      }

      expect(missing).toEqual([]);
      expect(extra).toEqual([]);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  }, 60_000);
});
