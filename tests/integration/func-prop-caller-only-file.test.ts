/**
 * Integration test for #1371: func-prop post-pass misses call edges in files
 * that only CALL but don't DEFINE func-prop methods.
 *
 * Verifies that a cross-file edge `caller → f.process` is emitted when
 * `lib.js` defines `f.process = function(){}` but `app.js` only calls
 * `f.process()` (no func-prop definition in app.js).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE = {
  // lib.js: defines f.process — matches protoFiles regex, first WASM pass
  'lib.js': `
function f() {}
f.process = function(x) { return x * 2; }
`,
  // app.js: only CALLS f.process — does NOT match protoFiles regex
  // (no "fn.method = function" pattern), so it was excluded before #1371 fix
  'app.js': `
function caller() {
  return f.process(5);
}
`,
};

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1371-'));
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
        `SELECT n1.name AS src, n2.name AS tgt
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
      )
      .all() as Array<{ src: string; tgt: string }>;
  } finally {
    db.close();
  }
}

describe('func-prop caller-only file (#1371)', () => {
  it('inserts f.process as a method node from lib.js', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const db = new Database(dbPath, { readonly: true });
    try {
      const node = db.prepare(`SELECT name, kind FROM nodes WHERE name = 'f.process'`).get() as
        | { name: string; kind: string }
        | undefined;
      expect(node).toBeDefined();
      expect(node?.kind).toBe('method');
    } finally {
      db.close();
    }
  });

  it('emits caller → f.process edge across files', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readCallEdges(dbPath);
    const edge = edges.find((e) => e.src === 'caller' && e.tgt === 'f.process');
    expect(edge).toBeDefined();
  });
});
