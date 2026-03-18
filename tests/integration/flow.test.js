/**
 * Integration tests for execution flow tracing (Backlog Item 12).
 *
 * Uses a hand-crafted in-memory DB with known graph topology:
 *
 *   route:GET /users -> validateAuth -> checkToken [leaf]
 *                    -> fetchUsers   -> queryDB [leaf]
 *                                    -> formatResponse [leaf]
 *   command:build    -> loadConfig [leaf]
 *                    -> processFiles -> parseFile [leaf]
 *   event:connection -> setupSocket [leaf]
 *   orphanFn         (no callers, no prefix → dead)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { entryPointType, flowData, listEntryPointsData } from '../../src/features/flow.js';
import { classifyNodeRoles, FRAMEWORK_ENTRY_PREFIXES } from '../../src/features/structure.js';

// ─── Helpers ───────────────────────────────────────────────────────────

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

// ─── Fixture DB ────────────────────────────────────────────────────────

let tmpDir, dbPath;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-flow-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // File nodes
  const fRoutes = insertNode(db, 'routes.js', 'file', 'routes.js', 0);
  const fAuth = insertNode(db, 'auth.js', 'file', 'auth.js', 0);
  const fUsers = insertNode(db, 'users.js', 'file', 'users.js', 0);
  insertNode(db, 'build.js', 'file', 'build.js', 0);
  insertNode(db, 'socket.js', 'file', 'socket.js', 0);
  insertNode(db, 'orphan.js', 'file', 'orphan.js', 0);

  // Route entry point
  const getUsers = insertNode(db, 'route:GET /users', 'function', 'routes.js', 5);
  // Auth functions
  const validateAuth = insertNode(db, 'validateAuth', 'function', 'auth.js', 1);
  const checkToken = insertNode(db, 'checkToken', 'function', 'auth.js', 10);
  // User functions
  const fetchUsers = insertNode(db, 'fetchUsers', 'function', 'users.js', 1);
  const queryDB = insertNode(db, 'queryDB', 'function', 'users.js', 10);
  const formatResponse = insertNode(db, 'formatResponse', 'function', 'users.js', 20);

  // Command entry point
  const cmdBuild = insertNode(db, 'command:build', 'function', 'build.js', 1);
  const loadConfig = insertNode(db, 'loadConfig', 'function', 'build.js', 10);
  const processFiles = insertNode(db, 'processFiles', 'function', 'build.js', 20);
  const parseFile = insertNode(db, 'parseFile', 'function', 'build.js', 30);

  // Event entry point
  const evtConnection = insertNode(db, 'event:connection', 'function', 'socket.js', 1);
  const setupSocket = insertNode(db, 'setupSocket', 'function', 'socket.js', 10);

  // Orphan (no prefix, no callers)
  insertNode(db, 'orphanFn', 'function', 'orphan.js', 1);

  // Non-prefixed entry point (simulates an exported function with no callers)
  insertNode(db, 'init.js', 'file', 'init.js', 0);
  insertNode(db, 'exportedInit', 'function', 'init.js', 1);

  // Import edges
  insertEdge(db, fRoutes, fAuth, 'imports');
  insertEdge(db, fRoutes, fUsers, 'imports');

  // Call edges: route:GET /users -> validateAuth -> checkToken
  insertEdge(db, getUsers, validateAuth, 'calls');
  insertEdge(db, validateAuth, checkToken, 'calls');
  // route:GET /users -> fetchUsers -> queryDB, formatResponse
  insertEdge(db, getUsers, fetchUsers, 'calls');
  insertEdge(db, fetchUsers, queryDB, 'calls');
  insertEdge(db, fetchUsers, formatResponse, 'calls');

  // command:build -> loadConfig, processFiles -> parseFile
  insertEdge(db, cmdBuild, loadConfig, 'calls');
  insertEdge(db, cmdBuild, processFiles, 'calls');
  insertEdge(db, processFiles, parseFile, 'calls');

  // event:connection -> setupSocket
  insertEdge(db, evtConnection, setupSocket, 'calls');

  // Classify roles (so we can test the fix)
  classifyNodeRoles(db);

  // Manually mark exportedInit as 'entry' (simulates a real exported function
  // with fan_in=0 that the builder would classify as entry)
  db.prepare("UPDATE nodes SET role = 'entry' WHERE name = 'exportedInit'").run();

  db.close();
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── entryPointType ────────────────────────────────────────────────────

describe('entryPointType', () => {
  test('identifies route prefix', () => {
    expect(entryPointType('route:GET /users')).toBe('route');
  });

  test('identifies event prefix', () => {
    expect(entryPointType('event:connection')).toBe('event');
  });

  test('identifies command prefix', () => {
    expect(entryPointType('command:build')).toBe('command');
  });

  test('returns null for non-prefixed names', () => {
    expect(entryPointType('fetchUsers')).toBeNull();
    expect(entryPointType('orphanFn')).toBeNull();
  });
});

// ─── FRAMEWORK_ENTRY_PREFIXES ──────────────────────────────────────────

describe('FRAMEWORK_ENTRY_PREFIXES', () => {
  test('exports expected prefixes', () => {
    expect(FRAMEWORK_ENTRY_PREFIXES).toContain('route:');
    expect(FRAMEWORK_ENTRY_PREFIXES).toContain('event:');
    expect(FRAMEWORK_ENTRY_PREFIXES).toContain('command:');
  });
});

// ─── flowData ──────────────────────────────────────────────────────────

describe('flowData', () => {
  test('forward BFS from route entry reaches 5 nodes, finds 3 leaves', () => {
    const data = flowData('route:GET /users', dbPath);
    expect(data.entry).not.toBeNull();
    expect(data.entry.name).toBe('route:GET /users');
    expect(data.entry.type).toBe('route');
    expect(data.totalReached).toBe(5);
    expect(data.leaves).toHaveLength(3);
    const leafNames = data.leaves.map((l) => l.name).sort();
    expect(leafNames).toEqual(['checkToken', 'formatResponse', 'queryDB']);
  });

  test('prefix-stripped matching: "GET /users" matches "route:GET /users"', () => {
    const data = flowData('GET /users', dbPath);
    expect(data.entry).not.toBeNull();
    expect(data.entry.name).toBe('route:GET /users');
  });

  test('trace from non-entry node works (fetchUsers -> 2 callees)', () => {
    const data = flowData('fetchUsers', dbPath);
    expect(data.entry).not.toBeNull();
    expect(data.entry.name).toBe('fetchUsers');
    expect(data.entry.type).toBe('exported');
    expect(data.totalReached).toBe(2);
    const reachedNames = data.steps.flatMap((s) => s.nodes.map((n) => n.name)).sort();
    expect(reachedNames).toEqual(['formatResponse', 'queryDB']);
  });

  test('depth limit truncates correctly', () => {
    const data = flowData('route:GET /users', dbPath, { depth: 1 });
    expect(data.depth).toBe(1);
    // At depth 1, should only reach validateAuth and fetchUsers
    expect(data.totalReached).toBe(2);
    expect(data.truncated).toBe(true);
  });

  test('nonexistent name returns entry: null', () => {
    const data = flowData('nonExistentFunction', dbPath);
    expect(data.entry).toBeNull();
    expect(data.totalReached).toBe(0);
    expect(data.steps).toHaveLength(0);
  });

  test('leaf node returns zero steps', () => {
    const data = flowData('checkToken', dbPath);
    expect(data.entry).not.toBeNull();
    expect(data.entry.name).toBe('checkToken');
    expect(data.totalReached).toBe(0);
    expect(data.steps).toHaveLength(0);
  });

  test('command:build traces correctly', () => {
    const data = flowData('command:build', dbPath);
    expect(data.entry).not.toBeNull();
    expect(data.entry.type).toBe('command');
    expect(data.totalReached).toBe(3);
    const leafNames = data.leaves.map((l) => l.name).sort();
    expect(leafNames).toEqual(['loadConfig', 'parseFile']);
  });

  test('prefix-stripped matching for command: "build" matches "command:build"', () => {
    const data = flowData('build', dbPath);
    expect(data.entry).not.toBeNull();
    expect(data.entry.name).toBe('command:build');
  });
});

// ─── listEntryPointsData ──────────────────────────────────────────────

describe('listEntryPointsData', () => {
  test('finds all 3 framework entries plus role-based entry, excludes orphanFn', () => {
    const data = listEntryPointsData(dbPath);
    expect(data.count).toBe(4);
    const names = data.entries.map((e) => e.name).sort();
    expect(names).toEqual([
      'command:build',
      'event:connection',
      'exportedInit',
      'route:GET /users',
    ]);
    expect(names).not.toContain('orphanFn');
  });

  test('groups by type correctly, including exported for role-based entries', () => {
    const data = listEntryPointsData(dbPath);
    expect(data.byType.route).toHaveLength(1);
    expect(data.byType.command).toHaveLength(1);
    expect(data.byType.event).toHaveLength(1);
    expect(data.byType.exported).toHaveLength(1);
    expect(data.byType.route[0].name).toBe('route:GET /users');
    expect(data.byType.command[0].name).toBe('command:build');
    expect(data.byType.event[0].name).toBe('event:connection');
    expect(data.byType.exported[0].name).toBe('exportedInit');
  });

  test('role-based entry points get type "exported"', () => {
    const data = listEntryPointsData(dbPath);
    const entry = data.entries.find((e) => e.name === 'exportedInit');
    expect(entry).toBeDefined();
    expect(entry.type).toBe('exported');
    expect(entry.role).toBe('entry');
    expect(entry.kind).toBe('function');
  });

  test('each entry includes type, kind, file, line', () => {
    const data = listEntryPointsData(dbPath);
    for (const e of data.entries) {
      expect(e).toHaveProperty('name');
      expect(e).toHaveProperty('kind');
      expect(e).toHaveProperty('file');
      expect(e).toHaveProperty('line');
      expect(e).toHaveProperty('type');
    }
  });
});

// ─── Classification fix ───────────────────────────────────────────────

describe('framework entry point classification fix', () => {
  test('framework entry points classified as entry, not dead', () => {
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(
        `SELECT name, role FROM nodes
         WHERE name LIKE 'route:%' OR name LIKE 'command:%' OR name LIKE 'event:%'`,
      )
      .all();
    db.close();

    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.role).toBe('entry');
    }
  });

  test('orphanFn is classified as dead (sub-role)', () => {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(`SELECT role FROM nodes WHERE name = 'orphanFn'`).get();
    db.close();
    expect(row.role).toMatch(/^dead/);
  });
});
