/**
 * Integration test for #1292: object property write tracking in points-to analysis.
 *
 * Before Phase 8.3d, `handlers.auth = authMiddleware` was not tracked, so
 * `router.use(handlers.auth)` produced no edge to `authMiddleware`.
 *
 * The fix seeds typeMap['handlers.auth'] = { type: 'authMiddleware' } from the
 * assignment_expression walk, then resolveByMethodOrGlobal consults the composite
 * key and resolves the pts target directly.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE = {
  'app.js': `
function authMiddleware(req, res, next) { next(); }
function logRequest(req, res, next) { next(); }

const handlers = {};
handlers.auth = authMiddleware;
handlers.log = logRequest;

function setupRoutes(router) {
  router.use(handlers.auth);
  router.use(handlers.log);
}
`,
};

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1292-'));
  for (const [rel, content] of Object.entries(FIXTURE)) {
    fs.writeFileSync(path.join(tmpDir, rel), content);
  }
  await buildGraph(tmpDir, { incremental: false, skipRegistry: true });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readCallEdges(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n2.name AS tgt, e.kind, e.dynamic, e.technique
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
      )
      .all() as Array<{
      src: string;
      tgt: string;
      kind: string;
      dynamic: number;
      technique: string | null;
    }>;
  } finally {
    db.close();
  }
}

describe('Issue #1292: property write pts tracking (same-file)', () => {
  it('emits a calls edge from setupRoutes to authMiddleware via handlers.auth', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readCallEdges(dbPath);
    const edge = edges.find((e) => e.src === 'setupRoutes' && e.tgt === 'authMiddleware');
    expect(edge).toBeDefined();
    expect(edge!.dynamic).toBe(1);
    // The native orchestrator resolves pts edges via the typeMap (which includes the
    // property-write seed) but labels them 'ts-native' since Rust doesn't distinguish
    // resolution strategy. The JS path labels them 'points-to'. Both are correct.
    // Phase 8.3d composite typeMap key resolution (resolveByReceiver) may also resolve
    // these directly as 'ts-native' on the WASM path. Accept either technique.
    expect(['points-to', 'ts-native']).toContain(edge!.technique);
  });

  it('emits a calls edge from setupRoutes to logRequest via handlers.log', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readCallEdges(dbPath);
    const edge = edges.find((e) => e.src === 'setupRoutes' && e.tgt === 'logRequest');
    expect(edge).toBeDefined();
    expect(edge!.dynamic).toBe(1);
    // Accept both 'points-to' (pre-8.3d) and 'ts-native' (8.3d composite resolution)
    expect(['points-to', 'ts-native']).toContain(edge!.technique);
  });
});
