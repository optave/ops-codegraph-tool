/**
 * Regression test for #1744: a `calls` edge's `technique` DB column differed
 * depending on whether it was inserted via a full build or an incremental
 * rebuild of the same final source state.
 *
 * Full builds always tag directly-resolved `calls` edges `technique =
 * 'ts-native'` — a resolution-technique label applied by BOTH engines (not a
 * native-engine marker): `emitDirectCallEdgesForCall` for the WASM/JS
 * pipeline and `buildCallEdgesNative` for the native pipeline, both in
 * `stages/build-edges.ts`. WASM/JS writes it inline via `batchInsertEdges`;
 * native writes it via a post-insert backfill, since neither the native bulk
 * `insertEdge` FFI nor the Rust orchestrator write `technique` at insert
 * time.
 *
 * Two independent incremental-rebuild code paths had the same gap — the
 * backfill never ran, or ran with an incomplete scope — both fixed here:
 *
 *   1. `codegraph watch` -> `rebuildFile` -> `buildCallEdges` ->
 *      `emitIncrementalCallEdges` in `src/domain/graph/builder/incremental.ts`
 *      inserted `calls` edges via `stmts.insertEdge.run(...)` without ever
 *      setting `technique`, for either engine. Fixed by
 *      `backfillIncrementalEdgeTechniques`, called unconditionally at the end
 *      of `rebuildFile`.
 *
 *   2. `codegraph build` (default incremental mode, native engine) ->
 *      `tryNativeOrchestrator`'s own backfill
 *      (`backfillEdgeTechniquesAfterNativeOrchestrator` in
 *      `stages/native-orchestrator.ts`) scoped its UPDATE to only the
 *      directly-changed files the Rust pipeline reports — missing one-hop
 *      reverse dependents (e.g. `callerA.js`/`callerB.js`) whose outgoing
 *      edges into the changed file are reconnected by Rust's own
 *      reverse-dep cascade (their target node IDs shifted when the changed
 *      file's nodes were purged + reinserted) and so also carry a fresh,
 *      untagged `technique`. Fixed by `findOneHopReverseDepFiles`, which
 *      expands the backfill's scope to include them.
 *
 * Fixture: callerA.js/callerB.js import and call `callee()` from callee.js.
 * Editing callee.js (the file with *incoming* call edges, not a caller
 * itself) is the scenario that exercises the reverse-dep cascade for gap (2)
 * above — editing a caller file directly would already have worked even
 * before this fix, since a changed file's own outgoing edges are always
 * freshly (re)computed as part of its own changed-file processing.
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

function writeFixture(dir: string, calleeMarker: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'callee.js'),
    `export function callee() {\n  ${calleeMarker}\n  return 1;\n}\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'callerA.js'),
    `import { callee } from './callee.js';\nexport function callerA() {\n  return callee();\n}\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'callerB.js'),
    `import { callee } from './callee.js';\nexport function callerB() {\n  return callee();\n}\n`,
  );
}

interface CallEdgeRow {
  srcFile: string;
  src: string;
  tgt: string;
  technique: string | null;
  confidence: number;
}

function readCallEdges(dbPath: string): CallEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.file AS srcFile, n1.name AS src, n2.name AS tgt, e.technique, e.confidence
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.file, n1.name, n2.name`,
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

// ── Suite 1: codegraph build --engine native (native orchestrator's own
//    incremental path, stages/native-orchestrator.ts) ──────────────────────

describe.skipIf(!isNativeAvailable())(
  'codegraph build --engine native: incremental rebuild technique matches full rebuild (#1744)',
  () => {
    let projDir: string;
    let refDir: string;

    beforeAll(async () => {
      projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1744-buildcli-'));
      writeFixture(projDir, '// v1');
      await buildGraph(projDir, { engine: 'native', incremental: false, skipRegistry: true });

      // Edit ONLY callee.js — callerA.js/callerB.js are reverse deps whose
      // outgoing edges get reconnected by the Rust incremental cascade.
      writeFixture(projDir, '// v2 edited');
      await buildGraph(projDir, { engine: 'native', skipRegistry: true }); // incremental (default)

      refDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1744-buildcli-ref-'));
      writeFixture(refDir, '// v2 edited');
      await buildGraph(refDir, { engine: 'native', incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(projDir, { recursive: true, force: true });
      fs.rmSync(refDir, { recursive: true, force: true });
    });

    it('tags reverse-dependent calls edges technique=ts-native after an incremental rebuild, matching a full rebuild', () => {
      const incremental = readCallEdges(path.join(projDir, '.codegraph', 'graph.db'));
      const reference = readCallEdges(path.join(refDir, '.codegraph', 'graph.db'));

      expect(incremental.length).toBeGreaterThan(0);
      expect(incremental).toEqual(reference);
      for (const edge of incremental) {
        expect(
          edge.technique,
          `${edge.srcFile}: ${edge.src} -> ${edge.tgt} should be technique='ts-native', not ${edge.technique}`,
        ).toBe('ts-native');
      }
    });
  },
);

// ── Suite 2: codegraph watch (rebuildFile, builder/incremental.ts) ─────────

function runWatchScenario(engine: EngineMode): void {
  describe(`codegraph watch (rebuildFile): incremental rebuild technique matches full rebuild (#1744) — ${engine}`, () => {
    let projDir: string;
    let refDir: string;

    beforeAll(async () => {
      projDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1744-watch-${engine}-`));
      writeFixture(projDir, '// v1');
      await buildGraph(projDir, { engine, incremental: false, skipRegistry: true });

      // Edit ONLY callee.js via the watcher's single-file rebuild path.
      writeFixture(projDir, '// v2 edited');
      const dbPath = path.join(projDir, '.codegraph', 'graph.db');
      const db = openDb(dbPath);
      try {
        initSchema(db);
        const stmts = makeStmts(db);
        await rebuildFile(db, projDir, path.join(projDir, 'callee.js'), stmts, { engine }, null);
      } finally {
        db.close();
      }

      refDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1744-watch-ref-${engine}-`));
      writeFixture(refDir, '// v2 edited');
      await buildGraph(refDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(projDir, { recursive: true, force: true });
      fs.rmSync(refDir, { recursive: true, force: true });
    });

    it('tags reverse-dependent calls edges technique=ts-native after rebuildFile, matching a full rebuild', () => {
      const incremental = readCallEdges(path.join(projDir, '.codegraph', 'graph.db'));
      const reference = readCallEdges(path.join(refDir, '.codegraph', 'graph.db'));

      expect(incremental.length).toBeGreaterThan(0);
      expect(incremental).toEqual(reference);
      for (const edge of incremental) {
        expect(
          edge.technique,
          `${edge.srcFile}: ${edge.src} -> ${edge.tgt} should be technique='ts-native', not ${edge.technique}`,
        ).toBe('ts-native');
      }
    });
  });
}

runWatchScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runWatchScenario('native');
});
