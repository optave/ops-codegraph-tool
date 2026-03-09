import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSchema } from '../../src/db/migrations.js';
import {
  fanInJoinSQL,
  fanOutJoinSQL,
  kindInClause,
  NodeQuery,
  testFilterSQL,
} from '../../src/db/query-builder.js';

// ─── testFilterSQL ───────────────────────────────────────────────────

describe('testFilterSQL', () => {
  it('returns 5 NOT LIKE conditions with default column', () => {
    const sql = testFilterSQL();
    expect(sql).toContain("n.file NOT LIKE '%.test.%'");
    expect(sql).toContain("n.file NOT LIKE '%.spec.%'");
    expect(sql).toContain("n.file NOT LIKE '%__test__%'");
    expect(sql).toContain("n.file NOT LIKE '%__tests__%'");
    expect(sql).toContain("n.file NOT LIKE '%.stories.%'");
  });

  it('uses custom column', () => {
    const sql = testFilterSQL('n.name');
    expect(sql).toContain("n.name NOT LIKE '%.test.%'");
    expect(sql).not.toContain('n.file');
  });

  it('returns empty string when disabled', () => {
    expect(testFilterSQL('n.file', false)).toBe('');
  });

  it('rejects malicious column names', () => {
    expect(() => testFilterSQL("1; DROP TABLE nodes --")).toThrow('Invalid SQL column');
    expect(() => testFilterSQL("n.file OR 1=1 --")).toThrow('Invalid SQL column');
  });
});

// ─── kindInClause ────────────────────────────────────────────────────

describe('kindInClause', () => {
  it('returns correct placeholders and params', () => {
    const result = kindInClause(['function', 'method', 'class']);
    expect(result.placeholders).toBe('?, ?, ?');
    expect(result.params).toEqual(['function', 'method', 'class']);
  });

  it('handles single kind', () => {
    const result = kindInClause(['function']);
    expect(result.placeholders).toBe('?');
    expect(result.params).toEqual(['function']);
  });
});

// ─── fanInJoinSQL / fanOutJoinSQL ────────────────────────────────────

describe('fanInJoinSQL', () => {
  it('returns LEFT JOIN with default alias and kind', () => {
    const sql = fanInJoinSQL();
    expect(sql).toContain('LEFT JOIN');
    expect(sql).toContain('target_id');
    expect(sql).toContain("kind = 'calls'");
    expect(sql).toContain('fi');
  });

  it('accepts custom edge kind and alias', () => {
    const sql = fanInJoinSQL('imports', 'imp');
    expect(sql).toContain("kind = 'imports'");
    expect(sql).toContain('imp');
  });
});

describe('fanOutJoinSQL', () => {
  it('returns LEFT JOIN with source_id', () => {
    const sql = fanOutJoinSQL();
    expect(sql).toContain('LEFT JOIN');
    expect(sql).toContain('source_id');
    expect(sql).toContain("kind = 'calls'");
    expect(sql).toContain('fo');
  });

  it('accepts custom edge kind and alias', () => {
    const sql = fanOutJoinSQL('imports', 'imp');
    expect(sql).toContain("kind = 'imports'");
    expect(sql).toContain('imp');
  });
});

// ─── NodeQuery ───────────────────────────────────────────────────────

describe('NodeQuery', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    // Seed test data
    const insert = db.prepare(
      'INSERT INTO nodes (name, kind, file, line, role) VALUES (?, ?, ?, ?, ?)',
    );
    insert.run('foo', 'function', 'src/foo.js', 1, 'core');
    insert.run('bar', 'method', 'src/bar.js', 10, 'utility');
    insert.run('Baz', 'class', 'src/baz.js', 20, 'entry');
    insert.run('testHelper', 'function', 'src/foo.test.js', 1, null);
    insert.run('specHelper', 'function', 'src/bar.spec.js', 1, null);

    // Add an edge for fan-in
    const fooId = db.prepare("SELECT id FROM nodes WHERE name = 'foo'").get().id;
    const barId = db.prepare("SELECT id FROM nodes WHERE name = 'bar'").get().id;
    db.prepare('INSERT INTO edges (source_id, target_id, kind) VALUES (?, ?, ?)').run(
      barId,
      fooId,
      'calls',
    );
  });

  afterEach(() => {
    db.close();
  });

  it('.build() returns sql and params', () => {
    const { sql, params } = new NodeQuery().kinds(['function']).build();
    expect(sql).toContain('SELECT n.*');
    expect(sql).toContain('FROM nodes n');
    expect(sql).toContain('n.kind IN (?)');
    expect(params).toEqual(['function']);
  });

  it('.select() changes columns', () => {
    const { sql } = new NodeQuery().select('n.name, n.kind').build();
    expect(sql).toContain('SELECT n.name, n.kind');
  });

  it('.kinds() filters by kind', () => {
    const rows = new NodeQuery().kinds(['function']).all(db);
    expect(rows.every((r) => r.kind === 'function')).toBe(true);
  });

  it('.excludeTests() filters test files', () => {
    const all = new NodeQuery().all(db);
    const noTests = new NodeQuery().excludeTests(true).all(db);
    expect(all.length).toBeGreaterThan(noTests.length);
    expect(noTests.every((r) => !r.file.includes('.test.') && !r.file.includes('.spec.'))).toBe(
      true,
    );
  });

  it('.excludeTests(false) is a no-op', () => {
    const all = new NodeQuery().all(db);
    const noOp = new NodeQuery().excludeTests(false).all(db);
    expect(noOp.length).toBe(all.length);
  });

  it('.fileFilter() filters by file', () => {
    const rows = new NodeQuery().fileFilter('foo').all(db);
    expect(rows.every((r) => r.file.includes('foo'))).toBe(true);
  });

  it('.kindFilter() filters by exact kind', () => {
    const rows = new NodeQuery().kindFilter('class').all(db);
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('Baz');
  });

  it('.roleFilter() filters by role', () => {
    const rows = new NodeQuery().roleFilter('core').all(db);
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('foo');
  });

  it('.nameLike() filters by name pattern', () => {
    const rows = new NodeQuery().nameLike('ba').all(db);
    expect(rows.every((r) => r.name.toLowerCase().includes('ba'))).toBe(true);
  });

  it('.where() adds raw condition', () => {
    const rows = new NodeQuery().where('n.line > ?', 5).all(db);
    expect(rows.every((r) => r.line > 5)).toBe(true);
  });

  it('.withFanIn() adds fan-in join', () => {
    const rows = new NodeQuery()
      .select('n.name, COALESCE(fi.cnt, 0) AS fan_in')
      .withFanIn()
      .where("n.name = 'foo'")
      .all(db);
    expect(rows[0].fan_in).toBe(1);
  });

  it('.withComplexity() adds complexity join', () => {
    const { sql } = new NodeQuery().withComplexity().build();
    expect(sql).toContain('function_complexity');
  });

  it('.withChurn() adds churn join', () => {
    const { sql } = new NodeQuery().withChurn().build();
    expect(sql).toContain('file_commit_counts');
  });

  it('.join() adds raw join', () => {
    const { sql } = new NodeQuery().join('JOIN node_metrics nm ON n.id = nm.node_id').build();
    expect(sql).toContain('JOIN node_metrics nm ON n.id = nm.node_id');
  });

  it('.orderBy() adds ORDER BY', () => {
    const { sql } = new NodeQuery().orderBy('n.file, n.line').build();
    expect(sql).toContain('ORDER BY n.file, n.line');
  });

  it('.limit() adds LIMIT param', () => {
    const { sql, params } = new NodeQuery().limit(10).build();
    expect(sql).toContain('LIMIT ?');
    expect(params).toContain(10);
  });

  it('.get() returns first row', () => {
    const row = new NodeQuery().where("n.name = 'foo'").get(db);
    expect(row.name).toBe('foo');
  });

  it('.iterate() returns an iterator', () => {
    const iter = new NodeQuery().kinds(['function']).excludeTests(true).iterate(db);
    const rows = [...iter];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.kind === 'function')).toBe(true);
  });

  it('chaining composes multiple conditions with AND', () => {
    const { sql, params } = new NodeQuery()
      .kinds(['function', 'method'])
      .fileFilter('src')
      .roleFilter('core')
      .build();
    expect(sql).toContain('n.kind IN (?, ?)');
    expect(sql).toContain('n.file LIKE ?');
    expect(sql).toContain('n.role = ?');
    // All connected with AND
    const whereClause = sql.split('WHERE')[1];
    expect(whereClause.match(/AND/g).length).toBe(2);
    expect(params).toEqual(['function', 'method', '%src%', 'core']);
  });
});
