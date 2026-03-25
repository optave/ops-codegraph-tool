/**
 * Unit tests for classifyNodeRoles in src/structure.js
 *
 * Uses an in-memory SQLite database with hand-crafted nodes/edges
 * to verify each role classification.
 *
 * Test graph:
 *   entryFn    - exported (cross-file caller), fan_in=0 from non-test → entry
 *   coreFn     - high fan_in, low fan_out → core
 *   utilityFn  - high fan_in, high fan_out → utility
 *   adapterFn  - low fan_in, high fan_out → adapter
 *   deadFn     - fan_in=0, not exported → dead-unresolved
 *   leafFn     - low fan_in, low fan_out → leaf
 */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { classifyNodeRoles } from '../../src/features/structure.js';

let db: any;

function setup() {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

function insertNode(name, kind, file, line) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid;
}

function insertEdge(sourceId, targetId, kind) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, 1.0, 0)',
  ).run(sourceId, targetId, kind);
}

/**
 * Build a graph where median fan_in = 2 and median fan_out = 2.
 * This allows clear high/low classification.
 */
function buildTestGraph() {
  // File nodes (these should NOT get roles)
  const fA = insertNode('a.js', 'file', 'a.js', 0);
  const fB = insertNode('b.js', 'file', 'b.js', 0);

  // Function nodes
  const entryFn = insertNode('entryFn', 'function', 'a.js', 1);
  const coreFn = insertNode('coreFn', 'function', 'a.js', 10);
  const utilityFn = insertNode('utilityFn', 'function', 'a.js', 20);
  const adapterFn = insertNode('adapterFn', 'function', 'b.js', 1);
  const deadFn = insertNode('deadFn', 'function', 'b.js', 10);
  const leafFn = insertNode('leafFn', 'function', 'b.js', 20);

  // Helper targets for fan_out edges
  const helperA = insertNode('helperA', 'function', 'a.js', 30);
  const helperB = insertNode('helperB', 'function', 'a.js', 40);
  const helperC = insertNode('helperC', 'function', 'b.js', 30);
  const helperD = insertNode('helperD', 'function', 'b.js', 40);

  // entryFn: fan_in=0, but exported (cross-file caller) → entry
  // No callers from same file, but one cross-file caller
  const crossCaller = insertNode('crossCaller', 'function', 'b.js', 50);
  insertEdge(crossCaller, entryFn, 'calls');

  // coreFn: high fan_in (3 callers), low fan_out (0) → core
  insertEdge(entryFn, coreFn, 'calls');
  insertEdge(adapterFn, coreFn, 'calls');
  insertEdge(leafFn, coreFn, 'calls');

  // utilityFn: high fan_in (3 callers), high fan_out (3 callees) → utility
  insertEdge(entryFn, utilityFn, 'calls');
  insertEdge(adapterFn, utilityFn, 'calls');
  insertEdge(crossCaller, utilityFn, 'calls');
  insertEdge(utilityFn, helperA, 'calls');
  insertEdge(utilityFn, helperB, 'calls');
  insertEdge(utilityFn, helperC, 'calls');

  // adapterFn: low fan_in (1 caller), high fan_out (3 callees) → adapter
  insertEdge(entryFn, adapterFn, 'calls');
  // adapterFn already calls coreFn and utilityFn above
  insertEdge(adapterFn, helperD, 'calls');

  // deadFn: fan_in=0, not exported → dead
  // No callers at all

  // leafFn: low fan_in (1 caller), low fan_out (1 callee) → leaf
  insertEdge(crossCaller, leafFn, 'calls');
  // leafFn already calls coreFn above

  return { fA, fB, entryFn, coreFn, utilityFn, adapterFn, deadFn, leafFn };
}

describe('classifyNodeRoles', () => {
  beforeEach(() => {
    setup();
  });

  it('classifies each role correctly', () => {
    buildTestGraph();
    const summary = classifyNodeRoles(db);

    // Verify summary has all roles
    expect(summary).toHaveProperty('entry');
    expect(summary).toHaveProperty('core');
    expect(summary).toHaveProperty('utility');
    expect(summary).toHaveProperty('adapter');
    expect(summary).toHaveProperty('dead');
    expect(summary).toHaveProperty('leaf');

    // Verify specific node roles
    const getRole = (name) => db.prepare('SELECT role FROM nodes WHERE name = ?').get(name)?.role;

    expect(getRole('deadFn')).toBe('dead-unresolved');
    expect(getRole('coreFn')).toBe('core');
    expect(getRole('utilityFn')).toBe('utility');
  });

  it('marks file and directory nodes as NULL role', () => {
    buildTestGraph();
    // Insert a directory node
    insertNode('src', 'directory', 'src', 0);
    classifyNodeRoles(db);

    const fileRole = db.prepare("SELECT role FROM nodes WHERE kind = 'file' LIMIT 1").get();
    expect(fileRole.role).toBeNull();

    const dirRole = db.prepare("SELECT role FROM nodes WHERE kind = 'directory' LIMIT 1").get();
    expect(dirRole.role).toBeNull();
  });

  it('is idempotent (running twice gives same results)', () => {
    buildTestGraph();
    const summary1 = classifyNodeRoles(db);
    const roles1 = db
      .prepare('SELECT name, role FROM nodes WHERE role IS NOT NULL ORDER BY name')
      .all();

    const summary2 = classifyNodeRoles(db);
    const roles2 = db
      .prepare('SELECT name, role FROM nodes WHERE role IS NOT NULL ORDER BY name')
      .all();

    expect(summary1).toEqual(summary2);
    expect(roles1).toEqual(roles2);
  });

  it('handles empty graph without crashing', () => {
    const summary = classifyNodeRoles(db);
    expect(summary).toEqual({
      entry: 0,
      core: 0,
      utility: 0,
      adapter: 0,
      dead: 0,
      'dead-leaf': 0,
      'dead-entry': 0,
      'dead-ffi': 0,
      'dead-unresolved': 0,
      'test-only': 0,
      leaf: 0,
    });
  });

  it('adapts median thresholds to data', () => {
    // Create a small graph: 2 functions with fan_in=[1,1], fan_out=[1,1]
    // median of non-zero = 1 for both, so fan_in >= 1 = high, fan_out >= 1 = high
    insertNode('a.js', 'file', 'a.js', 0);
    const fn1 = insertNode('fn1', 'function', 'a.js', 1);
    const fn2 = insertNode('fn2', 'function', 'a.js', 10);

    // fn1 calls fn2, fn2 calls fn1 (mutual)
    insertEdge(fn1, fn2, 'calls');
    insertEdge(fn2, fn1, 'calls');

    const summary = classifyNodeRoles(db);
    // Both have fan_in=1 (>= median 1) and fan_out=1 (>= median 1) → utility
    expect(summary.utility).toBe(2);
  });

  it('classifies nodes with only non-call edges as dead-unresolved', () => {
    const fA = insertNode('a.js', 'file', 'a.js', 0);
    const fn1 = insertNode('fn1', 'function', 'a.js', 1);
    // Only import edge, no call edge
    insertEdge(fA, fn1, 'imports');

    classifyNodeRoles(db);
    const role = db.prepare("SELECT role FROM nodes WHERE name = 'fn1'").get();
    expect(role.role).toBe('dead-unresolved');
  });
});
