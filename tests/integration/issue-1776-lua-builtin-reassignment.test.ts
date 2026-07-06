/**
 * Integration test for #1776: a Lua function assigned to a global/builtin
 * identifier (the `require = tracedRequire` monkey-patch pattern) was
 * misclassified `dead-unresolved` despite being genuinely invoked at
 * runtime through every later unqualified use of the builtin name.
 *
 * Root cause: the function is never called by its own name — it's assigned
 * to the `require` builtin, then invoked only via subsequent `require(...)`
 * call sites. Codegraph's static resolver had no extraction logic at all
 * for bare (non-`local`) `assignment_statement` nodes, so `require =
 * tracedRequire` produced zero edges: not a call, and the assignment itself
 * was never even inspected.
 *
 * Fix: both engines now emit a dynamic `calls` edge (dynamic=1,
 * dynamicKind/dynamic_kind = 'value-ref' — the same classification #1771
 * uses for object-literal property-value references) from the enclosing
 * scope to the RHS function, for any plain `identifier = identifier`
 * assignment whose LHS matches a recognized Lua builtin/stdlib-module name.
 * Deliberately scoped to that pattern only — reassigning a locally-declared
 * (non-builtin) global, or aliasing via a `local` variable that isn't
 * itself a builtin name, is a general points-to/alias-tracking problem this
 * fix does not attempt to solve, and remains dead-unresolved as before.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

// Mirrors the real-world fixture from issue #1776
// (tests/benchmarks/resolution/tracer/lua-tracer.lua): `traced_require` is
// declared as a local function, then assigned to the global `require`
// builtin so every later `require(...)` call site actually invokes it.
//
// `aliasedToCustomGlobal` and `trulyDeadFn` are negative controls: assigning
// a function to a global that is NOT a recognized Lua builtin/stdlib-module
// name must NOT rescue it (scope-discipline check — this fix targets the
// reported builtin-reassignment pattern specifically, not general aliasing).
const FIXTURE = {
  'main.lua': `
local orig_require = require
local function traced_require(modname)
    local mod = orig_require(modname)
    return mod
end
require = traced_require

local function aliasedToCustomGlobal()
    return 42
end
myCustomGlobal = aliasedToCustomGlobal

local function trulyDeadFn()
    return 99
end

local function entryPoint()
    local m = require("some.module")
    return m
end
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

// Mirrors the #1771 integration test's rationale: a call site that DOES
// resolve (as value-ref calls into a real function target always do here)
// is persisted as a plain `dynamic=1` `calls` edge — `dynamic_kind` is only
// persisted on unresolved sink edges. So a resolved value-ref edge is
// identified by `dynamic = 1`, not by the `dynamic_kind` column.
function readDynamicCallEdges(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT s.name AS src, t.name AS tgt
         FROM edges e
         JOIN nodes s ON e.source_id = s.id
         JOIN nodes t ON e.target_id = t.id
         WHERE e.kind = 'calls' AND e.dynamic = 1
         ORDER BY s.name, t.name`,
      )
      .all() as Array<{ src: string; tgt: string }>;
  } finally {
    db.close();
  }
}

describe('Lua builtin-reassignment value-ref edges (#1776) — WASM', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1776-'));
    for (const [rel, content] of Object.entries(FIXTURE)) {
      fs.writeFileSync(path.join(tmpDir, rel), content);
    }
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits a value-ref calls edge from the enclosing scope to the reassigned function', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readDynamicCallEdges(dbPath);
    expect(
      edges.some((e) => e.tgt === 'traced_require'),
      `Expected a value-ref edge into traced_require; got: ${JSON.stringify(edges)}`,
    ).toBe(true);
  });

  it('gives the reassigned function at least one inbound calls edge (fan-in >= 1)', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    expect(countCallEdgesTo(dbPath, 'traced_require')).toBeGreaterThan(0);
  });

  it('does not classify the reassigned function as dead', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const nodes = readNodesWithRoles(dbPath);
    const node = nodes.find((n) => n.name === 'traced_require' && n.kind === 'function');
    expect(node, 'traced_require node not found').toBeDefined();
    expect(
      node!.role,
      `traced_require was classified as ${node!.role} — expected a non-dead role now that a real edge exists`,
    ).not.toBe(undefined);
    expect(DEAD_ROLES.has(node!.role ?? '')).toBe(false);
  });

  it('does not rescue a function aliased to a non-builtin global (scope-discipline control)', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readDynamicCallEdges(dbPath);
    expect(edges.some((e) => e.tgt === 'aliasedToCustomGlobal')).toBe(false);
    const nodes = readNodesWithRoles(dbPath);
    const node = nodes.find((n) => n.name === 'aliasedToCustomGlobal' && n.kind === 'function');
    expect(node, 'aliasedToCustomGlobal node not found').toBeDefined();
    expect(DEAD_ROLES.has(node!.role ?? '')).toBe(true);
  });

  it('leaves an unrelated, genuinely unreferenced function classified dead (baseline control)', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const nodes = readNodesWithRoles(dbPath);
    const node = nodes.find((n) => n.name === 'trulyDeadFn' && n.kind === 'function');
    expect(node, 'trulyDeadFn node not found').toBeDefined();
    expect(DEAD_ROLES.has(node!.role ?? '')).toBe(true);
  });
});

// ── Native engine parity ────────────────────────────────────────────────────
// Skipped when the native addon is not installed.

describe.skipIf(!isNativeAvailable())(
  'Lua builtin-reassignment value-ref edges (#1776) — native',
  () => {
    let nativeTmpDir: string;

    beforeAll(async () => {
      nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1776-native-'));
      for (const [rel, content] of Object.entries(FIXTURE)) {
        fs.writeFileSync(path.join(nativeTmpDir, rel), content);
      }
      await buildGraph(nativeTmpDir, { engine: 'native', incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(nativeTmpDir, { recursive: true, force: true });
    });

    it('emits a value-ref calls edge from the enclosing scope to the reassigned function', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const edges = readDynamicCallEdges(dbPath);
      expect(
        edges.some((e) => e.tgt === 'traced_require'),
        `Expected a native value-ref edge into traced_require; got: ${JSON.stringify(edges)}`,
      ).toBe(true);
    });

    it('does not classify the reassigned function as dead', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const nodes = readNodesWithRoles(dbPath);
      const node = nodes.find((n) => n.name === 'traced_require' && n.kind === 'function');
      expect(node, 'traced_require node not found (native)').toBeDefined();
      expect(DEAD_ROLES.has(node!.role ?? '')).toBe(false);
    });

    it('does not rescue a function aliased to a non-builtin global (scope-discipline control)', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const nodes = readNodesWithRoles(dbPath);
      const node = nodes.find((n) => n.name === 'aliasedToCustomGlobal' && n.kind === 'function');
      expect(node, 'aliasedToCustomGlobal node not found (native)').toBeDefined();
      expect(DEAD_ROLES.has(node!.role ?? '')).toBe(true);
    });
  },
);
