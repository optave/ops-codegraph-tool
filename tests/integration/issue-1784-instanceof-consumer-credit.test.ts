/**
 * Integration test for #1784: `codegraph exports` did not credit `instanceof
 * ClassName` checks (or other bare-reference, no-call-site usages) as
 * consumers — a base/parent class whose primary cross-file use is
 * `instanceof` narrowing falsely presented as dead/unused.
 *
 * Repro (this repo's own source): `src/shared/errors.ts`'s `CodegraphError`
 * showed `consumerCount: 0` via `codegraph exports src/shared/errors.ts
 * --json` despite two real production usages (`src/cli.ts`,
 * `src/mcp/server.ts`) that only ever reference it via
 * `err instanceof CodegraphError` — never `new CodegraphError(...)`.
 *
 * Root cause: no edge at all was created for the right-hand operand of an
 * `instanceof` binary expression — the same "no edge for a bare-identifier
 * value reference" gap as #1771 (object-literal property values) and #1776
 * (Lua builtin reassignment), just at a different syntactic position.
 *
 * Fix: both engines now emit a dynamic `calls` edge (dynamicKind/dynamic_kind
 * = 'value-ref', reusing the #1771/#1776 taxonomy entry per ADR-002) from the
 * enclosing scope to the referenced symbol when `instanceof`'s right operand
 * is a bare identifier. Unlike the function/method-only #1771/#1776 sites,
 * the resolver-side kind filter for `instanceof` additionally accepts
 * `class`-kind targets (and still accepts `function`-kind, covering the
 * pre-ES6 "constructor function" `instanceof` idiom) since `instanceof`'s
 * operand is never a plain data reference in valid JS.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { exportsData } from '../../src/domain/queries.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const DEAD_ROLES = new Set(['dead-unresolved', 'dead-leaf', 'dead-entry', 'dead-ffi']);

const TARGET_FILE = 'shared/errors.ts';

// `BaseError` mirrors this repo's own `CodegraphError`: a class consumed
// ONLY via `instanceof`, never `new`'d, in another file. `LegacyCtor`
// exercises the pre-ES6 "constructor function" `instanceof` idiom
// (`x instanceof SomeFunction` is valid JS, checking the prototype chain) —
// the resolver-side kind filter must keep accepting function-kind targets,
// not just add class. `ERROR_LABEL` is a plain data constant used as
// `instanceof`'s right operand (invalid at runtime, but syntactically legal)
// to prove the resolver does not fabricate an edge to a non-callable target,
// mirroring #1771's "does not fabricate a value-ref edge to a plain data
// constant" guard.
const FIXTURE = {
  [TARGET_FILE]: `
export class BaseError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export function LegacyCtor(this: { legacy: boolean }) {
  this.legacy = true;
}

export const ERROR_LABEL = 'base-error';
`,
  'cli/handler.ts': `
import { BaseError, ERROR_LABEL, LegacyCtor } from '../shared/errors.js';

export function handle(err: unknown): string {
  if (err instanceof BaseError) {
    return err.code;
  }
  return String(err);
}

export function isLegacy(x: unknown): boolean {
  return x instanceof LegacyCtor;
}

export function describe(err: unknown): string {
  return err instanceof ERROR_LABEL ? 'label' : 'other';
}
`,
};

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

function getCallEdges(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n2.name AS tgt, n2.kind AS tgt_kind
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
      )
      .all() as Array<{ src: string; tgt: string; tgt_kind: string }>;
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

function writeFixture(rootDir: string) {
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const abs = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

describe('instanceof ClassName consumer crediting (#1784) — WASM', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1784-wasm-'));
    writeFixture(tmpDir);
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a calls edge from the instanceof check to the class', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = getCallEdges(dbPath);
    expect(
      edges.some((e) => e.src === 'handle' && e.tgt === 'BaseError' && e.tgt_kind === 'class'),
      `Expected handle -> BaseError (class); got: ${JSON.stringify(edges)}`,
    ).toBe(true);
  });

  it('creates a calls edge from instanceof against a plain constructor function', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = getCallEdges(dbPath);
    expect(
      edges.some(
        (e) => e.src === 'isLegacy' && e.tgt === 'LegacyCtor' && e.tgt_kind === 'function',
      ),
      `Expected isLegacy -> LegacyCtor (function); got: ${JSON.stringify(edges)}`,
    ).toBe(true);
  });

  it('does not fabricate an edge from instanceof against a plain data constant', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = getCallEdges(dbPath);
    expect(edges.some((e) => e.tgt === 'ERROR_LABEL')).toBe(false);
    expect(countCallEdgesTo(dbPath, 'ERROR_LABEL')).toBe(0);
  });

  it('codegraph exports credits BaseError with a consumer from handle', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const data = exportsData(TARGET_FILE, dbPath);

    const baseError = data.results.find((r: { name: string }) => r.name === 'BaseError');
    expect(baseError).toBeDefined();
    expect(baseError.consumerCount).toBeGreaterThanOrEqual(1);
    expect(baseError.consumers.map((c: { name: string }) => c.name)).toContain('handle');
  });

  it('does not classify BaseError or LegacyCtor as dead', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const nodes = readNodesWithRoles(dbPath);
    for (const [name, kind] of [
      ['BaseError', 'class'],
      ['LegacyCtor', 'function'],
    ] as const) {
      const node = nodes.find((n) => n.name === name && n.kind === kind);
      expect(node, `${name} node not found`).toBeDefined();
      expect(
        DEAD_ROLES.has(node!.role ?? ''),
        `${name} was classified as ${node!.role} — expected a non-dead role now that a real edge exists`,
      ).toBe(false);
    }
  });
});

// ── Native engine parity ────────────────────────────────────────────────────
// Skipped when the native addon is not installed.

describe.skipIf(!isNativeAvailable())(
  'instanceof ClassName consumer crediting (#1784) — native',
  () => {
    let nativeTmpDir: string;

    beforeAll(async () => {
      nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1784-native-'));
      writeFixture(nativeTmpDir);
      await buildGraph(nativeTmpDir, { engine: 'native', incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(nativeTmpDir, { recursive: true, force: true });
    });

    it('creates a calls edge from the instanceof check to the class', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const edges = getCallEdges(dbPath);
      expect(
        edges.some((e) => e.src === 'handle' && e.tgt === 'BaseError' && e.tgt_kind === 'class'),
        `Expected native handle -> BaseError (class); got: ${JSON.stringify(edges)}`,
      ).toBe(true);
    });

    it('creates a calls edge from instanceof against a plain constructor function', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const edges = getCallEdges(dbPath);
      expect(
        edges.some(
          (e) => e.src === 'isLegacy' && e.tgt === 'LegacyCtor' && e.tgt_kind === 'function',
        ),
        `Expected native isLegacy -> LegacyCtor (function); got: ${JSON.stringify(edges)}`,
      ).toBe(true);
    });

    it('does not fabricate an edge from instanceof against a plain data constant', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const edges = getCallEdges(dbPath);
      expect(edges.some((e) => e.tgt === 'ERROR_LABEL')).toBe(false);
      expect(countCallEdgesTo(dbPath, 'ERROR_LABEL')).toBe(0);
    });

    it('codegraph exports credits BaseError with a consumer from handle', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const data = exportsData(TARGET_FILE, dbPath);

      const baseError = data.results.find((r: { name: string }) => r.name === 'BaseError');
      expect(baseError).toBeDefined();
      expect(baseError.consumerCount).toBeGreaterThanOrEqual(1);
      expect(baseError.consumers.map((c: { name: string }) => c.name)).toContain('handle');
    });

    it('does not classify BaseError or LegacyCtor as dead', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const nodes = readNodesWithRoles(dbPath);
      for (const [name, kind] of [
        ['BaseError', 'class'],
        ['LegacyCtor', 'function'],
      ] as const) {
        const node = nodes.find((n) => n.name === name && n.kind === kind);
        expect(node, `${name} node not found (native)`).toBeDefined();
        expect(DEAD_ROLES.has(node!.role ?? '')).toBe(false);
      }
    });
  },
);
