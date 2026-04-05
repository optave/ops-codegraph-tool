/**
 * Tests that openRepo re-throws SQLITE_BUSY errors from the native engine
 * instead of silently falling back to better-sqlite3 (which could hang).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Mock native module to simulate SQLITE_BUSY
vi.mock('../../src/infrastructure/native.js', () => ({
  isNativeAvailable: () => true,
  getNative: () => ({
    NativeDatabase: {
      openReadonly: () => {
        throw new Error('Failed to open DB readonly: SQLITE_BUSY');
      },
    },
  }),
}));

import { closeDb, initSchema, openDb, openRepo } from '../../src/db/index.js';

let tmpDir: string;
let dbPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-busy-'));
  dbPath = path.join(tmpDir, 'graph.db');
  const db = openDb(dbPath);
  initSchema(db);
  closeDb(db);
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('openRepo locking error handling', () => {
  it('re-throws SQLITE_BUSY as DbError instead of falling back', () => {
    expect(() => openRepo(dbPath)).toThrow(/Database is busy/);
  });

  it('thrown error is a DbError with code DB_ERROR', () => {
    try {
      openRepo(dbPath);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err.name).toBe('DbError');
      expect(err.code).toBe('DB_ERROR');
      expect(err.message).toContain('SQLITE_BUSY');
    }
  });
});
