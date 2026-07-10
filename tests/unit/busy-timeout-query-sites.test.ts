/**
 * Regression tests for issue #1763: the ad-hoc read-only query call sites in
 * features/*, domain/analysis/*, and domain/search/* must thread the
 * user-configured `db.busyTimeoutMs` through to their `openReadonlyOrFail()`
 * call, instead of silently falling back to the DEFAULTS.db.busyTimeoutMs
 * hardcoded default.
 *
 * Covers the shared `resolveBusyTimeoutMs()` helper directly, plus a
 * representative sample of call sites from each category identified while
 * fixing the issue:
 *   - category (c), never loaded config before this fix: ownersData, cfgData
 *   - category (b), loaded config AFTER opening the db (now reordered): manifestoData
 *   - category (a), already loaded config before opening the db: hybridSearchData
 *   - the shared withReadonlyDb() wrapper (also covers exports/dependencies/context)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, initSchema, openDb, resolveBusyTimeoutMs } from '../../src/db/index.js';
import { withReadonlyDb } from '../../src/domain/analysis/query-helpers.js';
import { hybridSearchData } from '../../src/domain/search/search/hybrid.js';
import { cfgData } from '../../src/features/cfg.js';
import { manifestoData } from '../../src/features/manifesto.js';
import { ownersData } from '../../src/features/owners.js';
import { DEFAULTS } from '../../src/infrastructure/config.js';

const CUSTOM_BUSY_TIMEOUT_MS = 42424;

let tmpDir: string;
let dbPath: string;

/** Capture every `busy_timeout = N` pragma issued against a real Database instance. */
function captureBusyTimeoutPragmas(): { calls: string[]; restore: () => void } {
  const original = Database.prototype.pragma;
  const calls: string[] = [];
  const spy = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
    this: unknown,
    sql: string,
    ...rest: unknown[]
  ) {
    if (typeof sql === 'string' && sql.startsWith('busy_timeout')) calls.push(sql);
    return original.apply(this, [sql, ...rest] as Parameters<typeof original>);
  });
  return { calls, restore: () => spy.mockRestore() };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-busy-threading-'));
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
  const db = openDb(dbPath);
  initSchema(db);
  closeDb(db);
  fs.writeFileSync(
    path.join(tmpDir, '.codegraphrc.json'),
    JSON.stringify({ db: { busyTimeoutMs: CUSTOM_BUSY_TIMEOUT_MS } }),
  );
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveBusyTimeoutMs', () => {
  it('reads db.busyTimeoutMs from the project config nearest the resolved DB path', () => {
    expect(resolveBusyTimeoutMs(dbPath)).toBe(CUSTOM_BUSY_TIMEOUT_MS);
  });

  it('falls back to DEFAULTS.db.busyTimeoutMs when no project config sets it', () => {
    const bareDir = fs.mkdtempSync(path.join(tmpDir, 'bare-'));
    const bareDbPath = path.join(bareDir, '.codegraph', 'graph.db');
    const db = openDb(bareDbPath);
    initSchema(db);
    closeDb(db);

    expect(resolveBusyTimeoutMs(bareDbPath)).toBe(DEFAULTS.db.busyTimeoutMs);
    expect(resolveBusyTimeoutMs(bareDbPath)).not.toBe(CUSTOM_BUSY_TIMEOUT_MS);
  });
});

describe('configured busyTimeoutMs reaches PRAGMA busy_timeout at ad-hoc read-only call sites', () => {
  it('ownersData (never loaded config before this fix) applies the configured busy_timeout', () => {
    const capture = captureBusyTimeoutPragmas();
    try {
      ownersData(dbPath);
    } finally {
      capture.restore();
    }
    expect(capture.calls).toContain(`busy_timeout = ${CUSTOM_BUSY_TIMEOUT_MS}`);
  });

  it('cfgData (never loaded config before this fix) applies the configured busy_timeout', () => {
    const capture = captureBusyTimeoutPragmas();
    try {
      cfgData('nonexistent-symbol', dbPath);
    } finally {
      capture.restore();
    }
    expect(capture.calls).toContain(`busy_timeout = ${CUSTOM_BUSY_TIMEOUT_MS}`);
  });

  it('manifestoData (config load reordered to before the db opens) applies the configured busy_timeout', () => {
    // manifestoData resolves its config from the resolved DB path's rootDir
    // (issue #1881 fix), not process.cwd() — so an unrelated cwd must not
    // affect resolution.
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(os.tmpdir());
    const capture = captureBusyTimeoutPragmas();
    try {
      manifestoData(dbPath);
    } finally {
      capture.restore();
      cwdSpy.mockRestore();
    }
    expect(capture.calls).toContain(`busy_timeout = ${CUSTOM_BUSY_TIMEOUT_MS}`);
  });

  it('hybridSearchData (already loaded config before the db opens) applies the configured busy_timeout', async () => {
    // Same DB-path-derived config resolution as manifestoData (issue #1881
    // fix) — an unrelated cwd must not affect resolution.
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(os.tmpdir());
    const capture = captureBusyTimeoutPragmas();
    try {
      await hybridSearchData('nonexistent-query', dbPath);
    } finally {
      capture.restore();
      cwdSpy.mockRestore();
    }
    expect(capture.calls).toContain(`busy_timeout = ${CUSTOM_BUSY_TIMEOUT_MS}`);
  });

  it('withReadonlyDb (shared helper backing exports/dependencies/context) applies the configured busy_timeout', () => {
    const capture = captureBusyTimeoutPragmas();
    try {
      withReadonlyDb(dbPath, (db) => db.prepare('SELECT 1').get());
    } finally {
      capture.restore();
    }
    expect(capture.calls).toContain(`busy_timeout = ${CUSTOM_BUSY_TIMEOUT_MS}`);
  });
});
