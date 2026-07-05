/**
 * Regression test for a resource leak in openReadonlyWithNative (GAUNTLET
 * phase-15 finding, rule 5): the function used to open the better-sqlite3
 * DB handle BEFORE resolving the engine, and engine resolution calls
 * loadConfig(), which can throw (e.g. ConfigError from resolveSecrets when
 * llm.apiKeyCommand is malformed). If that throw happened, the already-open
 * DB handle was never closed — a real leak on a hot path used by
 * dataflow/hotspots/stats CLI commands.
 *
 * The fix reorders openReadonlyWithNative() to resolve the engine (and thus
 * call loadConfig) BEFORE opening the DB, mirroring openRepo()'s existing
 * ordering. This test proves the fix by tracking every better-sqlite3
 * `Database` instantiation: when loadConfig throws, zero instances should
 * ever be constructed (there's nothing to leak because nothing was opened).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const loadConfigSpy = vi.hoisted(() => vi.fn());
const openedInstances = vi.hoisted(() => [] as { close: () => void }[]);

// Delegate to the real loadConfig by default; individual tests override with
// mockImplementationOnce to simulate a throwing config resolution.
vi.mock('../../src/infrastructure/config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/infrastructure/config.js')>();
  loadConfigSpy.mockImplementation(mod.loadConfig);
  return { ...mod, loadConfig: loadConfigSpy };
});

// Wrap the real better-sqlite3 Database constructor so every instantiation
// is recorded. This lets tests assert "no handle was ever opened" directly,
// rather than inferring it indirectly.
vi.mock('../../src/db/better-sqlite3.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/db/better-sqlite3.js')>();
  return {
    ...mod,
    getDatabase: () => {
      const RealDatabase = mod.getDatabase();
      return new Proxy(RealDatabase, {
        construct(target, args) {
          const instance = Reflect.construct(target, args) as { close: () => void };
          openedInstances.push(instance);
          return instance;
        },
      });
    },
  };
});

import { closeDb, initSchema, openDb, openReadonlyWithNative } from '../../src/db/index.js';

let tmpDir: string;
let dbPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-leak-'));
  dbPath = path.join(tmpDir, 'graph.db');
  const db = openDb(dbPath);
  initSchema(db);
  closeDb(db);
});

beforeEach(() => {
  // Only count instantiations made during the test body itself.
  openedInstances.length = 0;
  loadConfigSpy.mockClear();
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('openReadonlyWithNative resource-leak regression', () => {
  it('does not open (and therefore cannot leak) a DB handle when engine/config resolution throws', () => {
    loadConfigSpy.mockImplementationOnce(() => {
      throw new Error('ConfigError: llm.apiKeyCommand must be a string');
    });

    expect(() => openReadonlyWithNative(dbPath)).toThrow(/apiKeyCommand/);

    // The regression: previously openReadonlyOrFail() (which constructs the
    // better-sqlite3 Database) ran BEFORE the loadConfig() call that could
    // throw, so a config error left an already-opened handle dangling
    // forever with no way for the caller to close it. With the fix, engine
    // resolution runs first, so a thrown config error means the Database
    // constructor is never invoked at all.
    expect(openedInstances).toHaveLength(0);
  });

  it('still opens successfully and closes cleanly when config resolution succeeds', () => {
    const result = openReadonlyWithNative(dbPath);
    expect(result.db).toBeDefined();
    expect(openedInstances).toHaveLength(1);

    result.close();

    // Prove the handle was actually closed, not merely constructed:
    // any query against a closed better-sqlite3 connection throws.
    expect(() => result.db.prepare('SELECT 1').get()).toThrow();
  });
});
