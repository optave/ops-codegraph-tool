/**
 * Watcher edge-delta accounting test (#1219).
 *
 * `rebuildFile` returns both `edgesAdded` and `edgesRemoved` so the watcher
 * log can show a net delta. Without `edgesRemoved`, a comment-only edit (which
 * tears down and re-inserts the same edges) would falsely report "+N edges"
 * even though the DB total is unchanged.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getNodeId as getNodeIdQuery, initSchema, openDb } from '../../src/db/index.js';
import { rebuildFile } from '../../src/domain/graph/builder/incremental.js';
import { buildGraph } from '../../src/domain/graph/builder.js';

function makeStmts(db: ReturnType<typeof openDb>) {
  return {
    insertNode: db.prepare(
      'INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
    ),
    getNodeId: {
      get: (name: string, kind: string, file: string, line: number) => {
        const id = getNodeIdQuery(db, name, kind, file, line);
        return id != null ? { id } : undefined;
      },
    },
    insertEdge: db.prepare(
      'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)',
    ),
    countNodes: db.prepare('SELECT COUNT(*) as c FROM nodes WHERE file = ?'),
    findNodeInFile: db.prepare(
      "SELECT id, file FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant') AND file = ?",
    ),
    findNodeByName: db.prepare(
      "SELECT id, file FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant')",
    ),
    listSymbols: db.prepare("SELECT name, kind, line FROM nodes WHERE file = ? AND kind != 'file'"),
  };
}

describe('rebuildFile edges accounting (#1219)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-edges-delta-'));
    fs.writeFileSync(
      path.join(tmpDir, 'a.js'),
      `export function foo() { return bar(); }\nfunction bar() { return 1; }\n`,
    );
    await buildGraph(tmpDir, { incremental: false, skipRegistry: true });
    dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('reports edgesRemoved ≈ edgesAdded for comment-only edits (net delta ≈ 0)', async () => {
    const filePath = path.join(tmpDir, 'a.js');
    fs.appendFileSync(filePath, '\n// pure comment, no graph effect\n');

    const db = openDb(dbPath);
    initSchema(db);
    const stmts = makeStmts(db);
    const result = await rebuildFile(db, tmpDir, filePath, stmts, { engine: 'auto' }, null);
    db.close();

    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.edgesAdded).toBe(result.edgesRemoved);
  });

  it('reports positive net edge delta when adding a new symbol with a call', async () => {
    const filePath = path.join(tmpDir, 'a.js');
    fs.writeFileSync(
      filePath,
      `export function foo() { return bar(); }\nfunction bar() { return 1; }\nfunction baz() { return foo(); }\n`,
    );

    const db = openDb(dbPath);
    initSchema(db);
    const stmts = makeStmts(db);
    const result = await rebuildFile(db, tmpDir, filePath, stmts, { engine: 'auto' }, null);
    db.close();

    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.edgesAdded).toBeGreaterThan(result.edgesRemoved);
  });
});

/**
 * Reverse-dep cross-file scenario: when `a.js` is imported by `b.js`, the
 * naive accounting double-counts the `b.js → a.js` edge (once via
 * `edgesTouchingFile(a.js)` and once via `outgoingEdges(b.js)`). Without the
 * deduplicating union query, comment-only edits to `a.js` would report a
 * negative net delta. Issue #1219 P1 review.
 */
describe('rebuildFile edges accounting with reverse-deps (#1219)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-edges-delta-revdep-'));
    fs.writeFileSync(
      path.join(tmpDir, 'a.js'),
      `export function foo() { return 1; }\nexport function bar() { return 2; }\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, 'b.js'),
      `import { foo, bar } from './a.js';\nexport function callBoth() { return foo() + bar(); }\n`,
    );
    await buildGraph(tmpDir, { incremental: false, skipRegistry: true });
    dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('does not double-count dep→file edges (net delta ≈ 0 for comment-only edit with reverse deps)', async () => {
    const filePath = path.join(tmpDir, 'a.js');
    fs.appendFileSync(filePath, '\n// comment-only edit, b.js still imports foo+bar\n');

    const db = openDb(dbPath);
    initSchema(db);
    const stmts = makeStmts(db);
    const result = await rebuildFile(db, tmpDir, filePath, stmts, { engine: 'auto' }, null);
    db.close();

    expect(result).not.toBeNull();
    if (!result) return;
    // edgesAdded counts re-inserted edges (including b.js→a.js after cascade
    // re-parse). edgesRemoved must equal edgesAdded — a naive
    // touching+outgoing sum would overcount b.js→a.js, producing a negative
    // delta.
    expect(result.edgesAdded).toBe(result.edgesRemoved);
  });
});
