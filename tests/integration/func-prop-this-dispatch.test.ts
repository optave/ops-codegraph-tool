/**
 * Integration test for #1334: this-dispatch in function-as-object property methods.
 *
 * Verifies that `f.h → f.g` is resolved when `f.h = function() { this.g(); }`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE = {
  'this.js': `
function f() {}
f.g = function() { console.log("2"); }
f.h = function() {
    this.g();
}
f.h();
`,
};

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1334-'));
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

describe('func-prop this-dispatch (#1334)', () => {
  it('emits f.g as a method definition', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const db = new Database(dbPath, { readonly: true });
    try {
      const node = db.prepare(`SELECT name, kind FROM nodes WHERE name = 'f.g'`).get() as
        | { name: string; kind: string }
        | undefined;
      expect(node).toBeDefined();
      expect(node?.kind).toBe('method');
    } finally {
      db.close();
    }
  });

  it('emits f.h as a method definition', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const db = new Database(dbPath, { readonly: true });
    try {
      const node = db.prepare(`SELECT name, kind FROM nodes WHERE name = 'f.h'`).get() as
        | { name: string; kind: string }
        | undefined;
      expect(node).toBeDefined();
      expect(node?.kind).toBe('method');
    } finally {
      db.close();
    }
  });

  it('resolves this.g() inside f.h to f.g', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readCallEdges(dbPath);
    const edge = edges.find((e) => e.src === 'f.h' && e.tgt === 'f.g');
    expect(edge).toBeDefined();
  });
});
