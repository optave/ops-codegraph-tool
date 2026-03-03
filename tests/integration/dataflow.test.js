/**
 * Integration tests for dataflow analysis queries.
 *
 * Uses a hand-crafted in-memory DB with known dataflow topology:
 *
 *   processData(input) → transform(input)       [flows_to, arg 0]
 *   processData        → format(result)          [flows_to, arg 0]
 *   transform          returns → processData     [returns]
 *   processData        mutates input.items       [mutates]
 *   pipeline()         → processData(raw)        [flows_to, arg 0]
 *   loadData           returns → pipeline        [returns]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { dataflowData, dataflowImpactData, dataflowPathData } from '../../src/dataflow.js';
import { initSchema } from '../../src/db.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function insertNode(db, name, kind, file, line) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid;
}

function insertDataflow(db, sourceId, targetId, kind, opts = {}) {
  db.prepare(
    'INSERT INTO dataflow (source_id, target_id, kind, param_index, expression, line, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    sourceId,
    targetId,
    kind,
    opts.paramIndex ?? null,
    opts.expression ?? null,
    opts.line ?? 1,
    opts.confidence ?? 1.0,
  );
}

// ─── Fixture DB ────────────────────────────────────────────────────────

let tmpDir, dbPath;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-dataflow-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // Nodes
  const processData = insertNode(db, 'processData', 'function', 'src/process.js', 10);
  const transform = insertNode(db, 'transform', 'function', 'src/transform.js', 5);
  const format = insertNode(db, 'format', 'function', 'src/format.js', 1);
  const pipeline = insertNode(db, 'pipeline', 'function', 'src/pipeline.js', 1);
  const loadData = insertNode(db, 'loadData', 'function', 'src/loader.js', 1);

  // Test file nodes
  const testHelper = insertNode(db, 'testProcessData', 'function', 'tests/process.test.js', 5);

  // flows_to: processData → transform (arg 0)
  insertDataflow(db, processData, transform, 'flows_to', {
    paramIndex: 0,
    expression: 'input',
    line: 12,
    confidence: 1.0,
  });

  // flows_to: processData → format (arg 0)
  insertDataflow(db, processData, format, 'flows_to', {
    paramIndex: 0,
    expression: 'result',
    line: 14,
    confidence: 0.9,
  });

  // returns: transform → processData (return value captured)
  insertDataflow(db, transform, processData, 'returns', {
    expression: 'const result = transform(input)',
    line: 12,
  });

  // mutates: processData mutates itself (parameter mutation)
  insertDataflow(db, processData, processData, 'mutates', {
    expression: 'input.items.push(newItem)',
    line: 15,
  });

  // flows_to: pipeline → processData (arg 0)
  insertDataflow(db, pipeline, processData, 'flows_to', {
    paramIndex: 0,
    expression: 'raw',
    line: 3,
    confidence: 1.0,
  });

  // returns: loadData → pipeline
  insertDataflow(db, loadData, pipeline, 'returns', {
    expression: 'const raw = loadData()',
    line: 2,
  });

  // flows_to from test file
  insertDataflow(db, testHelper, processData, 'flows_to', {
    paramIndex: 0,
    expression: 'testInput',
    line: 7,
  });

  db.close();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── dataflowData ──────────────────────────────────────────────────────

describe('dataflowData', () => {
  test('returns flows_to edges for a symbol', () => {
    const data = dataflowData('processData', dbPath, { noTests: true });
    expect(data.results).toHaveLength(1);
    const r = data.results[0];
    expect(r.name).toBe('processData');
    expect(r.flowsTo).toHaveLength(2);
    expect(r.flowsTo).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'transform', paramIndex: 0 }),
        expect.objectContaining({ target: 'format', paramIndex: 0, confidence: 0.9 }),
      ]),
    );
  });

  test('returns flowsFrom edges', () => {
    const data = dataflowData('transform', dbPath);
    const r = data.results[0];
    expect(r.flowsFrom).toHaveLength(1);
    expect(r.flowsFrom[0].source).toBe('processData');
  });

  test('returns return-value consumers', () => {
    const data = dataflowData('transform', dbPath);
    const r = data.results[0];
    expect(r.returns).toHaveLength(1);
    expect(r.returns[0].consumer).toBe('processData');
  });

  test('returns returnedBy edges', () => {
    const data = dataflowData('processData', dbPath);
    const r = data.results[0];
    expect(r.returnedBy).toHaveLength(1);
    expect(r.returnedBy[0].producer).toBe('transform');
  });

  test('returns mutates edges', () => {
    const data = dataflowData('processData', dbPath);
    const r = data.results[0];
    expect(r.mutates).toHaveLength(1);
    expect(r.mutates[0].expression).toContain('push');
  });

  test('returns empty results for unknown symbol', () => {
    const data = dataflowData('nonExistent', dbPath);
    expect(data.results).toHaveLength(0);
  });

  test('--no-tests excludes test file edges', () => {
    const data = dataflowData('processData', dbPath, { noTests: true });
    const r = data.results[0];
    // testHelper flows_to processData should be excluded
    const testFlows = r.flowsFrom.filter((f) => f.file?.includes('test'));
    expect(testFlows).toHaveLength(0);
  });

  test('pagination works', () => {
    const data = dataflowData('processData', dbPath, { limit: 1, offset: 0 });
    expect(data.results).toHaveLength(1);
  });
});

// ─── dataflowPathData ──────────────────────────────────────────────────

describe('dataflowPathData', () => {
  test('finds data flow path between two symbols', () => {
    const data = dataflowPathData('processData', 'format', dbPath);
    expect(data.found).toBe(true);
    expect(data.hops).toBeGreaterThan(0);
    expect(data.path).toBeDefined();
    expect(data.path[0].name).toBe('processData');
    expect(data.path[data.path.length - 1].name).toBe('format');
  });

  test('finds multi-hop path', () => {
    const data = dataflowPathData('pipeline', 'transform', dbPath);
    expect(data.found).toBe(true);
    expect(data.hops).toBeGreaterThanOrEqual(2);
  });

  test('returns found=false when no path exists', () => {
    const data = dataflowPathData('format', 'loadData', dbPath);
    expect(data.found).toBe(false);
  });

  test('handles self-path', () => {
    const data = dataflowPathData('processData', 'processData', dbPath);
    expect(data.found).toBe(true);
    expect(data.hops).toBe(0);
  });

  test('returns error for unknown symbol', () => {
    const data = dataflowPathData('nonExistent', 'format', dbPath);
    expect(data.found).toBe(false);
    expect(data.error).toBeDefined();
  });
});

// ─── dataflowImpactData ────────────────────────────────────────────────

describe('dataflowImpactData', () => {
  test('shows return-value-dependent blast radius', () => {
    const data = dataflowImpactData('transform', dbPath);
    expect(data.results).toHaveLength(1);
    const r = data.results[0];
    expect(r.totalAffected).toBeGreaterThan(0);
    // transform returns → processData
    expect(r.levels[1]).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'processData' })]),
    );
  });

  test('shows transitive impact through return chains', () => {
    const data = dataflowImpactData('loadData', dbPath);
    const r = data.results[0];
    // loadData returns → pipeline (level 1)
    expect(r.levels[1]).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'pipeline' })]),
    );
  });

  test('returns empty for symbol with no return consumers', () => {
    const data = dataflowImpactData('format', dbPath);
    const r = data.results[0];
    expect(r.totalAffected).toBe(0);
  });

  test('respects depth limit', () => {
    const data = dataflowImpactData('loadData', dbPath, { depth: 1 });
    const r = data.results[0];
    expect(r.levels[2]).toBeUndefined();
  });
});

// ─── Empty dataflow table ──────────────────────────────────────────────

describe('empty dataflow', () => {
  let emptyDbPath;

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-df-empty-'));
    fs.mkdirSync(path.join(dir, '.codegraph'));
    emptyDbPath = path.join(dir, '.codegraph', 'graph.db');
    const db = new Database(emptyDbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    // Insert a node but no dataflow edges
    insertNode(db, 'lonely', 'function', 'src/lonely.js', 1);
    db.close();
  });

  test('dataflowData returns warning when no dataflow data', () => {
    const data = dataflowData('lonely', emptyDbPath);
    expect(data.warning).toBeDefined();
    expect(data.results).toHaveLength(0);
  });

  test('dataflowPathData returns warning', () => {
    const data = dataflowPathData('lonely', 'lonely', emptyDbPath);
    expect(data.warning).toBeDefined();
  });

  test('dataflowImpactData returns warning', () => {
    const data = dataflowImpactData('lonely', emptyDbPath);
    expect(data.warning).toBeDefined();
  });
});
