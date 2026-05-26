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

/**
 * Parse-failure scenario: if a reverse-dep file fails to parse,
 * `parseReverseDep` returns null and that dep's outgoing edges to OTHER files
 * (not `relPath`) are NOT deleted (since `deleteOutgoingEdges(dep)` only runs
 * for deps that parsed). `edgesRemoved` must exclude those undeleted edges.
 * Issue #1220 Greptile P1 follow-up.
 */
describe('rebuildFile edges accounting with unparseable reverse-dep (#1219)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-edges-delta-noparse-'));
    // a.js: target file we'll rebuild.
    fs.writeFileSync(
      path.join(tmpDir, 'a.js'),
      `export function foo() { return 1; }\nexport function bar() { return 2; }\n`,
    );
    // c.js: another file that b.js imports from. Its incoming edges from b.js
    // are NOT removed by purgeFileData(a.js), and NOT removed by
    // deleteOutgoingEdges(b.js) when b.js fails to parse.
    fs.writeFileSync(path.join(tmpDir, 'c.js'), `export function baz() { return 3; }\n`);
    // b.js: reverse-dep that imports from BOTH a.js and c.js. We'll corrupt
    // it to force parseReverseDep to fail.
    fs.writeFileSync(
      path.join(tmpDir, 'b.js'),
      `import { foo, bar } from './a.js';\nimport { baz } from './c.js';\nexport function callAll() { return foo() + bar() + baz(); }\n`,
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

  it('does not count b.js→c.js edges in edgesRemoved when b.js is unreadable', async () => {
    // Delete b.js so parseReverseDep returns null. b.js→a.js edges get
    // removed by purgeFileData(a.js) (target side), but b.js→c.js edges
    // stay in the DB (deleteOutgoingEdges(b.js) never runs).
    fs.unlinkSync(path.join(tmpDir, 'b.js'));

    const filePath = path.join(tmpDir, 'a.js');
    fs.appendFileSync(filePath, '\n// comment-only edit, b.js is gone\n');

    const db = openDb(dbPath);
    initSchema(db);
    const stmts = makeStmts(db);

    // Snapshot total edges + b.js→c.js edges before rebuild.
    const totalBefore = (db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c;
    const bToC = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM edges e
           JOIN nodes s ON e.source_id = s.id
           JOIN nodes t ON e.target_id = t.id
           WHERE s.file = ? AND t.file = ?`,
        )
        .get('b.js', 'c.js') as { c: number }
    ).c;
    expect(bToC).toBeGreaterThan(0); // sanity — b.js → c.js edges exist pre-rebuild

    const result = await rebuildFile(db, tmpDir, filePath, stmts, { engine: 'auto' }, null);

    const totalAfter = (db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c;
    const bToCAfter = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM edges e
           JOIN nodes s ON e.source_id = s.id
           JOIN nodes t ON e.target_id = t.id
           WHERE s.file = ? AND t.file = ?`,
        )
        .get('b.js', 'c.js') as { c: number }
    ).c;
    db.close();

    expect(bToCAfter).toBe(bToC); // b.js → c.js edges survived (no delete ran)
    expect(result).not.toBeNull();
    if (!result) return;
    // The reported delta must equal the actual net DB delta. Pre-fix,
    // edgesRemoved over-counted by `bToC` because b.js's outgoing edges
    // were included even though deleteOutgoingEdges(b.js) never ran.
    expect(result.edgesAdded - result.edgesRemoved).toBe(totalAfter - totalBefore);
  });
});
