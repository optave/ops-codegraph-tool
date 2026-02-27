/**
 * Integration tests for pagination utilities and paginated data functions.
 *
 * Tests cover:
 * - paginate() utility: no-op, slicing, hasMore, offset clamping, returned count
 * - paginateResult() utility: wraps result, preserves fields, no-op without limit
 * - listFunctionsData with pagination
 * - rolesData with pagination (summary still full)
 * - queryNameData with pagination
 * - whereData with pagination
 * - listEntryPointsData with pagination
 * - MCP default limits
 * - Export limiting (DOT/Mermaid truncation, JSON edge pagination)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db.js';
import { exportDOT, exportJSON, exportMermaid } from '../../src/export.js';
import { listEntryPointsData } from '../../src/flow.js';
import { MCP_DEFAULTS, MCP_MAX_LIMIT, paginate, paginateResult } from '../../src/paginate.js';
import { listFunctionsData, queryNameData, rolesData, whereData } from '../../src/queries.js';

// ─── Helpers ───────────────────────────────────────────────────────────

function insertNode(db, name, kind, file, line, role = null) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line, role) VALUES (?, ?, ?, ?, ?)')
    .run(name, kind, file, line, role).lastInsertRowid;
}

function insertEdge(db, sourceId, targetId, kind, confidence = 1.0) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, 0)',
  ).run(sourceId, targetId, kind, confidence);
}

// ─── Fixture DB ────────────────────────────────────────────────────────

let tmpDir, dbPath, dbForExport;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pagination-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // File nodes
  const fA = insertNode(db, 'a.js', 'file', 'a.js', 0);
  const fB = insertNode(db, 'b.js', 'file', 'b.js', 0);
  const fC = insertNode(db, 'c.js', 'file', 'c.js', 0);

  // Function nodes with roles
  const fn1 = insertNode(db, 'alpha', 'function', 'a.js', 1, 'entry');
  const fn2 = insertNode(db, 'beta', 'function', 'a.js', 10, 'core');
  const fn3 = insertNode(db, 'gamma', 'function', 'b.js', 1, 'utility');
  const fn4 = insertNode(db, 'delta', 'function', 'b.js', 10, 'leaf');
  const fn5 = insertNode(db, 'epsilon', 'function', 'c.js', 1, 'core');
  insertNode(db, 'route:GET /health', 'function', 'c.js', 20, 'entry');

  // Import edges
  insertEdge(db, fA, fB, 'imports');
  insertEdge(db, fB, fC, 'imports');
  insertEdge(db, fA, fC, 'imports');

  // Call edges
  insertEdge(db, fn1, fn2, 'calls');
  insertEdge(db, fn2, fn3, 'calls');
  insertEdge(db, fn3, fn4, 'calls');
  insertEdge(db, fn1, fn5, 'calls');
  insertEdge(db, fn5, fn4, 'calls');

  db.close();

  // Keep a read-only handle for export tests
  dbForExport = new Database(dbPath, { readonly: true });
});

afterAll(() => {
  if (dbForExport) dbForExport.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── paginate() utility ───────────────────────────────────────────────

describe('paginate()', () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  test('no-op without limit', () => {
    const result = paginate(items, {});
    expect(result.items).toEqual(items);
    expect(result.pagination).toBeUndefined();
  });

  test('no-op with undefined limit', () => {
    const result = paginate(items, { limit: undefined });
    expect(result.items).toEqual(items);
    expect(result.pagination).toBeUndefined();
  });

  test('correct slicing with limit', () => {
    const result = paginate(items, { limit: 3 });
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.pagination).toEqual({
      total: 10,
      offset: 0,
      limit: 3,
      hasMore: true,
      returned: 3,
    });
  });

  test('offset + limit', () => {
    const result = paginate(items, { limit: 3, offset: 5 });
    expect(result.items).toEqual([6, 7, 8]);
    expect(result.pagination.offset).toBe(5);
    expect(result.pagination.hasMore).toBe(true);
  });

  test('hasMore is false at end', () => {
    const result = paginate(items, { limit: 3, offset: 8 });
    expect(result.items).toEqual([9, 10]);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.returned).toBe(2);
  });

  test('offset clamping beyond length', () => {
    const result = paginate(items, { limit: 5, offset: 100 });
    expect(result.items).toEqual([]);
    expect(result.pagination.returned).toBe(0);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.offset).toBe(10);
  });

  test('negative offset treated as 0', () => {
    const result = paginate(items, { limit: 2, offset: -5 });
    expect(result.items).toEqual([1, 2]);
    expect(result.pagination.offset).toBe(0);
  });

  test('limit 0 returns empty page', () => {
    const result = paginate(items, { limit: 0 });
    expect(result.items).toEqual([]);
    expect(result.pagination.total).toBe(10);
    expect(result.pagination.returned).toBe(0);
  });
});

// ─── paginateResult() utility ─────────────────────────────────────────

describe('paginateResult()', () => {
  const result = { count: 5, functions: ['a', 'b', 'c', 'd', 'e'], extra: 'preserved' };

  test('no-op without limit', () => {
    const out = paginateResult(result, 'functions', {});
    expect(out).toEqual(result);
    expect(out._pagination).toBeUndefined();
  });

  test('wraps result correctly', () => {
    const out = paginateResult(result, 'functions', { limit: 2 });
    expect(out.functions).toEqual(['a', 'b']);
    expect(out._pagination.total).toBe(5);
    expect(out._pagination.hasMore).toBe(true);
    expect(out._pagination.returned).toBe(2);
  });

  test('preserves other fields', () => {
    const out = paginateResult(result, 'functions', { limit: 2 });
    expect(out.count).toBe(5);
    expect(out.extra).toBe('preserved');
  });

  test('non-array field returns result unchanged', () => {
    const obj = { count: 1, data: 'not-an-array' };
    const out = paginateResult(obj, 'data', { limit: 5 });
    expect(out).toEqual(obj);
  });
});

// ─── listFunctionsData with pagination ────────────────────────────────

describe('listFunctionsData with pagination', () => {
  test('backward compat: no limit returns all', () => {
    const data = listFunctionsData(dbPath);
    expect(data.functions.length).toBeGreaterThanOrEqual(5);
    expect(data._pagination).toBeUndefined();
  });

  test('returns page with _pagination', () => {
    const data = listFunctionsData(dbPath, { limit: 2 });
    expect(data.functions).toHaveLength(2);
    expect(data._pagination).toBeDefined();
    expect(data._pagination.total).toBeGreaterThanOrEqual(5);
    expect(data._pagination.hasMore).toBe(true);
    expect(data._pagination.returned).toBe(2);
  });

  test('second page via offset', () => {
    const page1 = listFunctionsData(dbPath, { limit: 2, offset: 0 });
    const page2 = listFunctionsData(dbPath, { limit: 2, offset: 2 });
    const names1 = page1.functions.map((f) => f.name);
    const names2 = page2.functions.map((f) => f.name);
    // Pages should not overlap
    for (const n of names2) {
      expect(names1).not.toContain(n);
    }
  });
});

// ─── rolesData with pagination ────────────────────────────────────────

describe('rolesData with pagination', () => {
  test('backward compat: no limit returns all', () => {
    const data = rolesData(dbPath);
    expect(data.symbols.length).toBeGreaterThanOrEqual(5);
    expect(data._pagination).toBeUndefined();
  });

  test('summary contains full aggregation even when paginated', () => {
    const full = rolesData(dbPath);
    const paginated = rolesData(dbPath, { limit: 2 });
    // Summary should be identical (computed before pagination)
    expect(paginated.summary).toEqual(full.summary);
    expect(paginated.count).toBe(full.count);
    expect(paginated.symbols).toHaveLength(2);
    expect(paginated._pagination.total).toBe(full.count);
  });
});

// ─── queryNameData with pagination ────────────────────────────────────

describe('queryNameData with pagination', () => {
  test('backward compat: no limit returns all', () => {
    const data = queryNameData('a', dbPath);
    expect(data._pagination).toBeUndefined();
  });

  test('paginated results', () => {
    const data = queryNameData('a', dbPath, { limit: 1 });
    expect(data.results).toHaveLength(1);
    expect(data._pagination).toBeDefined();
    expect(data._pagination.returned).toBe(1);
  });

  test('second page returns remaining', () => {
    const full = queryNameData('a', dbPath);
    if (full.results.length > 1) {
      const page2 = queryNameData('a', dbPath, { limit: 1, offset: 1 });
      expect(page2.results[0].name).toBe(full.results[1].name);
    }
  });
});

// ─── whereData with pagination ────────────────────────────────────────

describe('whereData with pagination', () => {
  test('backward compat: no limit returns all', () => {
    const data = whereData('alpha', dbPath);
    expect(data._pagination).toBeUndefined();
  });

  test('paginated results', () => {
    // 'a' should match multiple symbols
    const full = whereData('a', dbPath);
    if (full.results.length > 1) {
      const paginated = whereData('a', dbPath, { limit: 1 });
      expect(paginated.results).toHaveLength(1);
      expect(paginated._pagination).toBeDefined();
      expect(paginated._pagination.total).toBe(full.results.length);
    }
  });
});

// ─── listEntryPointsData with pagination ──────────────────────────────

describe('listEntryPointsData with pagination', () => {
  test('backward compat: no limit returns all', () => {
    const data = listEntryPointsData(dbPath);
    expect(data._pagination).toBeUndefined();
    expect(data.entries.length).toBeGreaterThanOrEqual(1);
  });

  test('paginated entries', () => {
    const full = listEntryPointsData(dbPath);
    const paginated = listEntryPointsData(dbPath, { limit: 1 });
    expect(paginated.entries).toHaveLength(Math.min(1, full.entries.length));
    if (full.entries.length > 1) {
      expect(paginated._pagination.hasMore).toBe(true);
    }
  });
});

// ─── MCP default limits ──────────────────────────────────────────────

describe('MCP defaults', () => {
  test('MCP_DEFAULTS has expected keys', () => {
    expect(MCP_DEFAULTS.list_functions).toBe(100);
    expect(MCP_DEFAULTS.query_function).toBe(50);
    expect(MCP_DEFAULTS.where).toBe(50);
    expect(MCP_DEFAULTS.node_roles).toBe(100);
    expect(MCP_DEFAULTS.list_entry_points).toBe(100);
    expect(MCP_DEFAULTS.export_graph).toBe(500);
  });

  test('MCP_MAX_LIMIT is 1000', () => {
    expect(MCP_MAX_LIMIT).toBe(1000);
  });

  test('MCP handler applies default limit to listFunctionsData', () => {
    // Simulate what the MCP handler does
    const limit = Math.min(MCP_DEFAULTS.list_functions, MCP_MAX_LIMIT);
    const data = listFunctionsData(dbPath, { limit, offset: 0 });
    expect(data._pagination).toBeDefined();
    expect(data._pagination.limit).toBe(100);
  });
});

// ─── Export limiting ─────────────────────────────────────────────────

describe('export limiting', () => {
  test('DOT truncation comment when limit exceeded', () => {
    const dot = exportDOT(dbForExport, { fileLevel: true, limit: 1 });
    expect(dot).toContain('// Truncated: showing');
  });

  test('DOT no truncation comment when under limit', () => {
    const dot = exportDOT(dbForExport, { fileLevel: true, limit: 1000 });
    expect(dot).not.toContain('// Truncated');
  });

  test('Mermaid truncation comment when limit exceeded', () => {
    const mermaid = exportMermaid(dbForExport, { fileLevel: true, limit: 1 });
    expect(mermaid).toContain('%% Truncated: showing');
  });

  test('Mermaid no truncation when under limit', () => {
    const mermaid = exportMermaid(dbForExport, { fileLevel: true, limit: 1000 });
    expect(mermaid).not.toContain('%% Truncated');
  });

  test('JSON edge pagination', () => {
    const full = exportJSON(dbForExport);
    if (full.edges.length > 1) {
      const paginated = exportJSON(dbForExport, { limit: 1 });
      expect(paginated.edges).toHaveLength(1);
      expect(paginated._pagination).toBeDefined();
      expect(paginated._pagination.total).toBe(full.edges.length);
      expect(paginated._pagination.hasMore).toBe(true);
    }
  });

  test('JSON no pagination without limit', () => {
    const result = exportJSON(dbForExport);
    expect(result._pagination).toBeUndefined();
  });
});
