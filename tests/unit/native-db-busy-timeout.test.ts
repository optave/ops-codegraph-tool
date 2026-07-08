/**
 * Regression tests for issue #1882: `config.db.busyTimeoutMs` must reach the
 * Rust native DB layer (`NativeDatabase::open_readonly` / `open_read_write`),
 * not just the TS-side better-sqlite3 pragma threaded by #1763.
 *
 * Verifies the applied `busy_timeout` via `queryGet('PRAGMA busy_timeout', [])`
 * rather than the `pragma()` helper — `pragma()` only supports TEXT-affinity
 * results (see #2019) and throws for INTEGER-returning pragmas like
 * `busy_timeout`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../src/infrastructure/config.js';
import { getNative, isNativeAvailable } from '../../src/infrastructure/native.js';
import type { NativeDatabase } from '../../src/types.js';

const hasNativeDb =
  isNativeAvailable() && typeof getNative().NativeDatabase?.openReadWrite === 'function';

/** Read the effective `busy_timeout` pragma value via queryGet (avoids the pragma() TEXT-only bug, #2019). */
function readBusyTimeout(ndb: NativeDatabase): number {
  const row = ndb.queryGet('PRAGMA busy_timeout', []) as { timeout: number } | null;
  return row?.timeout as number;
}

describe.skipIf(!hasNativeDb)('NativeDatabase busy_timeout_ms threading (Rust layer)', () => {
  let tmpDir: string;
  let dbPath: string;
  let nativeDb: NativeDatabase | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-busy-'));
    dbPath = path.join(tmpDir, 'test.db');
  });

  afterEach(() => {
    try {
      nativeDb?.close();
    } catch {
      /* already closed */
    }
    nativeDb = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('openReadWrite applies a configured busyTimeoutMs', () => {
    const NativeDB = getNative().NativeDatabase;
    nativeDb = NativeDB.openReadWrite(dbPath, 424242);
    expect(readBusyTimeout(nativeDb)).toBe(424242);
  });

  it('openReadWrite defaults to DEFAULTS.db.busyTimeoutMs when omitted', () => {
    const NativeDB = getNative().NativeDatabase;
    nativeDb = NativeDB.openReadWrite(dbPath);
    expect(readBusyTimeout(nativeDb)).toBe(DEFAULTS.db.busyTimeoutMs);
  });

  it('openReadonly applies a configured busyTimeoutMs', () => {
    const NativeDB = getNative().NativeDatabase;
    // openReadonly requires the file to already exist.
    NativeDB.openReadWrite(dbPath).close();
    nativeDb = NativeDB.openReadonly(dbPath, 99999);
    expect(readBusyTimeout(nativeDb)).toBe(99999);
  });

  it('openReadonly defaults to DEFAULTS.db.busyTimeoutMs when omitted', () => {
    const NativeDB = getNative().NativeDatabase;
    NativeDB.openReadWrite(dbPath).close();
    nativeDb = NativeDB.openReadonly(dbPath);
    expect(readBusyTimeout(nativeDb)).toBe(DEFAULTS.db.busyTimeoutMs);
  });
});
