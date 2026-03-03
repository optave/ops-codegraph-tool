/**
 * Unit tests for purgeFilesFromGraph() — the extracted deletion cascade.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { purgeFilesFromGraph } from '../../src/builder.js';
import { initSchema } from '../../src/db.js';

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

// ─── Fixture ───────────────────────────────────────────────────────────

// Track open DBs for cleanup (Windows locks DB files)
let openDbs = [];

afterEach(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  openDbs = [];
});

function makeDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-purge-'));
  const dbPath = path.join(tmpDir, 'graph.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);
  openDbs.push(db);
  return db;
}

function seedGraph(db) {
  // Two files: auth.js and utils.js
  const fAuth = insertNode(db, 'auth.js', 'file', 'auth.js', 0);
  const fUtils = insertNode(db, 'utils.js', 'file', 'utils.js', 0);
  const authenticate = insertNode(db, 'authenticate', 'function', 'auth.js', 10);
  const validate = insertNode(db, 'validateToken', 'function', 'auth.js', 25);
  const format = insertNode(db, 'formatResponse', 'function', 'utils.js', 5);

  insertEdge(db, authenticate, validate, 'calls');
  insertEdge(db, fAuth, fUtils, 'imports');

  // node_metrics (columns: node_id, fan_in, fan_out, etc.)
  db.prepare('INSERT INTO node_metrics (node_id, fan_in) VALUES (?, ?)').run(fAuth, 2);
  db.prepare('INSERT INTO node_metrics (node_id, fan_in) VALUES (?, ?)').run(fUtils, 1);

  // file_hashes
  try {
    db.prepare(
      'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, 0, 0)',
    ).run('auth.js', 'abc123');
    db.prepare(
      'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, 0, 0)',
    ).run('utils.js', 'def456');
  } catch {
    /* table may not exist in very old schemas */
  }

  return { fAuth, fUtils, authenticate, validate, format };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('purgeFilesFromGraph', () => {
  test('purges nodes/edges/metrics for specified files, leaves others untouched', () => {
    const db = makeDb();
    seedGraph(db);

    // Purge only auth.js
    purgeFilesFromGraph(db, ['auth.js']);

    // auth.js nodes should be gone
    const authNodes = db.prepare("SELECT * FROM nodes WHERE file = 'auth.js'").all();
    expect(authNodes).toHaveLength(0);

    // utils.js nodes should remain
    const utilsNodes = db.prepare("SELECT * FROM nodes WHERE file = 'utils.js'").all();
    expect(utilsNodes.length).toBeGreaterThan(0);

    // Edges involving auth.js nodes should be gone
    const edges = db.prepare('SELECT * FROM edges').all();
    // The only remaining nodes are from utils.js, so no edges should reference auth.js nodes
    for (const edge of edges) {
      const src = db.prepare('SELECT file FROM nodes WHERE id = ?').get(edge.source_id);
      const tgt = db.prepare('SELECT file FROM nodes WHERE id = ?').get(edge.target_id);
      if (src) expect(src.file).not.toBe('auth.js');
      if (tgt) expect(tgt.file).not.toBe('auth.js');
    }

    // Metrics for auth.js file node should be gone (we inserted metrics for file node IDs)
    // Since auth.js nodes are deleted, their metrics should also be gone
    const remainingMetrics = db.prepare('SELECT * FROM node_metrics').all();
    // Only the utils.js file node metric should remain
    expect(remainingMetrics).toHaveLength(1);

    // file_hashes for auth.js should be gone (purgeHashes defaults to true)
    const authHash = db.prepare("SELECT * FROM file_hashes WHERE file = 'auth.js'").all();
    expect(authHash).toHaveLength(0);

    // utils.js hash should remain
    const utilsHash = db.prepare("SELECT * FROM file_hashes WHERE file = 'utils.js'").all();
    expect(utilsHash).toHaveLength(1);
  });

  test('respects purgeHashes: false', () => {
    const db = makeDb();
    seedGraph(db);

    purgeFilesFromGraph(db, ['auth.js'], { purgeHashes: false });

    // Nodes should be gone
    const authNodes = db.prepare("SELECT * FROM nodes WHERE file = 'auth.js'").all();
    expect(authNodes).toHaveLength(0);

    // But file_hashes should remain
    const authHash = db.prepare("SELECT * FROM file_hashes WHERE file = 'auth.js'").all();
    expect(authHash).toHaveLength(1);
  });

  test('handles missing optional tables gracefully', () => {
    const db = makeDb();
    seedGraph(db);

    // Drop optional tables to simulate pre-migration DB
    try {
      db.exec('DROP TABLE IF EXISTS function_complexity');
    } catch {
      /* ignore */
    }
    try {
      db.exec('DROP TABLE IF EXISTS dataflow');
    } catch {
      /* ignore */
    }

    // Should not throw
    expect(() => purgeFilesFromGraph(db, ['auth.js'])).not.toThrow();

    const authNodes = db.prepare("SELECT * FROM nodes WHERE file = 'auth.js'").all();
    expect(authNodes).toHaveLength(0);
  });

  test('no-ops on empty file list', () => {
    const db = makeDb();
    seedGraph(db);

    const beforeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
    purgeFilesFromGraph(db, []);
    const afterCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
    expect(afterCount).toBe(beforeCount);
  });

  test('no-ops on null/undefined file list', () => {
    const db = makeDb();
    seedGraph(db);

    const beforeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
    purgeFilesFromGraph(db, null);
    purgeFilesFromGraph(db, undefined);
    const afterCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
    expect(afterCount).toBe(beforeCount);
  });
});
