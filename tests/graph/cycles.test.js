/**
 * Circular dependency detection tests.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { findCycles, findCyclesJS } from '../../src/domain/graph/cycles.js';
import { isNativeAvailable, loadNative } from '../../src/native.js';

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

function insertEdge(db, sourceId, targetId, kind) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, 1.0, 0)',
  ).run(sourceId, targetId, kind);
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
    expect(cycles[0]).toHaveLength(2);
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
    expect(cycles[0]).toHaveLength(3);
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
    expect(cycles[0]).toHaveLength(2);
    db.close();
  });
});

describe('formatCycles', () => {
  it('returns no-cycles message for empty array', () => {
    const { formatCycles } = require('../../src/domain/graph/cycles.js');
    const output = formatCycles([]);
    expect(output.toLowerCase()).toMatch(/no.*circular/);
  });

  it('formats a single cycle with all member files', () => {
    const { formatCycles } = require('../../src/domain/graph/cycles.js');
    const output = formatCycles([['a.js', 'b.js']]);
    expect(output).toContain('a.js');
    expect(output).toContain('b.js');
    expect(output).toMatch(/1/);
  });

  it('formats multiple cycles with distinct labels', () => {
    const { formatCycles } = require('../../src/domain/graph/cycles.js');
    const output = formatCycles([
      ['a.js', 'b.js'],
      ['x.js', 'y.js', 'z.js'],
    ]);
    // should indicate 2 cycles and reference each one
    expect(output).toMatch(/2/);
    expect(output).toContain('a.js');
    expect(output).toContain('x.js');
    expect(output).toContain('y.js');
    expect(output).toContain('z.js');
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
});
