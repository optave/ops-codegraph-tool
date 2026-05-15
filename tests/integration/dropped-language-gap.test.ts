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
 *
 * Two scenarios cover both backfill call sites added by #1083:
 *  1. earlyExit=true branch (pipeline.ts:659–671): content hash unchanged →
 *     orchestrator returns early_exit=true → backfill runs from that branch.
 *  2. earlyExit=false branch (pipeline.ts:776–778): content changed in some
 *     other file → orchestrator returns early_exit=false with changedCount>0
 *     → backfill runs from the main gate (which now also fires when
 *     `gap.missingAbs.length > 0`).
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

/**
 * Shared setup: full build → delete the target's `nodes` row → return paths
 * so each scenario can stage its own incremental trigger before rebuilding.
 */
async function setupGappedDb(label: string, targetFile: string) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-1083-${label}-`));
  const projectDir = path.join(tmpBase, 'proj');
  copyDirSync(FIXTURE_DIR, projectDir);
  const dbPath = path.join(projectDir, '.codegraph', 'graph.db');

  // Full build → every file has nodes + file_hashes rows.
  await buildGraph(projectDir, {
    engine: 'native',
    incremental: false,
    skipRegistry: true,
  });

  // Simulate the issue's DB state: a file is on disk and tracked in
  // `file_hashes`, but its `kind='file'` node row is absent — the same
  // shape produced when an old binary's collector never inserts
  // dropped-extension files in the first place.
  //
  // Foreign keys are disabled for this surgical delete; edges referencing
  // the file node are left intact so we only test the gap-detection path.
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  db.prepare("DELETE FROM nodes WHERE kind='file' AND file = ?").run(targetFile);
  db.close();

  return { tmpBase, projectDir, dbPath };
}

function readFileNodeRow(dbPath: string, file: string) {
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare("SELECT name, kind, file FROM nodes WHERE kind='file' AND file = ?")
    .get(file) as { name: string; kind: string; file: string } | undefined;
  db.close();
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: orchestrator early_exit=true path
//
// Bump mtime without changing content. The JS-side fast-skip pre-flight
// (#1054) sees the mtime mismatch and falls through to the orchestrator.
// The orchestrator's mtime tier also fails, so it hashes the content; the
// hash matches → classifies as a metadata-only change → after the
// metadata_only filter, parse_changes is empty and removed is empty →
// returns early_exit=true. Backfill must run from pipeline.ts:665–667.
// ─────────────────────────────────────────────────────────────────────────────
describeOrSkip('Dropped-language gap repair on quiet incremental (#1083) — earlyExit=true', () => {
  let projectDir: string;
  let dbPath: string;
  let tmpBase: string;
  const targetFile = 'math.js';

  beforeAll(async () => {
    ({ tmpBase, projectDir, dbPath } = await setupGappedDb('quiet', targetFile));

    // Bump the file's mtime without changing content. This forces the
    // JS-side fast-skip pre-flight (#1054) to fall through to the
    // orchestrator (mtime mismatch with file_hashes), while the
    // orchestrator's content-hash tier still classifies the file as
    // unchanged (metadata-only update) — so `changedCount=0`,
    // `removedCount=0`, and `earlyExit=true`. That's the exact
    // orchestrator-state the issue describes for a brand-new
    // dropped-language file.
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

  it('repairs the missing file node when the orchestrator returns earlyExit=true', () => {
    const row = readFileNodeRow(dbPath, targetFile);
    expect(row).toBeDefined();
    expect(row?.file).toBe(targetFile);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: orchestrator early_exit=false path with a real change
//
// One file's content actually changes (so the orchestrator reports
// changedCount=1, removedCount=0, earlyExit=false) AND a separate file has
// a gap (nodes row deleted, file_hashes intact). Without the
// `gap.missingAbs.length > 0` clause added by #1083, the existing gate
// would still fire (changedCount > 0), so this scenario verifies the
// non-early-exit branch still threads the pre-computed gap through to
// backfill and repairs the missing row alongside the regular changed-file
// processing.
// ─────────────────────────────────────────────────────────────────────────────
describeOrSkip('Dropped-language gap repair on dirty incremental (#1083) — earlyExit=false', () => {
  let projectDir: string;
  let dbPath: string;
  let tmpBase: string;
  const gapFile = 'math.js'; // gap target — node row deleted
  const dirtyFile = 'utils.js'; // change driver — content modified

  beforeAll(async () => {
    ({ tmpBase, projectDir, dbPath } = await setupGappedDb('dirty', gapFile));

    // Append a comment to a *different* file. This makes the orchestrator's
    // content hash diverge for that file, producing changedCount=1 and
    // earlyExit=false. The gapFile's node row is still missing — the
    // non-early-exit path's gate (with the new `gap.missingAbs.length > 0`
    // clause) must drive backfill for the gapped file.
    const dirtyAbs = path.join(projectDir, dirtyFile);
    fs.appendFileSync(dirtyAbs, '\n// touched by dropped-language-gap test #1083\n');

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

  it('repairs the missing file node alongside a real change (earlyExit=false)', () => {
    const row = readFileNodeRow(dbPath, gapFile);
    expect(row).toBeDefined();
    expect(row?.file).toBe(gapFile);
  });
});
