/**
 * Integration tests for interface/trait implementation tracking.
 *
 * Test graph:
 *
 *   Files: types.ts, service.ts, handler.ts
 *
 *   Nodes:
 *     Serializable (interface, types.ts:1)
 *     Printable    (interface, types.ts:10)
 *     UserService  (class, service.ts:1) — implements Serializable, Printable
 *     AdminService (class, service.ts:20) — implements Serializable
 *     handleUser   (function, handler.ts:1) — calls UserService
 *
 *   Edges:
 *     UserService  --implements--> Serializable
 *     UserService  --implements--> Printable
 *     AdminService --implements--> Serializable
 *     handleUser   --calls------> UserService
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import {
  contextData,
  fnImpactData,
  implementationsData,
  interfacesData,
} from '../../src/domain/queries.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-impl-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  // File nodes
  insertNode(db, 'types.ts', 'file', 'types.ts', 0);
  insertNode(db, 'service.ts', 'file', 'service.ts', 0);
  insertNode(db, 'handler.ts', 'file', 'handler.ts', 0);

  // Interface nodes
  const serializable = insertNode(db, 'Serializable', 'interface', 'types.ts', 1);
  const printable = insertNode(db, 'Printable', 'interface', 'types.ts', 10);

  // Class nodes
  const userService = insertNode(db, 'UserService', 'class', 'service.ts', 1);
  const adminService = insertNode(db, 'AdminService', 'class', 'service.ts', 20);

  // Function nodes
  const handleUser = insertNode(db, 'handleUser', 'function', 'handler.ts', 1);

  // Implements edges
  insertEdge(db, userService, serializable, 'implements');
  insertEdge(db, userService, printable, 'implements');
  insertEdge(db, adminService, serializable, 'implements');

  // Call edges
  insertEdge(db, handleUser, userService, 'calls');

  db.close();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Tests ─────────────────────────────────────────────────────────────

describe('implementationsData', () => {
  test('finds all implementors of an interface', () => {
    const data = implementationsData('Serializable', dbPath);
    expect(data.results).toHaveLength(1);
    const result = data.results[0];
    expect(result.name).toBe('Serializable');
    expect(result.kind).toBe('interface');
    expect(result.implementors).toHaveLength(2);
    const names = result.implementors.map((i) => i.name).sort();
    expect(names).toEqual(['AdminService', 'UserService']);
  });

  test('finds single implementor for Printable', () => {
    const data = implementationsData('Printable', dbPath);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].implementors).toHaveLength(1);
    expect(data.results[0].implementors[0].name).toBe('UserService');
  });

  test('returns empty implementors for a class', () => {
    const data = implementationsData('UserService', dbPath);
    expect(data.results).toHaveLength(1);
    // UserService is a class, not an interface — nobody implements it
    expect(data.results[0].implementors).toHaveLength(0);
  });

  test('returns empty results for unknown name', () => {
    const data = implementationsData('NonExistent', dbPath);
    expect(data.results).toHaveLength(0);
  });
});

describe('interfacesData', () => {
  test('finds all interfaces a class implements', () => {
    const data = interfacesData('UserService', dbPath);
    expect(data.results).toHaveLength(1);
    const result = data.results[0];
    expect(result.name).toBe('UserService');
    expect(result.kind).toBe('class');
    expect(result.interfaces).toHaveLength(2);
    const names = result.interfaces.map((i) => i.name).sort();
    expect(names).toEqual(['Printable', 'Serializable']);
  });

  test('finds single interface for AdminService', () => {
    const data = interfacesData('AdminService', dbPath);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].interfaces).toHaveLength(1);
    expect(data.results[0].interfaces[0].name).toBe('Serializable');
  });

  test('returns empty interfaces for an interface node', () => {
    const data = interfacesData('Serializable', dbPath);
    expect(data.results).toHaveLength(1);
    // An interface doesn't implement anything
    expect(data.results[0].interfaces).toHaveLength(0);
  });
});

describe('contextData with implementation info', () => {
  test('includes implementors for interface nodes', () => {
    const data = contextData('Serializable', dbPath, { kind: 'interface' });
    expect(data.results).toHaveLength(1);
    const result = data.results[0];
    expect(result.implementors).toBeDefined();
    expect(result.implementors).toHaveLength(2);
    const names = result.implementors.map((i) => i.name).sort();
    expect(names).toEqual(['AdminService', 'UserService']);
  });

  test('includes implements for class nodes', () => {
    const data = contextData('UserService', dbPath);
    expect(data.results).toHaveLength(1);
    const result = data.results[0];
    expect(result.implements).toBeDefined();
    expect(result.implements).toHaveLength(2);
  });

  test('omits implementation info for plain functions', () => {
    const data = contextData('handleUser', dbPath);
    expect(data.results).toHaveLength(1);
    const result = data.results[0];
    expect(result.implementors).toBeUndefined();
    expect(result.implements).toBeUndefined();
  });
});

describe('fnImpactData with implementors in blast radius', () => {
  test('interface impact includes implementors', () => {
    const data = fnImpactData('Serializable', dbPath, { depth: 3, kind: 'interface' });
    expect(data.results).toHaveLength(1);
    const result = data.results[0];
    // Serializable is an interface, so BFS should seed with implementors
    expect(result.totalDependents).toBeGreaterThanOrEqual(2);
    const allNames = Object.values(result.levels)
      .flat()
      .map((n) => n.name);
    expect(allNames).toContain('UserService');
    expect(allNames).toContain('AdminService');
  });

  test('--no-implementations excludes implementors', () => {
    const data = fnImpactData('Serializable', dbPath, {
      depth: 3,
      kind: 'interface',
      includeImplementors: false,
    });
    expect(data.results).toHaveLength(1);
    const result = data.results[0];
    // Without implementors, an interface with no direct callers has no dependents
    const allNames = Object.values(result.levels)
      .flat()
      .map((n) => n.name);
    expect(allNames).not.toContain('UserService');
    expect(allNames).not.toContain('AdminService');
  });

  test('implementor callers appear transitively', () => {
    const data = fnImpactData('Serializable', dbPath, { depth: 5, kind: 'interface' });
    expect(data.results).toHaveLength(1);
    const allNames = Object.values(data.results[0].levels)
      .flat()
      .map((n) => n.name);
    // handleUser calls UserService which implements Serializable
    expect(allNames).toContain('handleUser');
  });
});
