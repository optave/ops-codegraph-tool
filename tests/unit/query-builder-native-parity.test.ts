/**
 * NodeQuery parity test: verifies that queryAll/queryGet through NativeDatabase
 * produces identical results to better-sqlite3 for all filter combinations.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSchema } from '../../src/db/migrations.js';
import { NodeQuery } from '../../src/db/query-builder.js';
import { getNative, isNativeAvailable } from '../../src/infrastructure/native.js';
import type { BetterSqlite3Database, NativeDatabase } from '../../src/types.js';

const hasNativeDb =
  isNativeAvailable() && typeof getNative().NativeDatabase?.prototype?.queryAll === 'function';

/**
 * Normalize row values for comparison — SQLite integer types may differ between
 * better-sqlite3 (BigInt for large values) and rusqlite (always i64 → number).
 */
function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[key] = typeof value === 'bigint' ? Number(value) : value;
    }
    return normalized;
  });
}

/** Seed identical data into both databases. */
const SEED_SQL = `
  INSERT INTO nodes (name, kind, file, line, role, exported) VALUES ('foo', 'function', 'src/core/foo.js', 1, 'core', 1);
  INSERT INTO nodes (name, kind, file, line, role, exported) VALUES ('bar', 'method', 'src/core/bar.js', 10, 'utility', 1);
  INSERT INTO nodes (name, kind, file, line, role, exported) VALUES ('Baz', 'class', 'src/baz.js', 20, 'entry', 0);
  INSERT INTO nodes (name, kind, file, line, role, exported) VALUES ('testHelper', 'function', 'src/foo.test.js', 1, 'dead', 0);
  INSERT INTO nodes (name, kind, file, line, role, exported) VALUES ('specHelper', 'function', 'src/bar.spec.js', 1, 'dead-leaf', 0);
  INSERT INTO nodes (name, kind, file, line, role, exported) VALUES ('__test__util', 'function', 'src/__tests__/util.js', 5, NULL, 0);
`;

/** Seed edges and complexity for JOIN tests. */
const SEED_EDGES_SQL = `
  INSERT INTO edges (source_id, target_id, kind, confidence, dynamic)
    SELECT b.id, f.id, 'calls', 1.0, 0
    FROM nodes b, nodes f WHERE b.name = 'bar' AND f.name = 'foo';
  INSERT INTO edges (source_id, target_id, kind, confidence, dynamic)
    SELECT bz.id, f.id, 'calls', 1.0, 0
    FROM nodes bz, nodes f WHERE bz.name = 'Baz' AND f.name = 'foo';
`;

const SEED_COMPLEXITY_SQL = `
  INSERT INTO function_complexity (node_id, cognitive, cyclomatic, max_nesting, halstead_volume, halstead_difficulty, halstead_effort, loc, maintainability_index)
    SELECT id, 5, 3, 2, 100, 10, 1000, 15, 80 FROM nodes WHERE name = 'foo';
  INSERT INTO function_complexity (node_id, cognitive, cyclomatic, max_nesting, halstead_volume, halstead_difficulty, halstead_effort, loc, maintainability_index)
    SELECT id, 12, 8, 4, 250, 20, 5000, 40, 55 FROM nodes WHERE name = 'bar';
`;

describe.skipIf(!hasNativeDb)('NodeQuery native parity', () => {
  let db: BetterSqlite3Database;
  let nativeDb: NativeDatabase;
  let tmpDir: string;

  beforeEach(() => {
    // better-sqlite3 in-memory
    db = new Database(':memory:') as unknown as BetterSqlite3Database;
    initSchema(db);
    db.exec(SEED_SQL);
    db.exec(SEED_EDGES_SQL);
    db.exec(SEED_COMPLEXITY_SQL);

    // NativeDatabase on temp file
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-parity-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const NativeDB = getNative().NativeDatabase;
    nativeDb = NativeDB.openReadWrite(dbPath);
    nativeDb.initSchema();
    nativeDb.exec(SEED_SQL);
    nativeDb.exec(SEED_EDGES_SQL);
    nativeDb.exec(SEED_COMPLEXITY_SQL);
  });

  afterEach(() => {
    db.close();
    nativeDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Run a NodeQuery through both engines and assert identical results. */
  function assertParity(q: InstanceType<typeof NodeQuery>): void {
    const jsRows = normalizeRows(q.all(db) as Record<string, unknown>[]);
    const nativeRows = normalizeRows(q.all(db, nativeDb) as Record<string, unknown>[]);
    expect(nativeRows).toEqual(jsRows);
  }

  /** Run queryGet parity. */
  function assertGetParity(q: InstanceType<typeof NodeQuery>): void {
    const jsRow = q.get(db) as Record<string, unknown> | undefined;
    const nativeRow = q.get(db, nativeDb) as Record<string, unknown> | undefined;
    const jsNormalized = jsRow ? normalizeRows([jsRow])[0] : undefined;
    const nativeNormalized = nativeRow ? normalizeRows([nativeRow])[0] : undefined;
    expect(nativeNormalized).toEqual(jsNormalized);
  }

  // ── Basic filters ────────────────────────────────────────────────────

  it('no filters', () => {
    assertParity(new NodeQuery());
  });

  it('kinds: single', () => {
    assertParity(new NodeQuery().kinds(['function']));
  });

  it('kinds: multiple', () => {
    assertParity(new NodeQuery().kinds(['function', 'method', 'class']));
  });

  it('kindFilter: exact', () => {
    assertParity(new NodeQuery().kindFilter('class'));
  });

  it('fileFilter: single string', () => {
    assertParity(new NodeQuery().fileFilter('core'));
  });

  it('fileFilter: array', () => {
    assertParity(new NodeQuery().fileFilter(['foo', 'bar']));
  });

  it('fileFilter: with LIKE wildcards', () => {
    assertParity(new NodeQuery().fileFilter('__test__'));
  });

  it('nameLike: basic', () => {
    assertParity(new NodeQuery().nameLike('ba'));
  });

  it('nameLike: with underscore (LIKE wildcard)', () => {
    assertParity(new NodeQuery().nameLike('_oo'));
  });

  it('roleFilter: exact', () => {
    assertParity(new NodeQuery().roleFilter('core'));
  });

  it('roleFilter: dead prefix match', () => {
    assertParity(new NodeQuery().roleFilter('dead'));
  });

  it('excludeTests: true', () => {
    assertParity(new NodeQuery().excludeTests(true));
  });

  it('excludeTests: false', () => {
    assertParity(new NodeQuery().excludeTests(false));
  });

  // ── ORDER BY & LIMIT ────────────────────────────────────────────────

  it('orderBy: single column', () => {
    assertParity(new NodeQuery().orderBy('n.name'));
  });

  it('orderBy: multiple columns with direction', () => {
    assertParity(new NodeQuery().orderBy('n.file ASC, n.line DESC'));
  });

  it('limit', () => {
    assertParity(new NodeQuery().orderBy('n.name').limit(2));
  });

  // ── Custom SELECT ───────────────────────────────────────────────────

  it('custom select', () => {
    assertParity(new NodeQuery().select('n.name, n.kind, n.file'));
  });

  // ── JOINs ───────────────────────────────────────────────────────────

  it('withFanIn', () => {
    assertParity(
      new NodeQuery().select('n.name, COALESCE(fi.cnt, 0) AS fan_in').withFanIn().orderBy('n.name'),
    );
  });

  it('withFanOut', () => {
    assertParity(
      new NodeQuery()
        .select('n.name, COALESCE(fo.cnt, 0) AS fan_out')
        .withFanOut()
        .orderBy('n.name'),
    );
  });

  it('withComplexity', () => {
    assertParity(
      new NodeQuery()
        .select('n.name, COALESCE(fc.cognitive, 0) AS cog')
        .withComplexity()
        .orderBy('n.name'),
    );
  });

  // ── Combined filters ────────────────────────────────────────────────

  it('kinds + fileFilter + excludeTests', () => {
    assertParity(
      new NodeQuery().kinds(['function', 'method']).fileFilter('core').excludeTests(true),
    );
  });

  it('kinds + roleFilter + orderBy + limit', () => {
    assertParity(
      new NodeQuery().kinds(['function']).roleFilter('core').orderBy('n.name DESC').limit(5),
    );
  });

  it('full triage query (all JOINs + filters)', () => {
    assertParity(
      new NodeQuery()
        .select(
          `n.id, n.name, n.kind, n.file, n.line,
           COALESCE(fi.cnt, 0) AS fan_in,
           COALESCE(fc.cognitive, 0) AS cognitive`,
        )
        .kinds(['function', 'method', 'class'])
        .withFanIn()
        .withComplexity()
        .excludeTests(true)
        .fileFilter('core')
        .orderBy('n.file, n.line'),
    );
  });

  it('raw where clause', () => {
    assertParity(new NodeQuery().where('n.line > ?', 5));
  });

  // ── queryGet parity ─────────────────────────────────────────────────

  it('queryGet: first row', () => {
    assertGetParity(new NodeQuery().orderBy('n.name').limit(1));
  });

  it('queryGet: no match', () => {
    assertGetParity(new NodeQuery().where("n.name = 'nonexistent'"));
  });
});
