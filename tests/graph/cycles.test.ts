/**
 * Circular dependency detection tests.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { findCycles, findCyclesJS, formatCycles } from '../../src/domain/graph/cycles.js';
import { isNativeAvailable, loadNative } from '../../src/infrastructure/native.js';

const hasNative = isNativeAvailable();

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

function insertEdge(db, sourceId, targetId, kind, confidence = 1.0, dynamic = 0) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)',
  ).run(sourceId, targetId, kind, confidence, dynamic);
}

describe('findCycles', () => {
  it('detects no cycles in acyclic graph', () => {
    const db = createTestDb();
    const a = insertNode(db, 'a.js', 'file', 'a.js', 0);
    const b = insertNode(db, 'b.js', 'file', 'b.js', 0);
    const c = insertNode(db, 'c.js', 'file', 'c.js', 0);
    insertEdge(db, a, b, 'imports');
    insertEdge(db, b, c, 'imports');

    const cycles = findCycles(db);
    expect(cycles).toHaveLength(0);
    db.close();
  });

  it('detects a simple 2-node cycle', () => {
    const db = createTestDb();
    const a = insertNode(db, 'a.js', 'file', 'a.js', 0);
    const b = insertNode(db, 'b.js', 'file', 'b.js', 0);
    insertEdge(db, a, b, 'imports');
    insertEdge(db, b, a, 'imports');

    const cycles = findCycles(db);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].nodes).toHaveLength(2);
    expect(cycles[0].speculative).toBe(false);
    db.close();
  });

  it('detects a 3-node cycle', () => {
    const db = createTestDb();
    const a = insertNode(db, 'a.js', 'file', 'a.js', 0);
    const b = insertNode(db, 'b.js', 'file', 'b.js', 0);
    const c = insertNode(db, 'c.js', 'file', 'c.js', 0);
    insertEdge(db, a, b, 'imports');
    insertEdge(db, b, c, 'imports');
    insertEdge(db, c, a, 'imports');

    const cycles = findCycles(db);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].nodes).toHaveLength(3);
    expect(cycles[0].speculative).toBe(false);
    db.close();
  });

  it('file-level import edges are never classified as speculative (dynamic/confidence unmodeled for imports)', () => {
    // Even if an 'imports' row happens to carry dynamic/confidence values,
    // getImportEdges() doesn't select those columns — file-level cycles are
    // built from plain static imports only (dynamic `import()` uses a
    // distinct 'dynamic-imports' kind that's excluded from cycle detection
    // entirely). This asserts that invariant.
    const db = createTestDb();
    const a = insertNode(db, 'a.js', 'file', 'a.js', 0);
    const b = insertNode(db, 'b.js', 'file', 'b.js', 0);
    insertEdge(db, a, b, 'imports', 0.2, 1);
    insertEdge(db, b, a, 'imports', 0.2, 1);

    const cycles = findCycles(db);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].speculative).toBe(false);
    db.close();
  });
});

describe('findCyclesJS (pure JS Tarjan)', () => {
  it('detects no cycles in acyclic edges', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];
    const cycles = findCyclesJS(edges);
    expect(cycles).toHaveLength(0);
  });

  it('detects a 2-node cycle from raw edges', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ];
    const cycles = findCyclesJS(edges);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(2);
  });

  it('detects a 3-node cycle from raw edges', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' },
    ];
    const cycles = findCyclesJS(edges);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(3);
  });
});

describe('findCycles — function-level', () => {
  it('detects function-level cycles with fileLevel: false', () => {
    const db = createTestDb();
    insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    const fnA = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fnB = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, fnA, fnB, 'calls');
    insertEdge(db, fnB, fnA, 'calls');

    const cycles = findCycles(db, { fileLevel: false });
    expect(cycles).toHaveLength(1);
    expect(cycles[0].nodes).toHaveLength(2);
    expect(cycles[0].speculative).toBe(false);
    db.close();
  });
});

// ── Speculative cycle classification (#1844) ────────────────────────

describe('findCycles — speculative classification', () => {
  it('marks a cycle speculative when its only closing edge is a low-confidence dynamic call', () => {
    const db = createTestDb();
    insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    const fnA = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fnB = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    // Confirmed direct call a -> b.
    insertEdge(db, fnA, fnB, 'calls', 1.0, 0);
    // Only b -> a closes the cycle, and it's a low-confidence dynamic guess.
    insertEdge(db, fnB, fnA, 'calls', 0.5, 1);

    const cycles = findCycles(db, { fileLevel: false });
    expect(cycles).toHaveLength(1);
    expect(cycles[0].speculative).toBe(true);
    db.close();
  });

  it('does not mark a cycle speculative when a dynamic edge is fully confident', () => {
    const db = createTestDb();
    insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    const fnA = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fnB = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    insertEdge(db, fnA, fnB, 'calls', 1.0, 0);
    // Flagged dynamic (e.g. CHA-resolved) but fully confident — not a guess.
    insertEdge(db, fnB, fnA, 'calls', 1.0, 1);

    const cycles = findCycles(db, { fileLevel: false });
    expect(cycles).toHaveLength(1);
    expect(cycles[0].speculative).toBe(false);
    db.close();
  });

  it('treats a node pair as confirmed if any edge between them is non-speculative, even with a duplicate speculative edge', () => {
    const db = createTestDb();
    insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    const fnA = insertNode(db, 'doWork', 'function', 'src/a.js', 5);
    const fnB = insertNode(db, 'helper', 'function', 'src/b.js', 10);
    // Two call sites in a -> b: one confirmed, one a low-confidence dynamic guess.
    insertEdge(db, fnA, fnB, 'calls', 1.0, 0);
    insertEdge(db, fnA, fnB, 'calls', 0.3, 1);
    insertEdge(db, fnB, fnA, 'calls', 1.0, 0);

    const cycles = findCycles(db, { fileLevel: false });
    expect(cycles).toHaveLength(1);
    expect(cycles[0].speculative).toBe(false);
    db.close();
  });

  it('excludeSpeculative drops speculative cycles but keeps confirmed ones', () => {
    const db = createTestDb();
    insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertNode(db, 'src/x.js', 'file', 'src/x.js', 0);
    insertNode(db, 'src/y.js', 'file', 'src/y.js', 0);
    const fnA = insertNode(db, 'a', 'function', 'src/a.js', 1);
    const fnB = insertNode(db, 'b', 'function', 'src/b.js', 1);
    const fnX = insertNode(db, 'x', 'function', 'src/x.js', 1);
    const fnY = insertNode(db, 'y', 'function', 'src/y.js', 1);
    // Confirmed cycle: a <-> b (both static).
    insertEdge(db, fnA, fnB, 'calls', 1.0, 0);
    insertEdge(db, fnB, fnA, 'calls', 1.0, 0);
    // Speculative cycle: x -> y confirmed, y -> x only a low-confidence dynamic guess.
    insertEdge(db, fnX, fnY, 'calls', 1.0, 0);
    insertEdge(db, fnY, fnX, 'calls', 0.4, 1);

    const all = findCycles(db, { fileLevel: false });
    expect(all).toHaveLength(2);
    expect(all.filter((c) => c.speculative)).toHaveLength(1);
    expect(all.filter((c) => !c.speculative)).toHaveLength(1);

    const confirmedOnly = findCycles(db, { fileLevel: false, excludeSpeculative: true });
    expect(confirmedOnly).toHaveLength(1);
    expect(confirmedOnly[0].speculative).toBe(false);
    expect(confirmedOnly[0].nodes.sort()).toEqual(['a|src/a.js', 'b|src/b.js']);
    db.close();
  });

  it('surfaces a confirmed sub-cycle even when a speculative edge merges it into a larger SCC', () => {
    // Confirmed: a -> b -> c -> b (b <-> c is a real, closed cycle on its
    // own). Speculative: c -> a merges {a,b,c} into one bigger SCC in the
    // full-graph run, but must not swallow the genuine b <-> c cycle.
    const db = createTestDb();
    insertNode(db, 'src/a.js', 'file', 'src/a.js', 0);
    insertNode(db, 'src/b.js', 'file', 'src/b.js', 0);
    insertNode(db, 'src/c.js', 'file', 'src/c.js', 0);
    const fnA = insertNode(db, 'a', 'function', 'src/a.js', 1);
    const fnB = insertNode(db, 'b', 'function', 'src/b.js', 1);
    const fnC = insertNode(db, 'c', 'function', 'src/c.js', 1);
    insertEdge(db, fnA, fnB, 'calls', 1.0, 0);
    insertEdge(db, fnB, fnC, 'calls', 1.0, 0);
    insertEdge(db, fnC, fnB, 'calls', 1.0, 0);
    insertEdge(db, fnC, fnA, 'calls', 0.4, 1);

    const all = findCycles(db, { fileLevel: false });
    const confirmed = all.filter((c) => !c.speculative);
    const speculative = all.filter((c) => c.speculative);
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].nodes.sort()).toEqual(['b|src/b.js', 'c|src/c.js']);
    expect(speculative).toHaveLength(1);
    expect(speculative[0].nodes.sort()).toEqual(['a|src/a.js', 'b|src/b.js', 'c|src/c.js']);

    // The real b <-> c cycle must survive excludeSpeculative, not disappear
    // along with the larger speculative-only grouping.
    const confirmedOnly = findCycles(db, { fileLevel: false, excludeSpeculative: true });
    expect(confirmedOnly).toHaveLength(1);
    expect(confirmedOnly[0].nodes.sort()).toEqual(['b|src/b.js', 'c|src/c.js']);
    db.close();
  });
});

describe('formatCycles', () => {
  it('returns no-cycles message for empty array', () => {
    const output = formatCycles([]);
    expect(output.toLowerCase()).toMatch(/no.*circular/);
  });

  it('formats a single cycle with all member files', () => {
    const output = formatCycles([{ nodes: ['a.js', 'b.js'], speculative: false }]);
    expect(output).toContain('a.js');
    expect(output).toContain('b.js');
    expect(output).toMatch(/1/);
    expect(output).not.toContain('speculative');
  });

  it('formats multiple cycles with distinct labels', () => {
    const output = formatCycles([
      { nodes: ['a.js', 'b.js'], speculative: false },
      { nodes: ['x.js', 'y.js', 'z.js'], speculative: false },
    ]);
    // should indicate 2 cycles and reference each one
    expect(output).toMatch(/2/);
    expect(output).toContain('a.js');
    expect(output).toContain('x.js');
    expect(output).toContain('y.js');
    expect(output).toContain('z.js');
  });

  it('annotates speculative cycles distinctly', () => {
    const output = formatCycles([{ nodes: ['a.js', 'b.js'], speculative: true }]);
    expect(output).toContain('speculative');
  });
});

// ── Native vs JS parity ────────────────────────────────────────────

describe.skipIf(!hasNative)('Cycle detection: native vs JS parity', () => {
  const native = hasNative ? loadNative() : null;

  function sortCycles(cycles) {
    return cycles.map((c) => [...c].sort()).sort((a, b) => a[0].localeCompare(b[0]));
  }

  it('no cycles — both engines agree', () => {
    const edges = [
      { source: 'a.js', target: 'b.js' },
      { source: 'b.js', target: 'c.js' },
    ];
    const jsResult = findCyclesJS(edges);
    const nativeResult = native.detectCycles(edges);
    expect(sortCycles(nativeResult)).toEqual(sortCycles(jsResult));
  });

  it('2-node cycle — both engines agree', () => {
    const edges = [
      { source: 'a.js', target: 'b.js' },
      { source: 'b.js', target: 'a.js' },
    ];
    const jsResult = findCyclesJS(edges);
    const nativeResult = native.detectCycles(edges);
    expect(sortCycles(nativeResult)).toEqual(sortCycles(jsResult));
  });

  it('3-node cycle — both engines agree', () => {
    const edges = [
      { source: 'a.js', target: 'b.js' },
      { source: 'b.js', target: 'c.js' },
      { source: 'c.js', target: 'a.js' },
    ];
    const jsResult = findCyclesJS(edges);
    const nativeResult = native.detectCycles(edges);
    expect(sortCycles(nativeResult)).toEqual(sortCycles(jsResult));
  });

  it('multiple independent cycles — both engines agree', () => {
    const edges = [
      // Cycle 1: a <-> b
      { source: 'a.js', target: 'b.js' },
      { source: 'b.js', target: 'a.js' },
      // Cycle 2: x -> y -> z -> x
      { source: 'x.js', target: 'y.js' },
      { source: 'y.js', target: 'z.js' },
      { source: 'z.js', target: 'x.js' },
      // Non-cyclic tail
      { source: 'p.js', target: 'q.js' },
    ];
    const jsResult = findCyclesJS(edges);
    const nativeResult = native.detectCycles(edges);
    expect(jsResult).toHaveLength(2);
    expect(nativeResult).toHaveLength(2);
    expect(sortCycles(nativeResult)).toEqual(sortCycles(jsResult));
  });

  it('speculative classification agrees between native and JS Tarjan backends', () => {
    // Same fixture as the "excludeSpeculative" unit test above, run through
    // findCycles() so both the full and filtered Tarjan passes exercise
    // whichever backend (native/WASM) is active — the classification lives
    // in TS and simply calls the SCC primitive twice, so both engines must
    // agree on which cycles are speculative (#1844).
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    initSchema(db);
    const insert = (name, file, line) =>
      db
        .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
        .run(name, 'function', file, line).lastInsertRowid;
    const edge = (s, t, confidence, dynamic) =>
      db
        .prepare(
          'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)',
        )
        .run(s, t, 'calls', confidence, dynamic);
    db.prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)').run(
      'src/x.js',
      'file',
      'src/x.js',
      0,
    );
    db.prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)').run(
      'src/y.js',
      'file',
      'src/y.js',
      0,
    );
    const x = insert('x', 'src/x.js', 1);
    const y = insert('y', 'src/y.js', 1);
    edge(x, y, 1.0, 0);
    edge(y, x, 0.4, 1);

    const cycles = findCycles(db, { fileLevel: false });
    expect(cycles).toHaveLength(1);
    expect(cycles[0].speculative).toBe(true);
    db.close();
  });
});
