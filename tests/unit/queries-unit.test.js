/**
 * Unit tests for src/queries.js
 *
 * Extends integration/queries.test.js with coverage for:
 * - class hierarchy (extends edges, resolveMethodViaHierarchy)
 * - transitive callers (depth > 1, cycles in BFS)
 * - fnImpactData — multi-level BFS, noTests filter, empty results
 * - diffImpactData — mocked git diff
 * - display wrappers — console.log capture, JSON mode, no-results edge cases
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initSchema } from '../../src/db.js';
import {
  diffImpact,
  diffImpactData,
  fileDeps,
  fnDeps,
  fnDepsData,
  fnImpact,
  fnImpactData,
  impactAnalysis,
  moduleMap,
  queryName,
} from '../../src/queries.js';

// ─── Helpers ───────────────────────────────────────────────────────────

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

// ─── Fixture DB ────────────────────────────────────────────────────────
//
// Graph:
//   Files: lib/base.js, lib/child.js, app/handler.js, app/handler.test.js
//
//   Classes: BaseService (base.js:5), ChildService (child.js:5)
//   Methods: BaseService.process (base.js:10), ChildService.process (child.js:10)
//   Functions: handleRequest (handler.js:5), testHelper (handler.test.js:5)
//
//   Extends: ChildService -> BaseService
//   Imports: child.js -> base.js, handler.js -> child.js
//   Calls:
//     handleRequest -> ChildService.process
//     testHelper -> handleRequest
//     ChildService.process -> BaseService.process  (intra-hierarchy)

let tmpDir, dbPath;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-queries-unit-'));
  fs.mkdirSync(path.join(tmpDir, '.git'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // File nodes (IDs used for import edges below)
  const fBase = insertNode(db, 'lib/base.js', 'file', 'lib/base.js', 0);
  const fChild = insertNode(db, 'lib/child.js', 'file', 'lib/child.js', 0);
  const fHandler = insertNode(db, 'app/handler.js', 'file', 'app/handler.js', 0);
  insertNode(db, 'app/handler.test.js', 'file', 'app/handler.test.js', 0);

  // Class nodes
  const baseClass = insertNode(db, 'BaseService', 'class', 'lib/base.js', 5);
  const childClass = insertNode(db, 'ChildService', 'class', 'lib/child.js', 5);

  // Method nodes
  const baseProcess = insertNode(db, 'BaseService.process', 'method', 'lib/base.js', 10);
  const childProcess = insertNode(db, 'ChildService.process', 'method', 'lib/child.js', 10);

  // Function nodes
  const handleRequest = insertNode(db, 'handleRequest', 'function', 'app/handler.js', 5);
  const testHelper = insertNode(db, 'testHelper', 'function', 'app/handler.test.js', 5);

  // Extends edges
  insertEdge(db, childClass, baseClass, 'extends');

  // Import edges
  insertEdge(db, fChild, fBase, 'imports');
  insertEdge(db, fHandler, fChild, 'imports');

  // Call edges
  insertEdge(db, handleRequest, childProcess, 'calls');
  insertEdge(db, testHelper, handleRequest, 'calls');
  insertEdge(db, childProcess, baseProcess, 'calls');

  db.close();
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Class hierarchy helpers ──────────────────────────────────────────

describe('fnDepsData — class hierarchy', () => {
  it('resolves method via hierarchy (ChildService.process includes BaseService.process callers)', () => {
    const data = fnDepsData('ChildService.process', dbPath);
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    const r = data.results.find((r) => r.name === 'ChildService.process');
    expect(r).toBeDefined();
    expect(r.callers.map((c) => c.name)).toContain('handleRequest');
  });

  it('finds direct callees of method', () => {
    const data = fnDepsData('ChildService.process', dbPath);
    const r = data.results.find((r) => r.name === 'ChildService.process');
    expect(r.callees.map((c) => c.name)).toContain('BaseService.process');
  });
});

// ─── Transitive callers ───────────────────────────────────────────────

describe('fnDepsData — transitive callers', () => {
  it('returns transitive callers at depth 2', () => {
    const data = fnDepsData('ChildService.process', dbPath, { depth: 3 });
    const r = data.results.find((r) => r.name === 'ChildService.process');
    // handleRequest calls ChildService.process (depth 1 caller)
    // testHelper calls handleRequest (depth 2 transitive caller)
    expect(r.callers.map((c) => c.name)).toContain('handleRequest');
    const depth2 = r.transitiveCallers[2];
    expect(depth2).toBeDefined();
    expect(depth2.map((c) => c.name)).toContain('testHelper');
  });

  it('returns empty results for nonexistent function', () => {
    const data = fnDepsData('nonexistentFunction', dbPath);
    expect(data.results).toHaveLength(0);
  });
});

// ─── fnDepsData — noTests filter ──────────────────────────────────────

describe('fnDepsData — noTests filter', () => {
  it('filters out test-file nodes when noTests is true', () => {
    const data = fnDepsData('handleRequest', dbPath, { noTests: true });
    const r = data.results.find((r) => r.name === 'handleRequest');
    expect(r).toBeDefined();
    const callerFiles = r.callers.map((c) => c.file);
    for (const f of callerFiles) {
      expect(f).not.toMatch(/\.test\./);
    }
  });
});

// ─── fnImpactData ─────────────────────────────────────────────────────

describe('fnImpactData', () => {
  it('returns multi-level callers BFS', () => {
    const data = fnImpactData('ChildService.process', dbPath);
    const r = data.results.find((r) => r.name === 'ChildService.process');
    expect(r).toBeDefined();
    expect(r.levels[1].map((n) => n.name)).toContain('handleRequest');
    expect(r.totalDependents).toBeGreaterThanOrEqual(1);
  });

  it('filters test files with noTests', () => {
    const data = fnImpactData('handleRequest', dbPath, { noTests: true });
    const r = data.results.find((r) => r.name === 'handleRequest');
    expect(r).toBeDefined();
    // testHelper is in a test file, should be excluded
    for (const [, fns] of Object.entries(r.levels)) {
      for (const fn of fns) {
        expect(fn.file).not.toMatch(/\.test\./);
      }
    }
  });

  it('returns empty results for nonexistent name', () => {
    const data = fnImpactData('nonexistentFunc', dbPath);
    expect(data.results).toHaveLength(0);
  });
});

// ─── diffImpactData — mocked git ─────────────────────────────────────

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
  };
});

describe('diffImpactData — mocked git diff', () => {
  it('parses diff output and finds affected functions', async () => {
    const { execFileSync: mockExecFile } = await import('node:child_process');
    mockExecFile.mockImplementationOnce(() => {
      return [
        'diff --git a/app/handler.js b/app/handler.js',
        '--- a/app/handler.js',
        '+++ b/app/handler.js',
        '@@ -5,3 +5,4 @@',
        '+  // changed line',
      ].join('\n');
    });

    const data = diffImpactData(dbPath);
    expect(data.changedFiles).toBe(1);
    expect(data.affectedFunctions.length).toBeGreaterThanOrEqual(1);
    expect(data.affectedFunctions[0].name).toBe('handleRequest');

    mockExecFile.mockRestore();
  });

  it('returns empty when diff has no output', async () => {
    const { execFileSync: mockExecFile } = await import('node:child_process');
    mockExecFile.mockImplementationOnce(() => '');

    const data = diffImpactData(dbPath);
    expect(data.changedFiles).toBe(0);
    expect(data.affectedFunctions).toEqual([]);

    mockExecFile.mockRestore();
  });

  it('returns error when git fails', async () => {
    const { execFileSync: mockExecFile } = await import('node:child_process');
    mockExecFile.mockImplementationOnce(() => {
      throw new Error('git not found');
    });

    const data = diffImpactData(dbPath);
    expect(data.error).toMatch(/git diff/i);

    mockExecFile.mockRestore();
  });
});

// ─── Display wrappers ─────────────────────────────────────────────────

describe('queryName (display)', () => {
  it('outputs JSON when opts.json is true', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    queryName('handleRequest', dbPath, { json: true });
    expect(spy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output).toHaveProperty('query', 'handleRequest');
    expect(output).toHaveProperty('results');
    spy.mockRestore();
  });

  it('outputs human-readable format', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    queryName('handleRequest', dbPath);
    const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('handleRequest');
    spy.mockRestore();
  });

  it('outputs "No results" for unknown name', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    queryName('zzzzNotExist', dbPath);
    const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('No results');
    spy.mockRestore();
  });
});

describe('impactAnalysis (display)', () => {
  it('outputs JSON when opts.json is true', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    impactAnalysis('lib/base.js', dbPath, { json: true });
    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output).toHaveProperty('file');
    spy.mockRestore();
  });

  it('outputs "No file matching" for unknown file', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    impactAnalysis('zzzzNotExist.js', dbPath);
    const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('No file matching');
    spy.mockRestore();
  });

  it('outputs human-readable impact levels', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    impactAnalysis('lib/base.js', dbPath);
    const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toMatch(/impact/i);
    expect(allOutput).toContain('lib/base.js');
    spy.mockRestore();
  });
});

describe('moduleMap (display)', () => {
  it('outputs JSON when opts.json is true', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    moduleMap(dbPath, 20, { json: true });
    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output).toHaveProperty('stats');
    spy.mockRestore();
  });

  it('outputs human-readable module map', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    moduleMap(dbPath);
    const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
    // should include file/symbol/edge stats
    expect(allOutput).toMatch(/files|nodes|edges/i);
    spy.mockRestore();
  });
});

describe('fileDeps (display)', () => {
  it('outputs JSON when opts.json is true', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fileDeps('lib/child.js', dbPath, { json: true });
    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output).toHaveProperty('file');
    spy.mockRestore();
  });

  it('outputs "No file matching" for unknown file', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fileDeps('zzzzNotExist.js', dbPath);
    const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('No file matching');
    spy.mockRestore();
  });

  it('outputs human-readable file deps', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fileDeps('lib/child.js', dbPath);
    const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
    // should include the file path and import/dependency info
    expect(allOutput).toContain('lib/child.js');
    expect(allOutput).toMatch(/import/i);
    spy.mockRestore();
  });
});

describe('fnDeps (display)', () => {
  it('outputs JSON when opts.json is true', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fnDeps('handleRequest', dbPath, { json: true });
    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output).toHaveProperty('name');
    spy.mockRestore();
  });

  it('outputs "No function" for unknown name', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fnDeps('zzzzNotExist', dbPath);
    const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('No function');
    spy.mockRestore();
  });

  it('outputs human-readable fn deps', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fnDeps('handleRequest', dbPath);
    const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('handleRequest');
    spy.mockRestore();
  });
});

describe('fnImpact (display)', () => {
  it('outputs JSON when opts.json is true', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fnImpact('ChildService.process', dbPath, { json: true });
    const output = JSON.parse(spy.mock.calls[0][0]);
    expect(output).toHaveProperty('name');
    spy.mockRestore();
  });

  it('outputs "No function" for unknown name', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fnImpact('zzzzNotExist', dbPath);
    const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('No function');
    spy.mockRestore();
  });

  it('outputs human-readable impact with levels', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fnImpact('ChildService.process', dbPath);
    const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toMatch(/impact/i);
    expect(allOutput).toContain('ChildService.process');
    spy.mockRestore();
  });

  it('outputs "No callers" when function has no callers', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fnImpact('testHelper', dbPath);
    const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('No callers found');
    spy.mockRestore();
  });
});

describe('diffImpact (display)', () => {
  it('outputs JSON when opts.json is true', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    diffImpact(dbPath, { json: true });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('outputs error message on git failure', async () => {
    const { execFileSync: mockExecFile } = await import('node:child_process');
    mockExecFile.mockImplementationOnce(() => {
      throw new Error('git not found');
    });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    diffImpact(dbPath);
    const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toMatch(/git diff|git/i);
    spy.mockRestore();
    mockExecFile.mockRestore();
  });

  it('outputs "No changes" when diff is empty', async () => {
    const { execFileSync: mockExecFile } = await import('node:child_process');
    mockExecFile.mockImplementationOnce(() => '');

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    diffImpact(dbPath);
    const allOutput = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(allOutput).toContain('No changes');
    spy.mockRestore();
    mockExecFile.mockRestore();
  });
});
