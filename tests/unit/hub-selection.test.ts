/**
 * Unit tests for scripts/lib/hub-selection.ts
 *
 * Regression coverage for #1904: benchmark hub-selection queries picked
 * non-deterministically among same-named nodes (e.g. a local
 * `const { buildGraph } = await import(...)` binding vs. the real
 * `function buildGraph` definition) because the underlying SQL had no
 * `kind` filter and no explicit ORDER BY tie-break.
 */

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PINNED_HUB_CANDIDATES, selectHubTargetsFromDb } from '../../scripts/lib/hub-selection.js';
import { initSchema } from '../../src/db/index.js';

function insertNode(db, name, kind, file, line) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind, confidence = 1.0) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, 0)',
  ).run(sourceId, targetId, kind, confidence);
}

let db: InstanceType<typeof Database>;

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
//
// The 3 edges from orchestrator to constBuildGraph use distinct confidence
// values (1.0/0.9/0.8), not 3 byte-identical rows — the edges table's
// content-uniqueness constraint (#2072) rejects true duplicate content
// (same source, target, kind, confidence, dynamic, dynamic_kind, technique),
// and a single caller genuinely calling the same target 3 times collapses
// to one edge in the real graph anyway (call-site granularity isn't tracked
// in the schema). Varying confidence gives this fixture the same
// COUNT(e.id)-of-3 fan-in property `selectHubTargets` ranks by, without
// relying on duplicate rows or introducing extra qualifying nodes that
// would shift the mid/leaf rank indices in the test below.
beforeAll(() => {
  // In-memory DB: Windows CI has repeatedly timed out this hook on tmpdir
  // file I/O (#2368). The queries under test do not depend on a real file.
  db = new Database(':memory:');
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

  insertEdge(db, orchestrator, constBuildGraph, 'calls', 1.0);
  insertEdge(db, orchestrator, constBuildGraph, 'calls', 0.9);
  insertEdge(db, orchestrator, constBuildGraph, 'calls', 0.8);
  insertEdge(db, orchestrator, realBuildGraph, 'calls');
  insertEdge(db, orchestrator, midHelper, 'calls');
  insertEdge(db, orchestrator, leafHelper, 'calls');
});

afterAll(() => {
  db?.close();
});

describe('selectHubTargets', () => {
  it('prefers a callable-kind pinned candidate over a same-named constant binding', () => {
    const targets = selectHubTargetsFromDb(db, ['buildGraph']);
    expect(targets.hub).toBe('buildGraph');
    expect(targets.hubFile).toBe('src/domain/graph/builder.ts');
  });

  it('resolves via the shared PINNED_HUB_CANDIDATES list used by both benchmark scripts', () => {
    // query-benchmark.ts and benchmark.ts both pass this exact export to
    // selectHubTargets — exercise it directly (not just a single-item
    // ['buildGraph'] stand-in) so a typo or ordering change in the shared
    // list is caught here rather than only at benchmark run time.
    expect(PINNED_HUB_CANDIDATES.length).toBeGreaterThan(0);
    const targets = selectHubTargetsFromDb(db, PINNED_HUB_CANDIDATES);
    expect(targets.hub).toBe('buildGraph');
    expect(targets.hubFile).toBe('src/domain/graph/builder.ts');
  });

  it('excludes a constant-kind node from the most-connected fallback even with more raw edges', () => {
    // No pinned candidates supplied — falls back to the most-connected
    // qualifying (function/method) node. constBuildGraph has 3 edges (more
    // than any single function/method node) but must never win because it
    // is kind=constant.
    const targets = selectHubTargetsFromDb(db, []);
    expect(targets.hub).toBe('orchestrator');
    expect(targets.hubFile).toBe('src/cli.ts');
  });

  it('selects mid/leaf from the same kind-filtered, edge-ranked ordering', () => {
    const targets = selectHubTargetsFromDb(db, []);
    expect(targets.mid).toBe('midHelper');
    expect(targets.leaf).toBe('leafHelper');
  });

  it('is deterministic across repeated calls against the same DB', () => {
    const first = selectHubTargetsFromDb(db, ['buildGraph']);
    const second = selectHubTargetsFromDb(db, ['buildGraph']);
    expect(second).toEqual(first);
  });

  it('throws when the graph has no qualifying nodes with edges', () => {
    const emptyDb = new Database(':memory:');
    initSchema(emptyDb);
    try {
      expect(() => selectHubTargetsFromDb(emptyDb, ['buildGraph'])).toThrow(
        'No nodes with edges found in graph',
      );
    } finally {
      emptyDb.close();
    }
  });
});
