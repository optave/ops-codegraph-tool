/**
 * Regression test for #1765: incremental single-file rebuild (`codegraph
 * watch` -> `rebuildFile` in `src/domain/graph/builder/incremental.ts`) was
 * missing the same-class bare-call fallback that the full-build path has
 * (`resolveSameClassBareCallFallback` in `stages/build-edges.ts`).
 *
 * For class-scoped languages (non-JS/TS), a bare call with no receiver that
 * fails resolution retries qualified as `<CallerClass>.<callName>` — this is
 * how e.g. C# static sibling calls (`IsValidEmail()` inside
 * `Validators.ValidateUser` -> `Validators.IsValidEmail`) get resolved.
 * `incremental.ts`'s `applyThisReceiverFallbacks` only implemented the
 * `this.method()` and Object.defineProperty fallbacks, so a bare-call sibling
 * edge resolved on a full build could go missing after a watch-mode
 * single-file rebuild of the same file.
 *
 * Mirrors the full-build-vs-incremental-rebuild comparison pattern from
 * `issue-1744-incremental-edge-technique.test.ts`.
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

function writeFixture(dir: string, marker: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'Validators.cs'),
    `namespace Demo;
public static class Validators {
  // ${marker}
  public static bool IsValidEmail(string email) {
    return email.Contains("@");
  }
  public static bool IsValidName(string name) {
    return name.Length >= 2;
  }
  public static bool ValidateUser(string email, string name) {
    return IsValidEmail(email) && IsValidName(name);
  }
}
`,
  );
}

interface CallEdgeRow {
  src: string;
  tgt: string;
  kind: string;
}

function readCallEdges(dbPath: string): CallEdgeRow[] {
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
      .all() as CallEdgeRow[];
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
    upsertFileHash: db.prepare(
      'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)',
    ),
    deleteFileHash: db.prepare('DELETE FROM file_hashes WHERE file = ?'),
  };
}

function runWatchScenario(engine: EngineMode): void {
  describe(`codegraph watch (rebuildFile): same-class bare-call fallback matches full rebuild (#1765) — ${engine}`, () => {
    let projDir: string;
    let refDir: string;

    beforeAll(async () => {
      projDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1765-watch-${engine}-`));
      writeFixture(projDir, 'v1');
      await buildGraph(projDir, { engine, incremental: false, skipRegistry: true });

      // Edit Validators.cs, then rebuild ONLY it via the watcher's
      // single-file incremental path (the exact code path under test).
      writeFixture(projDir, 'v2 edited');
      const dbPath = path.join(projDir, '.codegraph', 'graph.db');
      const db = openDb(dbPath);
      try {
        initSchema(db);
        const stmts = makeStmts(db);
        await rebuildFile(
          db,
          projDir,
          path.join(projDir, 'Validators.cs'),
          stmts,
          { engine },
          null,
        );
      } finally {
        db.close();
      }

      refDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1765-watch-ref-${engine}-`));
      writeFixture(refDir, 'v2 edited');
      await buildGraph(refDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(projDir, { recursive: true, force: true });
      fs.rmSync(refDir, { recursive: true, force: true });
    });

    it('resolves the same-class bare-call sibling edges after rebuildFile, matching a full rebuild', () => {
      const incremental = readCallEdges(path.join(projDir, '.codegraph', 'graph.db'));
      const reference = readCallEdges(path.join(refDir, '.codegraph', 'graph.db'));

      expect(reference).toContainEqual({
        src: 'Validators.ValidateUser',
        tgt: 'Validators.IsValidEmail',
        kind: 'calls',
      });
      expect(reference).toContainEqual({
        src: 'Validators.ValidateUser',
        tgt: 'Validators.IsValidName',
        kind: 'calls',
      });

      expect(incremental).toEqual(reference);
      expect(incremental).toContainEqual({
        src: 'Validators.ValidateUser',
        tgt: 'Validators.IsValidEmail',
        kind: 'calls',
      });
      expect(incremental).toContainEqual({
        src: 'Validators.ValidateUser',
        tgt: 'Validators.IsValidName',
        kind: 'calls',
      });
    });
  });
}

runWatchScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runWatchScenario('native');
});
