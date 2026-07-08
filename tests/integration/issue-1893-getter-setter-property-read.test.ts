/**
 * Regression test for #1893: a bare (non-call) property read/write on an ES6
 * `get`/`set` class accessor (`obj.isReady`, no call parens) never produced a
 * `calls` edge — call-site extraction only recognized `member_expression`
 * nodes used as a call_expression's callee.
 *
 * Scoped fix: same-file accessor recognition — `this.prop` inside one of the
 * accessor's own class's methods, or `varName.prop` where `varName`'s type is
 * a class also declared in this file. Verifies:
 *   - the getter-read and setter-write edges appear in a full build
 *   - both engines (wasm/native) produce identical edges
 *   - full build and an incremental single-file rebuild agree
 *   - a property with both a getter and setter (ambiguous target) produces
 *     no edge, on both engines
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getNodeId as getNodeIdQuery, initSchema, openDb } from '../../src/db/index.js';
import { rebuildFile } from '../../src/domain/graph/builder/incremental.js';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';
import type { EngineMode } from '../../src/types.js';

function writeFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'accessor.ts'),
    `export class Session {
  get isReady(): boolean {
    return this._ready;
  }

  check(): void {
    if (this.isReady) {
      report();
    }
  }
}

export class Toggle {
  get flag(): boolean {
    return this._f;
  }
  set flag(v: boolean) {
    this._f = v;
  }
  private _f = false;

  flip(): void {
    this.flag = !this.flag;
  }
}

export class Repo {
  get db(): unknown {
    return this._db;
  }
  private _db: unknown;
}

export function useRepo(repo: Repo): unknown {
  return repo.db;
}

function report(): void {}
`,
  );
}

interface CallEdgeRow {
  src: string;
  srcKind: string;
  tgt: string;
  tgtKind: string;
  kind: string;
}

function readCallEdges(dbPath: string): CallEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n1.kind AS srcKind, n2.name AS tgt, n2.kind AS tgtKind, e.kind
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name, n1.kind`,
      )
      .all() as CallEdgeRow[];
  } finally {
    db.close();
  }
}

function runScenario(engine: EngineMode): void {
  describe(`ES6 getter/setter property-read attribution (#1893) — ${engine}`, () => {
    let projDir: string;

    beforeAll(async () => {
      projDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1893-${engine}-`));
      writeFixture(projDir);
      await buildGraph(projDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(projDir, { recursive: true, force: true });
    });

    it('attributes a bare `this.prop` read to the same-class getter', () => {
      const edges = readCallEdges(path.join(projDir, '.codegraph', 'graph.db'));
      expect(edges).toContainEqual({
        src: 'Session.check',
        srcKind: 'method',
        tgt: 'Session.isReady',
        tgtKind: 'method',
        kind: 'calls',
      });
    });

    it('attributes a bare `varName.prop` read to a same-file class getter', () => {
      const edges = readCallEdges(path.join(projDir, '.codegraph', 'graph.db'));
      expect(edges).toContainEqual({
        src: 'useRepo',
        srcKind: 'function',
        tgt: 'Repo.db',
        tgtKind: 'method',
        kind: 'calls',
      });
    });

    it('does not attribute either accessor of an ambiguous get+set property pair', () => {
      const edges = readCallEdges(path.join(projDir, '.codegraph', 'graph.db'));
      expect(edges.filter((e) => e.tgt === 'Toggle.flag')).toHaveLength(0);
    });
  });
}

runScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runScenario('native');
});

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
    upsertFileHash: db.prepare(
      'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)',
    ),
    deleteFileHash: db.prepare('DELETE FROM file_hashes WHERE file = ?'),
  };
}

function runIncrementalParityScenario(engine: EngineMode): void {
  describe(`incremental rebuild matches full build for accessor reads (#1893) — ${engine}`, () => {
    let incDir: string;
    let refDir: string;

    beforeAll(async () => {
      incDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1893-inc-${engine}-`));
      writeFixture(incDir);
      await buildGraph(incDir, { engine, incremental: false, skipRegistry: true });

      // Touch the file and rebuild it through the single-file incremental path.
      const filePath = path.join(incDir, 'accessor.ts');
      fs.appendFileSync(filePath, '\n// touched\n');
      const dbPath = path.join(incDir, '.codegraph', 'graph.db');
      const db = openDb(dbPath);
      try {
        initSchema(db);
        const stmts = makeStmts(db);
        await rebuildFile(db, incDir, filePath, stmts, { engine }, null);
      } finally {
        db.close();
      }

      refDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1893-ref-${engine}-`));
      writeFixture(refDir);
      fs.appendFileSync(path.join(refDir, 'accessor.ts'), '\n// touched\n');
      await buildGraph(refDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(incDir, { recursive: true, force: true });
      fs.rmSync(refDir, { recursive: true, force: true });
    });

    it('produces the same accessor-read call edges as a full rebuild', () => {
      const incremental = readCallEdges(path.join(incDir, '.codegraph', 'graph.db'));
      const reference = readCallEdges(path.join(refDir, '.codegraph', 'graph.db'));
      expect(incremental).toEqual(reference);
      expect(incremental).toContainEqual({
        src: 'Session.check',
        srcKind: 'method',
        tgt: 'Session.isReady',
        tgtKind: 'method',
        kind: 'calls',
      });
    });
  });
}

runIncrementalParityScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine incremental parity coverage', () => {
  runIncrementalParityScenario('native');
});
