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
import {
  MCP_DEFAULTS,
  MCP_MAX_LIMIT,
  paginate,
  paginateResult,
  printNdjson,
} from '../../src/paginate.js';
import {
  contextData,
  explainData,
  fileDepsData,
  fnDepsData,
  fnImpactData,
  iterListFunctions,
  iterRoles,
  iterWhere,
  listFunctionsData,
  queryNameData,
  rolesData,
  whereData,
} from '../../src/queries.js';

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

// ─── fileDepsData with pagination ─────────────────────────────────────

describe('fileDepsData with pagination', () => {
  test('backward compat: no limit returns all', () => {
    const data = fileDepsData('a.js', dbPath);
    expect(data._pagination).toBeUndefined();
    expect(data.results.length).toBeGreaterThan(0);
  });

  test('paginated results', () => {
    const full = fileDepsData('', dbPath);
    if (full.results.length > 1) {
      const paginated = fileDepsData('', dbPath, { limit: 1 });
      expect(paginated.results).toHaveLength(1);
      expect(paginated._pagination).toBeDefined();
      expect(paginated._pagination.hasMore).toBe(true);
    }
  });
});

// ─── fnDepsData with pagination ──────────────────────────────────────

describe('fnDepsData with pagination', () => {
  test('backward compat: no limit returns all', () => {
    const data = fnDepsData('alpha', dbPath);
    expect(data._pagination).toBeUndefined();
    expect(data.results.length).toBeGreaterThan(0);
  });

  test('paginated results', () => {
    const full = fnDepsData('a', dbPath);
    if (full.results.length > 1) {
      const paginated = fnDepsData('a', dbPath, { limit: 1 });
      expect(paginated.results).toHaveLength(1);
      expect(paginated._pagination).toBeDefined();
      expect(paginated._pagination.hasMore).toBe(true);
    }
  });
});

// ─── fnImpactData with pagination ────────────────────────────────────

describe('fnImpactData with pagination', () => {
  test('backward compat: no limit returns all', () => {
    const data = fnImpactData('alpha', dbPath);
    expect(data._pagination).toBeUndefined();
    expect(data.results.length).toBeGreaterThan(0);
  });

  test('paginated results', () => {
    const full = fnImpactData('a', dbPath);
    if (full.results.length > 1) {
      const paginated = fnImpactData('a', dbPath, { limit: 1 });
      expect(paginated.results).toHaveLength(1);
      expect(paginated._pagination).toBeDefined();
    }
  });
});

// ─── contextData with pagination ─────────────────────────────────────

describe('contextData with pagination', () => {
  test('backward compat: no limit returns all', () => {
    const data = contextData('alpha', dbPath);
    expect(data._pagination).toBeUndefined();
    expect(data.results.length).toBeGreaterThan(0);
  });

  test('paginated results', () => {
    const full = contextData('a', dbPath);
    if (full.results.length > 1) {
      const paginated = contextData('a', dbPath, { limit: 1 });
      expect(paginated.results).toHaveLength(1);
      expect(paginated._pagination).toBeDefined();
    }
  });
});

// ─── explainData with pagination ─────────────────────────────────────

describe('explainData with pagination', () => {
  test('backward compat: no limit returns all', () => {
    const data = explainData('a.js', dbPath);
    expect(data._pagination).toBeUndefined();
    expect(data.results.length).toBeGreaterThan(0);
  });

  test('paginated results', () => {
    const full = explainData('', dbPath);
    if (full.results.length > 1) {
      const paginated = explainData('', dbPath, { limit: 1 });
      expect(paginated.results).toHaveLength(1);
      expect(paginated._pagination).toBeDefined();
    }
  });
});

// ─── MCP new defaults ────────────────────────────────────────────────

describe('MCP new defaults', () => {
  test('MCP_DEFAULTS has new pagination keys', () => {
    expect(MCP_DEFAULTS.fn_deps).toBe(10);
    expect(MCP_DEFAULTS.fn_impact).toBe(5);
    expect(MCP_DEFAULTS.context).toBe(5);
    expect(MCP_DEFAULTS.explain).toBe(10);
    expect(MCP_DEFAULTS.file_deps).toBe(20);
    expect(MCP_DEFAULTS.diff_impact).toBe(30);
    expect(MCP_DEFAULTS.semantic_search).toBe(20);
    expect(MCP_DEFAULTS.execution_flow).toBe(50);
    expect(MCP_DEFAULTS.hotspots).toBe(20);
    expect(MCP_DEFAULTS.co_changes).toBe(20);
    expect(MCP_DEFAULTS.complexity).toBe(30);
    expect(MCP_DEFAULTS.manifesto).toBe(50);
    expect(MCP_DEFAULTS.communities).toBe(20);
    expect(MCP_DEFAULTS.structure).toBe(30);
  });
});

// ─── Iterator/Generator APIs ─────────────────────────────────────────

describe('iterListFunctions', () => {
  test('yields all functions matching listFunctionsData', () => {
    const full = listFunctionsData(dbPath);
    const iter = [...iterListFunctions(dbPath)];
    expect(iter.length).toBe(full.functions.length);
    for (const item of iter) {
      expect(item).toHaveProperty('name');
      expect(item).toHaveProperty('kind');
      expect(item).toHaveProperty('file');
      expect(item).toHaveProperty('line');
    }
  });

  test('early break closes DB (no leak)', () => {
    let count = 0;
    for (const _item of iterListFunctions(dbPath)) {
      count++;
      if (count >= 2) break;
    }
    expect(count).toBe(2);
    // If the DB leaked, subsequent operations would fail
    const data = listFunctionsData(dbPath);
    expect(data.functions.length).toBeGreaterThan(0);
  });

  test('noTests filtering works', () => {
    const all = [...iterListFunctions(dbPath)];
    const noTests = [...iterListFunctions(dbPath, { noTests: true })];
    // Should not include test files (fixture has none, so counts equal)
    expect(noTests.length).toBeLessThanOrEqual(all.length);
  });
});

describe('iterRoles', () => {
  test('yields all role-classified symbols', () => {
    const full = rolesData(dbPath);
    const iter = [...iterRoles(dbPath)];
    expect(iter.length).toBe(full.count);
    for (const item of iter) {
      expect(item.role).toBeTruthy();
    }
  });

  test('role filter works', () => {
    const coreOnly = [...iterRoles(dbPath, { role: 'core' })];
    for (const item of coreOnly) {
      expect(item.role).toBe('core');
    }
  });

  test('early break closes DB (no leak)', () => {
    let count = 0;
    for (const _item of iterRoles(dbPath)) {
      count++;
      if (count >= 1) break;
    }
    expect(count).toBe(1);
    const data = rolesData(dbPath);
    expect(data.count).toBeGreaterThan(0);
  });
});

describe('iterWhere', () => {
  test('yields matching symbols with uses', () => {
    const iter = [...iterWhere('alpha', dbPath)];
    expect(iter.length).toBeGreaterThan(0);
    const alpha = iter.find((r) => r.name === 'alpha');
    expect(alpha).toBeDefined();
    expect(alpha).toHaveProperty('exported');
    expect(alpha).toHaveProperty('uses');
    expect(Array.isArray(alpha.uses)).toBe(true);
  });

  test('early break closes DB (no leak)', () => {
    let count = 0;
    for (const _item of iterWhere('a', dbPath)) {
      count++;
      if (count >= 1) break;
    }
    expect(count).toBe(1);
    const data = whereData('alpha', dbPath);
    expect(data.results.length).toBeGreaterThan(0);
  });
});

// ─── printNdjson utility ─────────────────────────────────────────────

describe('printNdjson', () => {
  test('outputs JSON lines for array field', () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      printNdjson({ items: [{ a: 1 }, { b: 2 }] }, 'items');
      expect(logs).toHaveLength(2);
      expect(JSON.parse(logs[0])).toEqual({ a: 1 });
      expect(JSON.parse(logs[1])).toEqual({ b: 2 });
    } finally {
      console.log = origLog;
    }
  });

  test('emits _meta when _pagination exists', () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      printNdjson(
        { items: [{ x: 1 }], _pagination: { total: 10, offset: 0, limit: 1, hasMore: true } },
        'items',
      );
      expect(logs).toHaveLength(2);
      const meta = JSON.parse(logs[0]);
      expect(meta._meta).toBeDefined();
      expect(meta._meta.total).toBe(10);
    } finally {
      console.log = origLog;
    }
  });

  test('handles empty array', () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    try {
      printNdjson({ items: [] }, 'items');
      expect(logs).toHaveLength(0);
    } finally {
      console.log = origLog;
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
