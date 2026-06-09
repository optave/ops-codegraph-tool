/**
 * Regression test for #1370: incremental rebuildFile must pass callerName to
 * resolveCallTargets so that Phase 8.3f and class-scoped typeMap lookups work
 * during watch-mode rebuilds.
 *
 * Without the fix, `caller.callerName` was omitted from the resolveCallTargets
 * call in incremental.ts, causing callerName-dependent resolution paths to be
 * silently skipped. In particular:
 *   - class-scoped this.prop typeMap lookup (ClassName.prop → type)
 *   - same-class this.method() fallback (callerClass.methodName lookup)
 *   - Object.defineProperty accessor this-dispatch (callerName:this key)
 *
 * This fixture exercises the class-scoped case: `UserService.run` calls
 * `this.service.doA()` where `this.service = new ServiceA()` was seeded as the
 * class-scoped typeMap key `UserService.service`. Without callerName the
 * incremental path never reaches that lookup and the edge is missing after a
 * watch rebuild.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getNodeId as getNodeIdQuery, initSchema, openDb } from '../../src/db/index.js';
import { rebuildFile } from '../../src/domain/graph/builder/incremental.js';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FILES: Record<string, string> = {
  'service.js': `
export class ServiceA {
  doA() {}
}

export class UserService {
  constructor() {
    this.service = new ServiceA();
  }

  run() {
    this.service.doA();
  }
}
`,
};

function writeFixture(dir: string) {
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function readCallEdges(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n2.name AS tgt, e.kind
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
      )
      .all() as Array<{ src: string; tgt: string; kind: string }>;
  } finally {
    db.close();
  }
}

function makeStmts(db: ReturnType<typeof openDb>) {
  return {
    insertNode: db.prepare(
      'INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
    ),
    getNodeId: {
      get: (name: string, kind: string, file: string, line: number) => {
        const id = getNodeIdQuery(db, name, kind, file, line);
        return id != null ? { id } : undefined;
      },
    },
    insertEdge: db.prepare(
      'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)',
    ),
    countNodes: db.prepare('SELECT COUNT(*) as c FROM nodes WHERE file = ?'),
    countEdges: db.prepare(
      'SELECT COUNT(*) as c FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?)',
    ),
    findNodeInFile: db.prepare(
      "SELECT id, kind, file FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant') AND file = ?",
    ),
    findNodeByName: db.prepare(
      "SELECT id, file, kind FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant')",
    ),
    listSymbols: db.prepare("SELECT name, kind, line FROM nodes WHERE file = ? AND kind != 'file'"),
  };
}

describe('Incremental rebuildFile passes callerName to resolver (#1370)', () => {
  let fullEdges: ReturnType<typeof readCallEdges>;
  let watchEdges: ReturnType<typeof readCallEdges>;
  let tmpBase: string;

  beforeAll(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1370-'));
    const fullDir = path.join(tmpBase, 'full');
    const watchDir = path.join(tmpBase, 'watch');
    writeFixture(fullDir);
    writeFixture(watchDir);

    await buildGraph(fullDir, { incremental: false, skipRegistry: true, engine: 'wasm' });
    await buildGraph(watchDir, { incremental: false, skipRegistry: true, engine: 'wasm' });

    // Touch service.js to simulate a watch-mode modification.
    const watchFile = path.join(watchDir, 'service.js');
    fs.appendFileSync(watchFile, '\n// touch\n');

    // Run the incremental watch path — this is where callerName was missing.
    const db = openDb(path.join(watchDir, '.codegraph', 'graph.db'));
    initSchema(db);
    await rebuildFile(db, watchDir, watchFile, makeStmts(db), { engine: 'wasm' }, null);
    db.close();

    // Apply the same touch to the full-build copy and rebuild from scratch.
    fs.appendFileSync(path.join(fullDir, 'service.js'), '\n// touch\n');
    await buildGraph(fullDir, { incremental: false, skipRegistry: true, engine: 'wasm' });

    fullEdges = readCallEdges(path.join(fullDir, '.codegraph', 'graph.db'));
    watchEdges = readCallEdges(path.join(watchDir, '.codegraph', 'graph.db'));
  }, 60_000);

  afterAll(() => {
    try {
      if (tmpBase) fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('resolves UserService.run → ServiceA.doA after incremental rebuild', () => {
    const edge = watchEdges.find((e) => e.src === 'UserService.run' && e.tgt === 'ServiceA.doA');
    expect(
      edge,
      'Expected UserService.run → ServiceA.doA call edge (class-scoped this.service typeMap lookup requires callerName)',
    ).toBeDefined();
  });

  it('incremental call edges match a clean full build', () => {
    const key = (e: { src: string; tgt: string }) => `${e.src} → ${e.tgt}`;
    const fullSet = new Set(fullEdges.map(key));
    const watchSet = new Set(watchEdges.map(key));
    const missing = [...fullSet].filter((k) => !watchSet.has(k));
    const extra = [...watchSet].filter((k) => !fullSet.has(k));
    if (missing.length || extra.length) {
      expect.fail(
        `Edge mismatch:\n  Missing in watch: ${missing.join(', ') || 'none'}\n  Extra in watch: ${extra.join(', ') || 'none'}`,
      );
    }
    expect(watchEdges).toEqual(fullEdges);
  });
});
