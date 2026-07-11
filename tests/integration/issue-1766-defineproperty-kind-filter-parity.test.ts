/**
 * Regression test for #1766: the full-build `Object.defineProperty` accessor
 * fallback (`resolveDefinePropertyAccessorFallback` in
 * `stages/build-edges.ts`, plus its native-engine post-pass
 * `buildDefinePropertyPostPass`) and the incremental rebuild path's fallback
 * (`applyCallFallbacks` in `incremental.ts`) used to diverge in their final
 * same-file fallback tier: full-build returned ANY same-file node named
 * `call.name` (unfiltered by kind — could match an unrelated class or
 * variable), while incremental filtered to `function`/`method` kinds only.
 *
 * Both paths now share a single implementation
 * (`resolveDefinePropertyAccessorTarget` in `call-resolver.ts`), so a full
 * build and an incremental single-file rebuild of the same source must
 * produce identical `calls` edges for this pattern.
 *
 * See `tests/unit/call-resolver.test.ts` ("resolveDefinePropertyAccessorTarget
 * — kind filter parity (#1766)") for direct unit coverage of the kind filter
 * itself (an unrelated same-named class/variable in the same file must never
 * win over the actual function/method). That divergence is only observable
 * by calling the fallback function directly: in a full pipeline run, a
 * same-file name collision on the *bare* call name is normally already
 * resolved — correctly or not, see #1888 (a separate, pre-existing,
 * already-shared primary-resolution bug, confirmed identical on both
 * engines) — by `resolveCallTargets`'s own unqualified lookup before this
 * fallback tier is ever reached. This integration test instead locks in
 * end-to-end parity for the overall accessor-fallback feature across
 * full-build vs incremental after the consolidation. (For this specific
 * object-literal fixture, native full builds already resolved the edge via
 * Rust's own independent composite-pts-key mechanism even before #1887 was
 * fixed — the native orchestrator's `definePropertyReceivers` post-pass now
 * also runs and agrees, but it isn't what makes this particular case pass;
 * see `issue-1887-native-defineproperty-postpass.test.ts` for the
 * typed-instance-receiver case that #1887 was actually about.)
 *
 * Mirrors the full-build-vs-incremental-rebuild comparison pattern from
 * `issue-1765-incremental-same-class-barecall.test.ts`.
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
    path.join(dir, 'accessor.js'),
    `// ${marker}
// Object.defineProperty accessor this-dispatch: getter is registered as a
// get accessor for accessorTarget, so \`this\` inside getter refers to
// accessorTarget. this.baz() -> accessorTarget.baz -> baz.
function baz() {
  return 42;
}

const accessorTarget = { baz };

function getter() {
  this.baz();
}

Object.defineProperty(accessorTarget, 'computed', { get: getter });

export function useAccessor() {
  return accessorTarget.computed;
}
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
  describe(`codegraph watch (rebuildFile): Object.defineProperty accessor fallback matches full rebuild (#1766) — ${engine}`, () => {
    let projDir: string;
    let refDir: string;

    beforeAll(async () => {
      projDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1766-watch-${engine}-`));
      writeFixture(projDir, 'v1');
      await buildGraph(projDir, { engine, incremental: false, skipRegistry: true });

      // Edit accessor.js, then rebuild ONLY it via the watcher's single-file
      // incremental path (the exact code path under test).
      writeFixture(projDir, 'v2 edited');
      const dbPath = path.join(projDir, '.codegraph', 'graph.db');
      const db = openDb(dbPath);
      try {
        initSchema(db);
        const stmts = makeStmts(db);
        await rebuildFile(db, projDir, path.join(projDir, 'accessor.js'), stmts, { engine }, null);
      } finally {
        db.close();
      }

      refDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1766-watch-ref-${engine}-`));
      writeFixture(refDir, 'v2 edited');
      await buildGraph(refDir, { engine, incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(projDir, { recursive: true, force: true });
      fs.rmSync(refDir, { recursive: true, force: true });
    });

    it('resolves the accessor this-dispatch edge to the function, matching a full rebuild', () => {
      const incremental = readCallEdges(path.join(projDir, '.codegraph', 'graph.db'));
      const reference = readCallEdges(path.join(refDir, '.codegraph', 'graph.db'));

      expect(reference).toContainEqual({
        src: 'getter',
        srcKind: 'function',
        tgt: 'baz',
        tgtKind: 'function',
        kind: 'calls',
      });

      expect(incremental).toEqual(reference);
      expect(incremental).toContainEqual({
        src: 'getter',
        srcKind: 'function',
        tgt: 'baz',
        tgtKind: 'function',
        kind: 'calls',
      });
    });
  });
}

runWatchScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runWatchScenario('native');
});
