/**
 * Integration test for #1771: dispatch-table function references
 * (`{ matches, resolve }`-style handler arrays) inconsistently flagged
 * dead-unresolved depending on an unrelated, incidental property of the
 * referenced function (whether it happens to call another tracked symbol
 * internally, giving it fanOut > 0).
 *
 * Root cause: codegraph created no edge at all for a bare function
 * identifier used as an object-literal property VALUE (e.g.
 * `{ resolve: someFunction }`) — only a `fanOut > 0` heuristic in the role
 * classifier incidentally rescued whichever handlers happened to call
 * another tracked symbol internally.
 *
 * Fix: both engines now emit a real `calls` edge (dynamic=1,
 * dynamicKind/dynamic_kind = 'value-ref') from the enclosing scope to the
 * referenced function/method, so fan-in reflects the reference directly and
 * role classification no longer depends on the referenced function's own
 * unrelated fanOut.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

// Mirrors this repo's own src/ast-analysis/visitor-utils.ts PARAM_NODE_HANDLERS
// dispatch table: an array of `{ matches, resolve }` objects where `resolve`
// is a bare function identifier dispatched at runtime via `handler.resolve(...)`.
// `resolveB` deliberately calls another tracked function (`helper`) so it has
// fanOut > 0 — the exact "coincidental rescue" condition from the bug report —
// while `resolveA`/`resolveC` do not, so they exercise the actually-fixed path.
const FIXTURE = {
  'dispatch.js': `
function isA(node) { return node.type === 'a'; }
function resolveA(node) { return { kind: 'a', value: node }; }
function isB(node) { return node.type === 'b'; }
function resolveB(node) { return helper(node); }
function isC(node) { return node.type === 'c'; }
function resolveC(node) { return { kind: 'c', value: node }; }
function helper(node) { return node; }

const HANDLERS = [
  { matches: isA, resolve: resolveA },
  { matches: isB, resolve: resolveB },
  { matches: isC, resolve: resolveC },
];

function dispatch(node) {
  for (const h of HANDLERS) {
    if (h.matches(node)) return h.resolve(node);
  }
  return null;
}

module.exports = { dispatch };
`,
  'data.js': `
const SOME_CONSTANT = 'hello';
const dataConfig = { name: SOME_CONSTANT, label: 'literal', count: 42 };
module.exports = { dataConfig };
`,
};

const HANDLER_NAMES = ['isA', 'resolveA', 'isB', 'resolveB', 'isC', 'resolveC'];
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

// `dynamic_kind` is only persisted on UNRESOLVED sink edges (confidence=0,
// the flag-only fallback for eval/computed-key/reflection/unresolved-dynamic
// call sites that never found a target) — by existing, consistent design
// across every dynamicKind category, a call site that DOES resolve (as
// value-ref calls into a real function/method target always do here) is
// persisted as a plain `dynamic=1` `calls` edge with `dynamic_kind = NULL`.
// So a resolved value-ref edge is identified by `dynamic = 1`, not by the
// `dynamic_kind` column (see resolveFallbackTargets / emitDirectCallEdgesForCall).
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

describe('dispatch-table value-ref edges (#1771) — WASM', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1771-'));
    for (const [rel, content] of Object.entries(FIXTURE)) {
      fs.writeFileSync(path.join(tmpDir, rel), content);
    }
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits a value-ref calls edge from the dispatch table to every handler', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readDynamicCallEdges(dbPath);
    for (const name of HANDLER_NAMES) {
      expect(
        edges.some((e) => e.src === 'HANDLERS' && e.tgt === name),
        `Expected a value-ref edge HANDLERS -> ${name}; got: ${JSON.stringify(edges)}`,
      ).toBe(true);
    }
  });

  it('gives every handler at least one inbound calls edge (fan-in >= 1)', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    for (const name of HANDLER_NAMES) {
      expect(countCallEdgesTo(dbPath, name), `${name} has no inbound calls edge`).toBeGreaterThan(
        0,
      );
    }
  });

  it('does not classify any dispatch-table handler as dead, regardless of its own fanOut', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const nodes = readNodesWithRoles(dbPath);
    for (const name of HANDLER_NAMES) {
      const node = nodes.find((n) => n.name === name && n.kind === 'function');
      expect(node, `${name} node not found`).toBeDefined();
      expect(
        node!.role,
        `${name} was classified as ${node!.role} — expected a non-dead role now that a real edge exists`,
      ).not.toBe(undefined);
      expect(DEAD_ROLES.has(node!.role ?? '')).toBe(false);
    }
  });

  it('does not fabricate a value-ref edge to a plain data constant', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = readDynamicCallEdges(dbPath);
    expect(edges.some((e) => e.tgt === 'SOME_CONSTANT')).toBe(false);
    expect(countCallEdgesTo(dbPath, 'SOME_CONSTANT')).toBe(0);
  });
});

// ── Native engine parity ────────────────────────────────────────────────────
// Skipped when the native addon is not installed.

describe.skipIf(!isNativeAvailable())('dispatch-table value-ref edges (#1771) — native', () => {
  let nativeTmpDir: string;

  beforeAll(async () => {
    nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1771-native-'));
    for (const [rel, content] of Object.entries(FIXTURE)) {
      fs.writeFileSync(path.join(nativeTmpDir, rel), content);
    }
    await buildGraph(nativeTmpDir, { engine: 'native', incremental: false, skipRegistry: true });
  }, 60_000);

  afterAll(() => {
    fs.rmSync(nativeTmpDir, { recursive: true, force: true });
  });

  it('emits a value-ref calls edge from the dispatch table to every handler', () => {
    const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
    const edges = readDynamicCallEdges(dbPath);
    for (const name of HANDLER_NAMES) {
      expect(
        edges.some((e) => e.src === 'HANDLERS' && e.tgt === name),
        `Expected a native value-ref edge HANDLERS -> ${name}; got: ${JSON.stringify(edges)}`,
      ).toBe(true);
    }
  });

  it('does not classify any dispatch-table handler as dead', () => {
    const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
    const nodes = readNodesWithRoles(dbPath);
    for (const name of HANDLER_NAMES) {
      const node = nodes.find((n) => n.name === name && n.kind === 'function');
      expect(node, `${name} node not found (native)`).toBeDefined();
      expect(DEAD_ROLES.has(node!.role ?? '')).toBe(false);
    }
  });

  it('does not fabricate a value-ref edge to a plain data constant', () => {
    const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
    const edges = readDynamicCallEdges(dbPath);
    expect(edges.some((e) => e.tgt === 'SOME_CONSTANT')).toBe(false);
    expect(countCallEdgesTo(dbPath, 'SOME_CONSTANT')).toBe(0);
  });
});
