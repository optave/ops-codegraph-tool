/**
 * Regression tests for issue #1882: the JS call sites that open a
 * `NativeDatabase` must pass the resolved `config.db.busyTimeoutMs` through
 * as the factory's `busyTimeoutMs` argument, instead of silently relying on
 * the Rust-side hardcoded default.
 *
 * Mocks `infrastructure/native.js` (the same pattern as
 * `tests/unit/openRepo-busy.test.ts`) so the assertions are about *what
 * argument each call site passes*, independent of whether a native addon is
 * actually built for the current platform.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const CUSTOM_BUSY_TIMEOUT_MS = 424242;

const openReadonlyCalls: Array<[string, number | undefined]> = [];
const openReadWriteCalls: Array<[string, number | undefined]> = [];

function makeFakeNativeDb() {
  return {
    getBuildMeta: () => null,
    close: () => {},
    initSchema: () => {},
    exec: () => {},
  };
}

vi.mock('../../src/infrastructure/native.js', () => ({
  isNativeAvailable: () => true,
  getNative: () => ({
    NativeDatabase: {
      openReadonly: (dbPath: string, busyTimeoutMs?: number) => {
        openReadonlyCalls.push([dbPath, busyTimeoutMs]);
        return makeFakeNativeDb();
      },
      openReadWrite: (dbPath: string, busyTimeoutMs?: number) => {
        openReadWriteCalls.push([dbPath, busyTimeoutMs]);
        return makeFakeNativeDb();
      },
    },
  }),
  loadNative: () => ({
    NativeDatabase: {
      openReadonly: (dbPath: string, busyTimeoutMs?: number) => {
        openReadonlyCalls.push([dbPath, busyTimeoutMs]);
        return makeFakeNativeDb();
      },
      openReadWrite: (dbPath: string, busyTimeoutMs?: number) => {
        openReadWriteCalls.push([dbPath, busyTimeoutMs]);
        return makeFakeNativeDb();
      },
    },
  }),
}));

import {
  closeDb,
  initSchema,
  openDb,
  openReadonlyWithNative,
  openRepo,
} from '../../src/db/index.js';
import { PipelineContext } from '../../src/domain/graph/builder/context.js';
import { reopenNativeDb } from '../../src/domain/graph/builder/stages/native-db-lifecycle.js';

let tmpDir: string;
let dbPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-native-busy-threading-'));
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

describe('openRepo threads busyTimeoutMs into NativeDatabase.openReadonly', () => {
  it('passes the configured busyTimeoutMs to the native factory', () => {
    openReadonlyCalls.length = 0;
    const { close } = openRepo(dbPath);
    close();
    expect(openReadonlyCalls).toHaveLength(1);
    expect(openReadonlyCalls[0]?.[1]).toBe(CUSTOM_BUSY_TIMEOUT_MS);
  });
});

describe('openReadonlyWithNative threads busyTimeoutMs into NativeDatabase.openReadonly', () => {
  it('passes the configured busyTimeoutMs to the native factory', () => {
    openReadonlyCalls.length = 0;
    const { close } = openReadonlyWithNative(dbPath);
    close();
    expect(openReadonlyCalls).toHaveLength(1);
    expect(openReadonlyCalls[0]?.[1]).toBe(CUSTOM_BUSY_TIMEOUT_MS);
  });
});

describe('reopenNativeDb (build pipeline) threads ctx.config.db.busyTimeoutMs into NativeDatabase.openReadWrite', () => {
  it('passes ctx.config.db.busyTimeoutMs to the native factory', () => {
    openReadWriteCalls.length = 0;
    const ctx = new PipelineContext();
    ctx.dbPath = dbPath;
    ctx.opts = { engine: 'native' };
    ctx.config = { db: { busyTimeoutMs: CUSTOM_BUSY_TIMEOUT_MS } } as PipelineContext['config'];

    reopenNativeDb(ctx, 'test');

    expect(openReadWriteCalls).toHaveLength(1);
    expect(openReadWriteCalls[0]?.[1]).toBe(CUSTOM_BUSY_TIMEOUT_MS);
  });
});
