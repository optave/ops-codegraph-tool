/**
 * Unit tests for NativeDatabase.purgeFilesData with reverse_dep_files (#670).
 *
 * Verifies that file purge + reverse-dep outgoing-edge deletion happen
 * atomically in a single transaction when using the native engine.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getNative, isNativeAvailable } from '../../src/infrastructure/native.js';
import type { NativeDatabase } from '../../src/types.js';

const hasNativeDb =
  isNativeAvailable() &&
  typeof getNative().NativeDatabase?.prototype?.purgeFilesData === 'function';

describe.skipIf(!hasNativeDb)('NativeDatabase.purgeFilesData with reverseDepFiles', () => {
  let nativeDb: NativeDatabase;
  let dbPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-purge-revdep-'));
    dbPath = path.join(tmpDir, 'test.db');
    const NativeDB = getNative().NativeDatabase;
    nativeDb = NativeDB.openReadWrite(dbPath);
    nativeDb.initSchema();

    // Seed: three files with cross-file edges
    //   auth.js: authenticate() --calls--> utils.js: validateToken()
    //   app.js:  main()         --calls--> auth.js:  authenticate()
    //   app.js:  main()         --calls--> utils.js: formatResponse()
    nativeDb.exec(`
      INSERT INTO nodes (id, name, kind, file, line) VALUES (1, 'authenticate', 'function', 'auth.js', 10);
      INSERT INTO nodes (id, name, kind, file, line) VALUES (2, 'validateToken', 'function', 'utils.js', 5);
      INSERT INTO nodes (id, name, kind, file, line) VALUES (3, 'main', 'function', 'app.js', 1);
      INSERT INTO nodes (id, name, kind, file, line) VALUES (4, 'formatResponse', 'function', 'utils.js', 20);

      INSERT INTO edges (source_id, target_id, kind) VALUES (1, 2, 'calls');
      INSERT INTO edges (source_id, target_id, kind) VALUES (3, 1, 'calls');
      INSERT INTO edges (source_id, target_id, kind) VALUES (3, 4, 'calls');
    `);
  });

  afterEach(() => {
    nativeDb.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it('purges files AND deletes reverse-dep outgoing edges in one call', () => {
    // Purge auth.js (changed file), delete outgoing edges for app.js (reverse-dep)
    nativeDb.purgeFilesData(['auth.js'], false, ['app.js']);

    // auth.js nodes should be gone
    const authNodes = nativeDb.queryAll("SELECT * FROM nodes WHERE file = 'auth.js'", []);
    expect(authNodes).toHaveLength(0);

    // app.js nodes should still exist (only outgoing edges deleted)
    const appNodes = nativeDb.queryAll("SELECT * FROM nodes WHERE file = 'app.js'", []);
    expect(appNodes).toHaveLength(1);

    // utils.js nodes should still exist
    const utilsNodes = nativeDb.queryAll("SELECT * FROM nodes WHERE file = 'utils.js'", []);
    expect(utilsNodes).toHaveLength(2);

    // All edges should be gone:
    //   - auth.js edges removed by file purge (source_id=1 or target_id=1)
    //   - app.js outgoing edges removed by reverse-dep purge (source_id=3)
    const edges = nativeDb.queryAll('SELECT * FROM edges', []);
    expect(edges).toHaveLength(0);
  });

  it('only deletes outgoing edges for reverse-dep files, not incoming', () => {
    // Add an incoming edge TO app.js from utils.js
    nativeDb.exec(`INSERT INTO edges (source_id, target_id, kind) VALUES (4, 3, 'calls');`);

    // Purge nothing, just clean reverse-dep outgoing edges for app.js
    nativeDb.purgeFilesData([], false, ['app.js']);

    // Outgoing edges from app.js (source_id=3) should be gone
    const outgoing = nativeDb.queryAll('SELECT * FROM edges WHERE source_id = 3', []);
    expect(outgoing).toHaveLength(0);

    // Incoming edge to app.js (target_id=3) should remain
    const incoming = nativeDb.queryAll('SELECT * FROM edges WHERE target_id = 3', []);
    expect(incoming).toHaveLength(1);

    // Edge within auth.js→utils.js should remain (not a reverse-dep)
    const otherEdges = nativeDb.queryAll('SELECT * FROM edges WHERE source_id = 1', []);
    expect(otherEdges).toHaveLength(1);
  });

  it('works with no reverse-dep files (backwards-compatible)', () => {
    nativeDb.purgeFilesData(['auth.js'], false);

    const authNodes = nativeDb.queryAll("SELECT * FROM nodes WHERE file = 'auth.js'", []);
    expect(authNodes).toHaveLength(0);

    // app.js edges should still exist (no reverse-dep cleanup requested)
    const appEdges = nativeDb.queryAll('SELECT * FROM edges WHERE source_id = 3', []);
    expect(appEdges).toHaveLength(1); // edge to utils.js:formatResponse remains
  });

  it('no-ops when both file list and reverse-dep list are empty', () => {
    const before = nativeDb.queryAll('SELECT COUNT(*) as c FROM edges', []);
    nativeDb.purgeFilesData([], false, []);
    const after = nativeDb.queryAll('SELECT COUNT(*) as c FROM edges', []);
    expect(after[0]!.c).toBe(before[0]!.c);
  });

  it('handles reverse-dep-only call (no files to purge)', () => {
    nativeDb.purgeFilesData([], false, ['app.js']);

    // All nodes should remain
    const nodes = nativeDb.queryAll('SELECT COUNT(*) as c FROM nodes', []);
    expect(nodes[0]!.c).toBe(4);

    // Only app.js outgoing edges should be gone
    const edges = nativeDb.queryAll('SELECT * FROM edges', []);
    expect(edges).toHaveLength(1); // auth.js→utils.js remains
  });
});
