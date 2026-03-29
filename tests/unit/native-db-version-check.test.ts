import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getNative, isNativeAvailable } from '../../src/infrastructure/native.js';
import type { NativeDatabase } from '../../src/types.js';

const hasNativeDb =
  isNativeAvailable() &&
  typeof getNative().NativeDatabase?.prototype?.validateSchemaVersion === 'function';

describe.skipIf(!hasNativeDb)('NativeDatabase.validateSchemaVersion', () => {
  let nativeDb: NativeDatabase;
  let dbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-native-version-'));
    dbPath = path.join(tmpDir, 'test.db');
    const NativeDB = getNative().NativeDatabase;
    nativeDb = NativeDB.openReadWrite(dbPath);
    nativeDb.initSchema();
  });

  afterEach(() => {
    nativeDb.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('returns true when no version is stored', () => {
    expect(nativeDb.validateSchemaVersion('1.0.0')).toBe(true);
  });

  it('returns true when versions match', () => {
    nativeDb.setBuildMeta([{ key: 'codegraph_version', value: '3.4.0' }]);
    expect(nativeDb.validateSchemaVersion('3.4.0')).toBe(true);
  });

  it('returns false and warns when versions mismatch', () => {
    nativeDb.setBuildMeta([{ key: 'codegraph_version', value: '3.3.0' }]);
    expect(nativeDb.validateSchemaVersion('3.4.0')).toBe(false);
  });
});
