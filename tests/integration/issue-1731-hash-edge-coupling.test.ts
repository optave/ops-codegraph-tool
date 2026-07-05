/**
 * Regression test for #1731: `file_hashes` must never claim a file is
 * "up to date" while its edges still reflect an older revision.
 *
 * Root cause: `insertNodes` committed `file_hashes` for changed files in the
 * same transaction as node insertion — BEFORE `resolveImports`/`buildEdges`
 * had rebuilt those files' edges (a separate, later stage/transaction). Any
 * exception thrown while rebuilding edges left the DB with a hash that
 * matched the file's CURRENT on-disk content while its edges still reflected
 * the PREVIOUS content (or were missing entirely, since the old edges had
 * already been purged). Because change-detection trusts `file_hashes`
 * exclusively, that divergence was never self-healed by later builds — the
 * file would be silently skipped forever, permanently showing stale/missing
 * edges via `codegraph deps` / `where --file`.
 *
 * The fix defers the `file_hashes` commit so it only happens once
 * `resolveImports`/`buildEdges` have finished rebuilding a file's edges
 * (`commitFileHashes` in `insert-nodes.ts`, called from the pipeline after
 * `buildEdges`). Separately, watch-mode's `rebuildFile` never wrote
 * `file_hashes` at all — also fixed here, coupling the write to a
 * successful edge rebuild.
 *
 * This file has two suites:
 *   1. Fault-injects an exception inside `buildEdges` during an incremental
 *      build (the adversarial case that would have caught the original bug)
 *      and asserts the hash does not advance until edges genuinely match.
 *   2. Exercises `rebuildFile` (the watch-mode path) directly and asserts it
 *      now keeps `file_hashes` in sync with the edges it rebuilds.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getNodeId as getNodeIdQuery, initSchema, openDb } from '../../src/db/index.js';
import { fileHash } from '../../src/domain/graph/builder/helpers.js';
import { rebuildFile } from '../../src/domain/graph/builder/incremental.js';
import { buildGraph } from '../../src/domain/graph/builder.js';

// ── Fault injection for suite 1 ──────────────────────────────────────────
// A `vi.hoisted` object is used (rather than a plain module-scope `let`) so
// the mutable flag is visible both inside the hoisted `vi.mock` factory and
// in the test body that arms/disarms it.
const injection = vi.hoisted(() => ({ armed: false }));

vi.mock('../../src/domain/graph/builder/stages/build-edges.js', async (importOriginal) => {
  const mod =
    await importOriginal<typeof import('../../src/domain/graph/builder/stages/build-edges.js')>();
  return {
    ...mod,
    buildEdges: async (ctx: Parameters<typeof mod.buildEdges>[0]) => {
      if (injection.armed) {
        injection.armed = false;
        throw new Error('simulated buildEdges failure (#1731 regression test)');
      }
      return mod.buildEdges(ctx);
    },
  };
});

// ── Shared fixture helpers ────────────────────────────────────────────────

/** Writes a.js importing from whichever of b.js/c.js are named in `imports`. */
function writeProject(dir: string, imports: string[]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'b.js'), 'export function b() { return 1; }\n');
  fs.writeFileSync(path.join(dir, 'c.js'), 'export function c() { return 2; }\n');
  const importLines = imports.map((m) => `import { ${m} } from './${m}.js';`).join('\n');
  const body = imports.map((m) => `${m}()`).join(' + ') || '0';
  fs.writeFileSync(
    path.join(dir, 'a.js'),
    `${importLines}\nexport function run() { return ${body}; }\n`,
  );
}

function readFileHashRow(dbPath: string, file: string): { hash: string } | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT hash FROM file_hashes WHERE file = ?').get(file) as
      | { hash: string }
      | undefined;
  } finally {
    db.close();
  }
}

function readImportEdgeTargets(dbPath: string, file: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db
        .prepare(
          `SELECT n2.file AS tgt FROM edges e
           JOIN nodes n1 ON e.source_id = n1.id
           JOIN nodes n2 ON e.target_id = n2.id
           WHERE n1.file = ? AND n1.kind = 'file' AND e.kind = 'imports'
           ORDER BY n2.file`,
        )
        .all(file) as Array<{ tgt: string }>
    ).map((r) => r.tgt);
  } finally {
    db.close();
  }
}

// ── Suite 1: incremental build pipeline ──────────────────────────────────

describe('Issue #1731: file_hashes/edges coupling survives a mid-build failure', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1731-'));
    injection.armed = false;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not commit file_hashes when buildEdges throws mid-incremental-build, and self-heals on retry', async () => {
    writeProject(tmpDir, ['b', 'c']);
    // engine: 'wasm' pins this to the JS pipeline (insertNodes/resolveImports/
    // buildEdges as separate stages) — the code path this fix changes. The
    // native orchestrator runs the equivalent pipeline entirely in Rust and
    // isn't reachable via a mocked JS module.
    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine: 'wasm' });

    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const originalHash = fileHash(fs.readFileSync(path.join(tmpDir, 'a.js'), 'utf-8'));
    expect(readFileHashRow(dbPath, 'a.js')?.hash).toBe(originalHash);
    expect(readImportEdgeTargets(dbPath, 'a.js')).toEqual(['b.js', 'c.js']);

    // Edit a.js to drop its import of c.js.
    writeProject(tmpDir, ['b']);
    const editedHash = fileHash(fs.readFileSync(path.join(tmpDir, 'a.js'), 'utf-8'));
    expect(editedHash).not.toBe(originalHash);

    // Arm the fault injection and run the incremental build — it must reject
    // partway through, after node insertion but before edges are rebuilt.
    injection.armed = true;
    await expect(
      buildGraph(tmpDir, { incremental: true, skipRegistry: true, engine: 'wasm' }),
    ).rejects.toThrow(/simulated buildEdges failure/);

    // The hash must NOT have advanced to match the edited content. If it
    // had (the pre-fix behavior), the file would be permanently stuck: the
    // next build would see the hash as "up to date" and skip reprocessing
    // it forever, leaving its edges stale or missing.
    expect(readFileHashRow(dbPath, 'a.js')?.hash).toBe(originalHash);

    // Retry without fault injection — the resulting hash/content mismatch
    // must be detected so the file gets fully reprocessed.
    injection.armed = false;
    await buildGraph(tmpDir, { incremental: true, skipRegistry: true, engine: 'wasm' });

    expect(readFileHashRow(dbPath, 'a.js')?.hash).toBe(editedHash);
    expect(readImportEdgeTargets(dbPath, 'a.js')).toEqual(['b.js']);
  });
});

// ── Suite 2: watch-mode rebuildFile ───────────────────────────────────────

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
    countEdges: db.prepare(
      'SELECT COUNT(*) as c FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?)',
    ),
    findNodeInFile: db.prepare(
      "SELECT id, kind, file FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant') AND file = ?",
    ),
    findNodeByName: db.prepare(
      "SELECT id, file, kind FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant')",
    ),
    listSymbols: db.prepare("SELECT name, kind, line FROM nodes WHERE file = ? AND kind != 'file'"),
    upsertFileHash: db.prepare(
      'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)',
    ),
    deleteFileHash: db.prepare('DELETE FROM file_hashes WHERE file = ?'),
  };
}

describe('Issue #1731: watch-mode rebuildFile keeps file_hashes in sync with edges', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1731-watch-'));
    writeProject(tmpDir, ['b', 'c']);
    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine: 'wasm' });
    dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('updates file_hashes to match the edited content after a rebuild, not just the edges', async () => {
    const originalHash = readFileHashRow(dbPath, 'a.js')?.hash;
    expect(originalHash).toBeTruthy();

    // Edit a.js to drop its import of c.js, then rebuild via the watcher's
    // single-file path.
    writeProject(tmpDir, ['b']);
    const editedHash = fileHash(fs.readFileSync(path.join(tmpDir, 'a.js'), 'utf-8'));
    expect(editedHash).not.toBe(originalHash);

    const db = openDb(dbPath);
    try {
      initSchema(db);
      const stmts = makeStmts(db);
      await rebuildFile(db, tmpDir, path.join(tmpDir, 'a.js'), stmts, { engine: 'wasm' }, null);
    } finally {
      db.close();
    }

    // Before the fix, rebuildFile rebuilt edges correctly but never touched
    // file_hashes at all, leaving it permanently stuck at originalHash.
    expect(readFileHashRow(dbPath, 'a.js')?.hash).toBe(editedHash);
    expect(readImportEdgeTargets(dbPath, 'a.js')).toEqual(['b.js']);
  });

  it('removes the file_hashes row when the file is deleted', async () => {
    expect(readFileHashRow(dbPath, 'a.js')).toBeTruthy();

    fs.rmSync(path.join(tmpDir, 'a.js'));

    const db = openDb(dbPath);
    try {
      initSchema(db);
      const stmts = makeStmts(db);
      await rebuildFile(db, tmpDir, path.join(tmpDir, 'a.js'), stmts, { engine: 'wasm' }, null);
    } finally {
      db.close();
    }

    expect(readFileHashRow(dbPath, 'a.js')).toBeUndefined();
  });
});
