/**
 * Regression test for #1852: `codegraph watch`'s single-file incremental
 * rebuild path (`rebuildFile`/`buildCallEdges` in
 * `src/domain/graph/builder/incremental.ts`) used to implement only a
 * subset of the full-build call-edge resolution cascade, silently DROPPING
 * (not just mislabeling — genuinely absent from the graph) three categories
 * of edges whenever the file containing the call site was rebuilt via watch
 * mode instead of a full build:
 *
 *   1. CHA/RTA virtual-dispatch edges (technique='cha'/'super-dispatch') —
 *      interface-method dispatch, this-dispatch, and super-dispatch.
 *   2. Points-to/alias-resolved edges (technique='points-to') — higher-order
 *      function aliasing.
 *   3. Dynamic-sink edges for flag-only dynamic call kinds (eval,
 *      computed-key, reflection, unresolved-dynamic) — `dynamic_kind` column
 *      set, target = the file node.
 *
 * Each suite below: build full, edit the file containing the relevant call
 * site via `rebuildFile` (the exact function `codegraph watch` calls per
 * file-change event), then assert the edges a full rebuild of the identical
 * post-edit state produces are still present.
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

const CHA_FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'cha-dispatch');

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

interface CallEdgeRow {
  src: string;
  srcFile: string;
  tgt: string;
  tgtFile: string;
  technique: string | null;
  confidence: number;
  dynamicKind: string | null;
}

function readCallEdges(dbPath: string): CallEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n1.file AS srcFile, n2.name AS tgt, n2.file AS tgtFile,
                e.technique, e.confidence, e.dynamic_kind AS dynamicKind
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.file, n1.name, n2.file, n2.name`,
      )
      .all() as CallEdgeRow[];
  } finally {
    db.close();
  }
}

/**
 * Drop `technique` before comparing an incremental rebuild's edges against a
 * from-scratch full build's edges. `technique` is intentionally excluded
 * here: the two full-build engines (WASM inline vs native post-pass/native
 * orchestrator) already disagree with each other on the exact technique
 * label for CHA/super-dispatch (`cha` vs `super-dispatch` vs `cha-expanded`)
 * and points-to (`points-to` vs `ts-native`) edges — a separate, pre-existing
 * cross-engine taxonomy gap (#1996), not a symptom of #1852. Comparing
 * everything else (source, target, confidence, dynamic_kind) is what
 * actually proves #1852's fix: the incremental rebuild must produce the same
 * EDGES a full rebuild does, not necessarily identical technique metadata
 * against every possible reference engine.
 */
function withoutTechnique(edges: CallEdgeRow[]): Array<Omit<CallEdgeRow, 'technique'>> {
  return edges.map(({ technique: _technique, ...rest }) => rest);
}

/** Build the prepared statements object that watcher.ts normally provides. */
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

async function rebuildOneFile(dir: string, relFile: string, engine: EngineMode): Promise<void> {
  const dbPath = path.join(dir, '.codegraph', 'graph.db');
  const db = openDb(dbPath);
  try {
    initSchema(db);
    const stmts = makeStmts(db);
    await rebuildFile(db, dir, path.join(dir, relFile), stmts, { engine } as never, null);
  } finally {
    db.close();
  }
}

function appendTrivialEdit(filePath: string): void {
  fs.appendFileSync(filePath, '\n// trivial edit\n');
}

// ── Suite 1: CHA/RTA dispatch (interface dispatch, this-dispatch, super-dispatch) ──

function runChaScenario(engine: EngineMode): void {
  describe(`codegraph watch (rebuildFile): CHA/RTA dispatch edges survive a single-file rebuild (#1852) — ${engine}`, () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1852-cha-${engine}-`));
      copyDirSync(CHA_FIXTURE_DIR, tmpDir);
      await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });

      // Edit each file that owns a call site relevant to CHA/RTA dispatch,
      // via the exact function codegraph watch calls per file-change event.
      for (const relFile of ['Dispatcher.ts', 'ConcreteWorker.ts', 'Lion.ts']) {
        appendTrivialEdit(path.join(tmpDir, relFile));
        await rebuildOneFile(tmpDir, relFile, engine);
      }
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function edges(): CallEdgeRow[] {
      return readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
    }

    it('CHA: keeps dispatch -> ConcreteWorker.doWork after the rebuild (instantiated implementor)', () => {
      const all = edges();
      const found = all.find(
        (e) =>
          e.src === 'dispatch' &&
          e.tgt === 'ConcreteWorker.doWork' &&
          e.tgtFile === 'ConcreteWorker.ts',
      );
      expect(found, `Actual edges:\n${JSON.stringify(all, null, 2)}`).toBeDefined();
      expect(found?.technique).toBe('cha');
    });

    it('CHA: keeps dispatch -> MockWorker.doWork after the rebuild (instantiated implementor)', () => {
      const all = edges();
      const found = all.find(
        (e) =>
          e.src === 'dispatch' && e.tgt === 'MockWorker.doWork' && e.tgtFile === 'MockWorker.ts',
      );
      expect(found, `Actual edges:\n${JSON.stringify(all, null, 2)}`).toBeDefined();
      expect(found?.technique).toBe('cha');
    });

    it('RTA: still excludes dispatch -> GhostWorker.doWork (never instantiated) after the rebuild', () => {
      const found = edges().find((e) => e.src === 'dispatch' && e.tgt === 'GhostWorker.doWork');
      expect(found).toBeUndefined();
    });

    it('this-dispatch: keeps ConcreteWorker.doWork -> ConcreteWorker.prepare after the rebuild', () => {
      const all = edges();
      const found = all.find(
        (e) => e.src === 'ConcreteWorker.doWork' && e.tgt === 'ConcreteWorker.prepare',
      );
      expect(found, `Actual edges:\n${JSON.stringify(all, null, 2)}`).toBeDefined();
    });

    it('super-dispatch: keeps Lion.speak -> Animal.speak after the rebuild', () => {
      const all = edges();
      const found = all.find((e) => e.src === 'Lion.speak' && e.tgt === 'Animal.speak');
      expect(found, `Actual edges:\n${JSON.stringify(all, null, 2)}`).toBeDefined();
      expect(found?.technique).toBe('super-dispatch');
    });

    it('super-dispatch: still does not CHA-expand Lion.speak to sibling Tiger.speak after the rebuild', () => {
      const found = edges().find((e) => e.src === 'Lion.speak' && e.tgt === 'Tiger.speak');
      expect(found).toBeUndefined();
    });

    it('matches a full rebuild of the identical post-edit source state (calls edges)', async () => {
      const refDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1852-cha-ref-${engine}-`));
      try {
        copyDirSync(CHA_FIXTURE_DIR, refDir);
        for (const relFile of ['Dispatcher.ts', 'ConcreteWorker.ts', 'Lion.ts']) {
          appendTrivialEdit(path.join(refDir, relFile));
        }
        await buildGraph(refDir, { engine, incremental: false, skipRegistry: true });
        const reference = readCallEdges(path.join(refDir, '.codegraph', 'graph.db'));
        const incremental = edges();
        expect(withoutTechnique(incremental)).toEqual(withoutTechnique(reference));
      } finally {
        fs.rmSync(refDir, { recursive: true, force: true });
      }
    });
  });
}

runChaScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runChaScenario('native');
});

// ── Suite 2: points-to alias resolution ────────────────────────────────────

function writePtsFixture(dir: string, consumerMarker: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'handler.js'),
    'export function handler(item) {\n  return item * 2;\n}\n',
  );
  fs.writeFileSync(
    path.join(dir, 'consumer.js'),
    `import { handler } from './handler.js';\n${consumerMarker}\nexport function processItems(items) {\n  const alias = handler;\n  return items.map(alias);\n}\n`,
  );
}

function runPtsScenario(engine: EngineMode): void {
  describe(`codegraph watch (rebuildFile): points-to alias edges survive a single-file rebuild (#1852) — ${engine}`, () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1852-pts-${engine}-`));
      writePtsFixture(tmpDir, '// v1');
      await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });

      writePtsFixture(tmpDir, '// v2 edited');
      await rebuildOneFile(tmpDir, 'consumer.js', engine);
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('keeps processItems -> handler (points-to alias) after the rebuild', () => {
      const all = readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
      const found = all.find((e) => e.src === 'processItems' && e.tgt === 'handler');
      expect(found, `Actual edges:\n${JSON.stringify(all, null, 2)}`).toBeDefined();
      expect(found?.technique).toBe('points-to');
    });

    it('matches a full rebuild of the identical post-edit source state (calls edges)', async () => {
      const refDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1852-pts-ref-${engine}-`));
      try {
        writePtsFixture(refDir, '// v2 edited');
        await buildGraph(refDir, { engine, incremental: false, skipRegistry: true });
        const reference = readCallEdges(path.join(refDir, '.codegraph', 'graph.db'));
        const incremental = readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
        expect(withoutTechnique(incremental)).toEqual(withoutTechnique(reference));
      } finally {
        fs.rmSync(refDir, { recursive: true, force: true });
      }
    });
  });
}

runPtsScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runPtsScenario('native');
});

// ── Suite 3: dynamic-sink edges for flag-only dynamic call kinds ──────────

function writeDynamicSinkFixture(dir: string, marker: string): void {
  fs.mkdirSync(dir, { recursive: true });
  // `eval(code)` here is fixture SOURCE TEXT written to a temp scratch
  // directory for codegraph to statically parse — it is never executed by
  // this test or by codegraph itself. It exists solely to exercise the
  // extractor's `dynamicKind: 'eval'` classification (see
  // tests/engines/dynamic-call-ffi.test.ts for the same pattern).
  fs.writeFileSync(
    path.join(dir, 'dynamic.js'),
    `${marker}\nexport function runEval(code) {\n  return eval(code);\n}\n`,
  );
}

function runDynamicSinkScenario(engine: EngineMode): void {
  describe(`codegraph watch (rebuildFile): dynamic-sink edges survive a single-file rebuild (#1852) — ${engine}`, () => {
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1852-sink-${engine}-`));
      writeDynamicSinkFixture(tmpDir, '// v1');
      await buildGraph(tmpDir, { engine, incremental: false, skipRegistry: true });

      writeDynamicSinkFixture(tmpDir, '// v2 edited');
      await rebuildOneFile(tmpDir, 'dynamic.js', engine);
    }, 60_000);

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('keeps the eval() sink edge (confidence=0.0, dynamic_kind=eval) after the rebuild', () => {
      const all = readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
      const found = all.find(
        (e) => e.src === 'runEval' && e.tgt === 'dynamic.js' && e.dynamicKind === 'eval',
      );
      expect(found, `Actual edges:\n${JSON.stringify(all, null, 2)}`).toBeDefined();
      expect(found?.confidence).toBe(0);
    });

    it('matches a full rebuild of the identical post-edit source state (calls edges)', async () => {
      const refDir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-1852-sink-ref-${engine}-`));
      try {
        writeDynamicSinkFixture(refDir, '// v2 edited');
        await buildGraph(refDir, { engine, incremental: false, skipRegistry: true });
        const reference = readCallEdges(path.join(refDir, '.codegraph', 'graph.db'));
        const incremental = readCallEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
        expect(withoutTechnique(incremental)).toEqual(withoutTechnique(reference));
      } finally {
        fs.rmSync(refDir, { recursive: true, force: true });
      }
    });
  });
}

runDynamicSinkScenario('wasm');
describe.skipIf(!isNativeAvailable())('native engine coverage', () => {
  runDynamicSinkScenario('native');
});
