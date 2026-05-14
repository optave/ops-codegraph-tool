/**
 * Regression test for #1083: backfill must run on a quiet incremental when
 * the DB has a gap (a file present on disk but missing from `nodes`).
 *
 * Issue scenario: a brand-new file with a dropped-language extension is added
 * on an incremental pass. The orchestrator's narrower file_collector doesn't
 * see the file, so it reports `changedCount=0`, `removedCount=0`,
 * `isFullBuild=false`. The pre-#1083 gate would skip backfill and the file
 * would never appear in the graph until a full rebuild.
 *
 * We simulate that DB state directly (instead of relying on a specific binary
 * version's dropped-extension set, which varies as extractors get ported to
 * Rust): delete a file's `nodes` row but keep its `file_hashes` row intact
 * so the orchestrator's content-hash tier sees the file as unchanged and
 * processes nothing. Then run an incremental and assert the gap is repaired.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'sample-project');

const hasNative = isNativeAvailable();
const requireParity = !!process.env.CODEGRAPH_PARITY;
const describeOrSkip = requireParity || hasNative ? describe : describe.skip;

function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

describeOrSkip('Dropped-language gap repair on quiet incremental (#1083)', () => {
  let projectDir: string;
  let dbPath: string;
  let tmpBase: string;
  const targetFile = 'math.js';

  beforeAll(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1083-'));
    projectDir = path.join(tmpBase, 'proj');
    copyDirSync(FIXTURE_DIR, projectDir);
    dbPath = path.join(projectDir, '.codegraph', 'graph.db');

    // Full build → every file has nodes + file_hashes rows.
    await buildGraph(projectDir, {
      engine: 'native',
      incremental: false,
      skipRegistry: true,
    });

    // Simulate the issue's DB state: a file is on disk and tracked in
    // `file_hashes` (so the orchestrator's hash tier sees it as unchanged
    // and reports `changedCount=0`), but its `kind='file'` node row is
    // absent — the same shape produced when an old binary's collector
    // never inserts dropped-extension files in the first place.
    //
    // Foreign keys are disabled for this surgical delete; edges referencing
    // the file node are left intact so we only test the gap-detection path.
    const db = new Database(dbPath);
    db.pragma('foreign_keys = OFF');
    db.prepare("DELETE FROM nodes WHERE kind='file' AND file = ?").run(targetFile);
    db.close();

    // Bump the file's mtime without changing content. This forces the
    // JS-side fast-skip pre-flight (#1054) to fall through to the
    // orchestrator (mtime mismatch with file_hashes), while the
    // orchestrator's content-hash tier still classifies the file as
    // unchanged (metadata-only update) — so `changedCount=0` and
    // `removedCount=0`. That's the exact orchestrator-state the issue
    // describes for a brand-new dropped-language file.
    const targetAbs = path.join(projectDir, targetFile);
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(targetAbs, future, future);

    // Incremental rebuild — must detect the gap and re-insert the row.
    await buildGraph(projectDir, {
      engine: 'native',
      incremental: true,
      skipRegistry: true,
    });
  }, 60_000);

  afterAll(() => {
    try {
      if (tmpBase) fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('repairs the missing file node on quiet incremental', () => {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare("SELECT name, kind, file FROM nodes WHERE kind='file' AND file = ?")
      .get(targetFile) as { name: string; kind: string; file: string } | undefined;
    db.close();
    expect(row).toBeDefined();
    expect(row?.file).toBe(targetFile);
  });
});
