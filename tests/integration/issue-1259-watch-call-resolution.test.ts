/**
 * Watch-mode call-resolution parity (#1259).
 *
 * The watcher's `rebuildFile` reverse-dep cascade had its own call resolver
 * (`resolveCallTargets`/`buildCallEdges` in incremental.ts) that diverged from
 * the authoritative full-build resolver (`stages/build-edges.ts`):
 *   - global name fallback was unconditional (no receiver gating, no
 *     confidence >= 0.5 filter) -> fanned out false-positive `calls` edges
 *   - no dedup -> duplicate `calls` rows on every rebuild
 *   - import-scoped lookup did not follow barrel re-exports -> dropped edges
 *
 * On the codegraph repo a comment-only watch rebuild of a widely-imported file
 * inflated `calls` edges by ~700. This fixture reproduces all three failure
 * modes in miniature and asserts the cascade now matches a clean full build.
 *
 * Drives `rebuildFile` directly (the watch path), NOT buildGraph's incremental
 * path — the latter goes through the native orchestrator and never exercised
 * the buggy JS cascade, which is why the existing parity tests passed.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getNodeId as getNodeIdQuery, initSchema, openDb } from '../../src/db/index.js';
import { rebuildFile } from '../../src/domain/graph/builder/incremental.js';
import { buildGraph } from '../../src/domain/graph/builder.js';

// Files are laid out so that an unimported call to a same-named symbol in a
// distant directory resolves at confidence 0.3 (different grandparent dir) —
// below the 0.5 global-fallback threshold the full build enforces.
const FILES: Record<string, string> = {
  'app/feature/leaf.js': `export function leafVal() {\n  return 42;\n}\n`,
  'app/feature/consumer.js':
    `import { leafVal } from './leaf.js';\n` +
    `import { wrapped } from '../../lib/barrel.js';\n` +
    `export function run() {\n` +
    `  leafVal();\n` +
    `  leafVal();\n` + // duplicate call site -> must dedup to one edge
    `  wrapped();\n` + // barrel re-export -> must resolve to lib/impl.js
    `  commonName();\n` + // unimported, distant same-named symbol -> must be dropped (conf 0.3)
    `  return 0;\n` +
    `}\n`,
  'lib/barrel.js': `export { wrapped } from './impl.js';\n`,
  'lib/impl.js': `export function wrapped() {\n  return 'w';\n}\n`,
  'extra/deep/dup.js': `export function commonName() {\n  return 'd';\n}\n`,
};

function writeFixture(dir: string) {
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function readEdges(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.file AS src_file, n1.name AS src, n2.file AS tgt_file, n2.name AS tgt, e.kind, e.confidence, e.dynamic
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         ORDER BY n1.file, n1.name, n2.file, n2.name, e.kind`,
      )
      .all();
  } finally {
    db.close();
  }
}

/** Prepared statements the watcher normally supplies (mirrors watcher.ts). */
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
      // `kind` column included for resolveByMethodOrGlobal's method filter.
      "SELECT id, file, kind FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant')",
    ),
    listSymbols: db.prepare("SELECT name, kind, line FROM nodes WHERE file = ? AND kind != 'file'"),
  };
}

describe('Watch-mode call resolution parity (#1259)', () => {
  let fullEdges: ReturnType<typeof readEdges>;
  let watchEdges: ReturnType<typeof readEdges>;
  let tmpBase: string;

  beforeAll(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1259-'));
    const fullDir = path.join(tmpBase, 'full');
    const watchDir = path.join(tmpBase, 'watch');
    writeFixture(fullDir);
    writeFixture(watchDir);

    // Baseline full build on both copies.
    await buildGraph(fullDir, { incremental: false, skipRegistry: true });
    await buildGraph(watchDir, { incremental: false, skipRegistry: true });

    // Comment-only touch on the leaf, which is a reverse-dep of consumer.js.
    const touch = '\n// watch touch\n';
    const watchLeaf = path.join(watchDir, 'app/feature/leaf.js');
    fs.appendFileSync(watchLeaf, touch);

    // Watch path: rebuild via the JS cascade (reverse-dep cascade re-resolves
    // consumer.js, which is where the resolver divergence manifested).
    const db = openDb(path.join(watchDir, '.codegraph', 'graph.db'));
    initSchema(db);
    await rebuildFile(db, watchDir, watchLeaf, makeStmts(db), { engine: 'auto' }, null);
    db.close();

    // Same edit + clean full rebuild on the other copy for the parity oracle.
    fs.appendFileSync(path.join(fullDir, 'app/feature/leaf.js'), touch);
    await buildGraph(fullDir, { incremental: false, skipRegistry: true });

    fullEdges = readEdges(path.join(fullDir, '.codegraph', 'graph.db'));
    watchEdges = readEdges(path.join(watchDir, '.codegraph', 'graph.db'));
  }, 60_000);

  afterAll(() => {
    try {
      if (tmpBase) fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('does not inflate or duplicate calls edges (matches full build count)', () => {
    const fullCalls = fullEdges.filter((e) => e.kind === 'calls');
    const watchCalls = watchEdges.filter((e) => e.kind === 'calls');
    expect(watchCalls.length).toBe(fullCalls.length);
  });

  it('produces edges identical to a clean full build', () => {
    if (watchEdges.length !== fullEdges.length) {
      const key = (e: {
        src_file: string;
        src: string;
        tgt_file: string;
        tgt: string;
        kind: string;
      }) => `${e.src_file}:${e.src} -[${e.kind}]-> ${e.tgt_file}:${e.tgt}`;
      const fSet = new Set(fullEdges.map(key));
      const wSet = new Set(watchEdges.map(key));
      const missing = [...fSet].filter((k) => !wSet.has(k));
      const extra = [...wSet].filter((k) => !fSet.has(k));
      expect.fail(
        `Edge mismatch:\n  Missing in watch: ${missing.join('\n    ') || 'none'}\n  Extra in watch: ${extra.join('\n    ') || 'none'}`,
      );
    }
    expect(watchEdges).toEqual(fullEdges);
  });

  it('resolves a barrel-re-exported call to its defining file', () => {
    const barrelCall = fullEdges.find(
      (e) => e.kind === 'calls' && e.src === 'run' && e.tgt === 'wrapped',
    );
    expect(barrelCall?.tgt_file).toContain('lib/impl.js');
    expect(watchEdges).toContainEqual(barrelCall);
  });

  it('drops the unimported distant same-named call (confidence < 0.5)', () => {
    const fanout = watchEdges.filter((e) => e.kind === 'calls' && e.tgt === 'commonName');
    expect(fanout).toEqual([]);
  });
});
