/**
 * Integration test for #1895: `roles --role dead` treated a function
 * referenced as an object-literal property VALUE as sufficient evidence of
 * liveness on its own, without checking whether the property is ever
 * actually accessed and invoked (`table.propName(...)`) anywhere.
 *
 * Root cause: the #1771 value-ref mechanism created a `calls` edge from the
 * enclosing scope to the referenced function for every bare-identifier
 * object-literal property value, purely because the reference existed — with
 * no check that the property key is ever member-called. A dispatch-table
 * property that is wired up but genuinely never read (`table.propName(...)`
 * appears nowhere in the codebase) still got fan-in > 0 and was never
 * flagged dead.
 *
 * Fix: value-ref calls originating from an object-literal property now carry
 * the property's key name (`keyExpr`); the resolver only honors the
 * reference as a `calls` edge when that key is independently confirmed to be
 * invoked via member-call syntax (`x.keyExpr(...)`) somewhere in the files
 * being processed. `matches`/`resolve`-style dispatch tables that ARE read
 * through a real `handler.resolve(...)` call site (the #1771 fixture) keep
 * their edges; a property that's wired up but never read does not.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

// `neverRead` is wired into the dispatch table under the `resolve` key but
// `.resolve(...)` never appears anywhere in the fixture — genuinely dead.
// `isRead` is wired under `reject` and IS invoked via `table.reject(...)` in
// `run()` — genuinely live. Both are referenced identically as object-literal
// property values, so only the new invocation check can tell them apart.
const FIXTURE = {
  'factory.js': `
function neverRead(x) { return x + 1; }
function isRead(x) { return x + 2; }
function shorthandNeverRead(x) { return x + 3; }

function makeTable() {
  return {
    resolve: neverRead,
    reject: isRead,
    shorthandNeverRead,
  };
}

module.exports = { makeTable };
`,
  'consumer.js': `
const { makeTable } = require('./factory.js');

function run() {
  const table = makeTable();
  return table.reject(1);
}

module.exports = { run };
`,
};

const DEAD_ROLES = new Set(['dead-unresolved', 'dead-leaf', 'dead-entry', 'dead-ffi']);

function readNodesWithRoles(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT name, kind, role FROM nodes ORDER BY name').all() as Array<{
      name: string;
      kind: string;
      role: string | null;
    }>;
  } finally {
    db.close();
  }
}

function countCallEdgesTo(dbPath: string, targetName: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM edges e
         JOIN nodes t ON e.target_id = t.id
         WHERE e.kind = 'calls' AND t.name = ?`,
      )
      .get(targetName) as { cnt: number };
    return row.cnt;
  } finally {
    db.close();
  }
}

describe('object-literal value-ref requires invocation evidence (#1895) — WASM', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1895-'));
    for (const [rel, content] of Object.entries(FIXTURE)) {
      fs.writeFileSync(path.join(tmpDir, rel), content);
    }
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not create a value-ref calls edge for a property key that is never invoked', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    expect(countCallEdgesTo(dbPath, 'neverRead')).toBe(0);
    expect(countCallEdgesTo(dbPath, 'shorthandNeverRead')).toBe(0);
  });

  it('creates a value-ref calls edge for a property key that IS invoked elsewhere', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    expect(countCallEdgesTo(dbPath, 'isRead')).toBeGreaterThan(0);
  });

  it('classifies the never-invoked dispatch-table entry as dead', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const nodes = readNodesWithRoles(dbPath);
    const neverRead = nodes.find((n) => n.name === 'neverRead' && n.kind === 'function');
    expect(neverRead, 'neverRead node not found').toBeDefined();
    expect(DEAD_ROLES.has(neverRead!.role ?? '')).toBe(true);

    const shorthand = nodes.find((n) => n.name === 'shorthandNeverRead' && n.kind === 'function');
    expect(shorthand, 'shorthandNeverRead node not found').toBeDefined();
    expect(DEAD_ROLES.has(shorthand!.role ?? '')).toBe(true);
  });

  it('does not classify the actually-invoked dispatch-table entry as dead', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const nodes = readNodesWithRoles(dbPath);
    const isRead = nodes.find((n) => n.name === 'isRead' && n.kind === 'function');
    expect(isRead, 'isRead node not found').toBeDefined();
    expect(DEAD_ROLES.has(isRead!.role ?? '')).toBe(false);
  });
});

// ── Native engine parity ────────────────────────────────────────────────────
// Skipped when the native addon is not installed.

describe.skipIf(!isNativeAvailable())(
  'object-literal value-ref requires invocation evidence (#1895) — native',
  () => {
    let nativeTmpDir: string;

    beforeAll(async () => {
      nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1895-native-'));
      for (const [rel, content] of Object.entries(FIXTURE)) {
        fs.writeFileSync(path.join(nativeTmpDir, rel), content);
      }
      await buildGraph(nativeTmpDir, { engine: 'native', incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(nativeTmpDir, { recursive: true, force: true });
    });

    it('does not create a value-ref calls edge for a property key that is never invoked', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      expect(countCallEdgesTo(dbPath, 'neverRead')).toBe(0);
      expect(countCallEdgesTo(dbPath, 'shorthandNeverRead')).toBe(0);
    });

    it('creates a value-ref calls edge for a property key that IS invoked elsewhere', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      expect(countCallEdgesTo(dbPath, 'isRead')).toBeGreaterThan(0);
    });

    it('classifies the never-invoked dispatch-table entry as dead', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const nodes = readNodesWithRoles(dbPath);
      const neverRead = nodes.find((n) => n.name === 'neverRead' && n.kind === 'function');
      expect(neverRead, 'neverRead node not found (native)').toBeDefined();
      expect(DEAD_ROLES.has(neverRead!.role ?? '')).toBe(true);
    });

    it('does not classify the actually-invoked dispatch-table entry as dead', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const nodes = readNodesWithRoles(dbPath);
      const isRead = nodes.find((n) => n.name === 'isRead' && n.kind === 'function');
      expect(isRead, 'isRead node not found (native)').toBeDefined();
      expect(DEAD_ROLES.has(isRead!.role ?? '')).toBe(false);
    });
  },
);
