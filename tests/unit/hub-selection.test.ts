/**
 * Unit tests for scripts/lib/hub-selection.ts
 *
 * Regression coverage for #1904: benchmark hub-selection queries picked
 * non-deterministically among same-named nodes (e.g. a local
 * `const { buildGraph } = await import(...)` binding vs. the real
 * `function buildGraph` definition) because the underlying SQL had no
 * `kind` filter and no explicit ORDER BY tie-break.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PINNED_HUB_CANDIDATES, selectHubTargets } from '../../scripts/lib/hub-selection.js';
import { initSchema } from '../../src/db/index.js';

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

let tmpDir: string, dbPath: string;

// Graph shape (mirrors the real #1904 scenario at smaller scale):
//
//   constBuildGraph  ('buildGraph', kind=constant, scripts/benchmark.ts)  — 3 inbound edges
//   realBuildGraph   ('buildGraph', kind=function, src/domain/graph/builder.ts) — 1 inbound edge
//   midHelper        (kind=function, src/domain/mid.ts)  — 1 inbound edge
//   leafHelper       (kind=method,   src/domain/leaf.ts) — 1 inbound edge
//   orchestrator     (kind=function, src/cli.ts) — source of all 6 edges above
//
// constBuildGraph has more raw edges (3) than any single real function/method
// node — a query without a `kind` filter would be tempted to rank it highest
// (or, for the pinned-candidate lookup, return it at all just from a
// name match). A correct implementation must exclude it everywhere.
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-hub-selection-'));
  dbPath = path.join(tmpDir, 'graph.db');

  const db = new Database(dbPath);
  initSchema(db);

  const constBuildGraph = insertNode(db, 'buildGraph', 'constant', 'scripts/benchmark.ts', 20);
  const realBuildGraph = insertNode(
    db,
    'buildGraph',
    'function',
    'src/domain/graph/builder.ts',
    12,
  );
  const midHelper = insertNode(db, 'midHelper', 'function', 'src/domain/mid.ts', 5);
  const leafHelper = insertNode(db, 'leafHelper', 'method', 'src/domain/leaf.ts', 5);
  const orchestrator = insertNode(db, 'orchestrator', 'function', 'src/cli.ts', 1);

  insertEdge(db, orchestrator, constBuildGraph, 'calls');
  insertEdge(db, orchestrator, constBuildGraph, 'calls');
  insertEdge(db, orchestrator, constBuildGraph, 'calls');
  insertEdge(db, orchestrator, realBuildGraph, 'calls');
  insertEdge(db, orchestrator, midHelper, 'calls');
  insertEdge(db, orchestrator, leafHelper, 'calls');

  db.close();
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('selectHubTargets', () => {
  it('prefers a callable-kind pinned candidate over a same-named constant binding', () => {
    const targets = selectHubTargets(dbPath, ['buildGraph']);
    expect(targets.hub).toBe('buildGraph');
    expect(targets.hubFile).toBe('src/domain/graph/builder.ts');
  });

  it('resolves via the shared PINNED_HUB_CANDIDATES list used by both benchmark scripts', () => {
    // query-benchmark.ts and benchmark.ts both pass this exact export to
    // selectHubTargets — exercise it directly (not just a single-item
    // ['buildGraph'] stand-in) so a typo or ordering change in the shared
    // list is caught here rather than only at benchmark run time.
    expect(PINNED_HUB_CANDIDATES.length).toBeGreaterThan(0);
    const targets = selectHubTargets(dbPath, PINNED_HUB_CANDIDATES);
    expect(targets.hub).toBe('buildGraph');
    expect(targets.hubFile).toBe('src/domain/graph/builder.ts');
  });

  it('excludes a constant-kind node from the most-connected fallback even with more raw edges', () => {
    // No pinned candidates supplied — falls back to the most-connected
    // qualifying (function/method) node. constBuildGraph has 3 edges (more
    // than any single function/method node) but must never win because it
    // is kind=constant.
    const targets = selectHubTargets(dbPath, []);
    expect(targets.hub).toBe('orchestrator');
    expect(targets.hubFile).toBe('src/cli.ts');
  });

  it('selects mid/leaf from the same kind-filtered, edge-ranked ordering', () => {
    const targets = selectHubTargets(dbPath, []);
    expect(targets.mid).toBe('midHelper');
    expect(targets.leaf).toBe('leafHelper');
  });

  it('is deterministic across repeated calls against the same DB', () => {
    const first = selectHubTargets(dbPath, ['buildGraph']);
    const second = selectHubTargets(dbPath, ['buildGraph']);
    expect(second).toEqual(first);
  });

  it('throws when the graph has no qualifying nodes with edges', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-hub-selection-empty-'));
    const emptyDbPath = path.join(emptyDir, 'graph.db');
    const db = new Database(emptyDbPath);
    initSchema(db);
    db.close();

    try {
      expect(() => selectHubTargets(emptyDbPath, ['buildGraph'])).toThrow(
        'No nodes with edges found in graph',
      );
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
