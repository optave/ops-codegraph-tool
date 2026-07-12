/**
 * Regression tests for issue #1941: `withRepo()` and its `resolveAnalysisOpts`-
 * using callers (`fnImpactData`, `briefData`) each triggered a *second*,
 * independent `loadConfig()` call for the same `--db` path — one implicitly
 * via `openRepo()` -> `resolveDbSettings()` (to pick the engine/busy-timeout),
 * and a second one via `resolveAnalysisOpts()` / a direct `loadConfig()` call
 * inside the `withRepo()` callback (to read analysis-tuning fields like
 * `analysis.fnImpactDepth`/`analysis.briefCallerDepth`).
 *
 * Beyond the redundant work, the second call resolved its rootDir from
 * `process.cwd()` instead of the resolved `--db` path, so a `--db` pointing
 * at a different repo than cwd would read the WRONG project's
 * `.codegraphrc.json` for those fields (mirrors the `withReadonlyDb` fix
 * already applied for `exports.ts`/`context.ts`).
 *
 * The fix: `withRepo()` resolves config once and threads it through to both
 * `openRepo()` (via the new `opts.config`) and the callback, so callers can
 * pass `opts.config ?? dbConfig` into `resolveAnalysisOpts` instead of
 * triggering a second `loadConfig()`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const loadConfigSpy = vi.hoisted(() => vi.fn());

// Delegate to the real loadConfig by default; this only counts invocations.
vi.mock('../../src/infrastructure/config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/infrastructure/config.js')>();
  loadConfigSpy.mockImplementation(mod.loadConfig);
  return { ...mod, loadConfig: loadConfigSpy };
});

import { initSchema } from '../../src/db/index.js';
import { briefData } from '../../src/domain/analysis/brief.js';
import { fnImpactData } from '../../src/domain/analysis/fn-impact.js';
import { withRepo } from '../../src/domain/analysis/query-helpers.js';

const CUSTOM_FN_IMPACT_DEPTH = 2;
const CUSTOM_BRIEF_CALLER_DEPTH = 2;

function insertNode(db: Database.Database, name: string, kind: string, file: string, line: number) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)')
    .run(name, kind, file, line).lastInsertRowid;
}

function insertEdge(
  db: Database.Database,
  sourceId: number | bigint,
  targetId: number | bigint,
  kind: string,
) {
  db.prepare(
    'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, 1.0, 0)',
  ).run(sourceId, targetId, kind);
}

let tmpDir: string;
let cwdDir: string;
let dbPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-withrepo-config-'));
  fs.mkdirSync(path.join(tmpDir, '.git'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

  // Project config lives next to the DB, not at cwd — proves rootDir is
  // derived from `--db`, matching resolveConfigForDbPath()'s contract.
  fs.writeFileSync(
    path.join(tmpDir, '.codegraphrc.json'),
    JSON.stringify({
      analysis: {
        fnImpactDepth: CUSTOM_FN_IMPACT_DEPTH,
        briefCallerDepth: CUSTOM_BRIEF_CALLER_DEPTH,
      },
    }),
  );

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  const fBase = insertNode(db, 'lib/base.js', 'file', 'lib/base.js', 0);
  const fCaller = insertNode(db, 'lib/caller.js', 'file', 'lib/caller.js', 0);
  insertEdge(db, fCaller, fBase, 'imports');

  const target = insertNode(db, 'target', 'function', 'lib/base.js', 5);
  const caller = insertNode(db, 'caller', 'function', 'lib/caller.js', 5);
  insertEdge(db, caller, target, 'calls');

  db.close();

  // cwd is a *different*, config-less directory — any loadConfig() call that
  // resolves from process.cwd() (instead of the --db path) would silently
  // fall back to DEFAULTS instead of picking up the custom depth above.
  cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-withrepo-cwd-'));
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  if (cwdDir) fs.rmSync(cwdDir, { recursive: true, force: true });
});

beforeEach(() => {
  loadConfigSpy.mockClear();
});

describe('withRepo config resolution', () => {
  it('resolves config exactly once and passes it to the callback', () => {
    const config = withRepo(dbPath, (_repo, dbConfig) => dbConfig);
    expect(loadConfigSpy).toHaveBeenCalledTimes(1);
    expect(config.analysis?.fnImpactDepth).toBe(CUSTOM_FN_IMPACT_DEPTH);
  });
});

describe('fnImpactData (issue #1941)', () => {
  it('calls loadConfig exactly once per invocation', () => {
    fnImpactData('target', dbPath);
    expect(loadConfigSpy).toHaveBeenCalledTimes(1);
  });

  it('reads analysis.fnImpactDepth from the --db path rootDir, not process.cwd()', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwdDir);
    try {
      // depth defaults to config.analysis.fnImpactDepth when opts.depth is unset;
      // the BFS at depth 1 already reaches `caller`, so this only distinguishes
      // "config resolved" from "config silently defaulted" via the call count above,
      // and directly via the resolved config object here.
      const config = withRepo(dbPath, (_repo, dbConfig) => dbConfig);
      expect(config.analysis?.fnImpactDepth).toBe(CUSTOM_FN_IMPACT_DEPTH);

      const data = fnImpactData('target', dbPath) as { results: Array<{ direct: number }> };
      expect(data.results).toHaveLength(1);
      expect(data.results[0]?.direct).toBe(1);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('opts.config still overrides the resolved db config when the caller supplies one', () => {
    fnImpactData('target', dbPath, { config: { analysis: { fnImpactDepth: 99 } } as never });
    // The explicit opts.config short-circuits resolveAnalysisOpts's fallback,
    // but withRepo's own loadConfig() (for openRepo's engine selection) still runs once.
    expect(loadConfigSpy).toHaveBeenCalledTimes(1);
  });
});

describe('briefData (issue #1941)', () => {
  it('calls loadConfig exactly once per invocation', () => {
    briefData('base.js', dbPath);
    expect(loadConfigSpy).toHaveBeenCalledTimes(1);
  });

  it('reads analysis.briefCallerDepth from the --db path rootDir, not process.cwd()', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwdDir);
    try {
      const config = withRepo(dbPath, (_repo, dbConfig) => dbConfig);
      expect(config.analysis?.briefCallerDepth).toBe(CUSTOM_BRIEF_CALLER_DEPTH);
    } finally {
      cwdSpy.mockRestore();
    }
  });
});
