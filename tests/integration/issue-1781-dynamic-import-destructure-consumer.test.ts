/**
 * Integration test for #1781: `codegraph exports` did not credit consumers
 * reached via a dynamic `import()` expression whose destructured result is
 * wrapped in redundant parentheses and/or a TypeScript `as {...}` type
 * assertion — the exact shape used throughout
 * `src/domain/graph/builder/stages/native-orchestrator.ts`:
 *
 *   const { buildDataflowVerticesFromMap, ... } =
 *     (await import('../../../../features/dataflow.js')) as {...};
 *
 * Root cause: `extractDynamicImportNames` (TS) / `extract_dynamic_import_names`
 * (Rust) walked up from the `import()` call through at most one optional
 * `await_expression` before requiring the immediate parent to be a
 * `variable_declarator`. The extra `parenthesized_expression` and/or
 * `as_expression` wrapper layers introduced by parens and a type assertion
 * broke that walk-up, so no destructured names were ever extracted — the
 * import was recorded with `names: []`, `importedNames` never gained an
 * entry for the destructured bindings, and the later call through the
 * destructured local name never resolved to a `calls` edge. Both `codegraph
 * exports` (consumer count) and `codegraph roles --role dead` therefore
 * treated a genuinely-consumed export as unreferenced.
 *
 * Fix: the walk-up now skips any nesting/combination of `await_expression`,
 * `parenthesized_expression`, and `as_expression` wrappers before checking
 * for the enclosing `variable_declarator`, in both engines.
 *
 * Two consumer shapes are exercised against the same target module:
 *   - `usesPlain`: bare `const { X } = await import(...)` (no cast) — the
 *     pre-existing baseline that must keep working.
 *   - `usesCast`: `const { Y } = (await import(...)) as {...}` — the exact
 *     regression shape from native-orchestrator.ts.
 *
 * The target module and its consumer are deliberately placed in *different*
 * directories (`features/` vs `domain/stages/`, mirroring the real repo
 * layout) rather than side by side. A same-directory fixture does not
 * discriminate this bug at all: the resolver's directory-scoped fallback
 * tier (a same-directory, name-only match — one of several confidence tiers
 * below the import-aware match) coincidentally "rescues" the call even when
 * `extractDynamicImportNames` returns no names, producing a `calls` edge
 * regardless of whether the fix is present. Cross-directory placement is
 * required so the only way to resolve `usesCast`'s call is through the
 * import-aware path this bug actually breaks.
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

const TARGET_FILE = 'features/dataflow.ts';

const FIXTURE = {
  [TARGET_FILE]: `
export function buildDataflowVerticesFromMap(): number {
  return 42;
}

export function buildDataflowP4ForNative(): number {
  return 7;
}
`,
  'domain/stages/consumer.ts': `
export async function usesPlain() {
  const { buildDataflowVerticesFromMap } = await import('../../features/dataflow.js');
  return buildDataflowVerticesFromMap();
}

export async function usesCast() {
  const { buildDataflowP4ForNative } = (await import('../../features/dataflow.js')) as {
    buildDataflowP4ForNative: () => number;
  };
  return buildDataflowP4ForNative();
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
        `SELECT n1.name AS src, n2.name AS tgt, n2.file AS tgt_file
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
      )
      .all() as Array<{ src: string; tgt: string; tgt_file: string }>;
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

describe('dynamic import() + destructure consumer crediting (#1781) — WASM', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1781-wasm-'));
    writeFixture(tmpDir);
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  }, 60_000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a calls edge for the bare (uncast) destructured binding', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = getCallEdges(dbPath);
    const edge = edges.find(
      (e) => e.src === 'usesPlain' && e.tgt === 'buildDataflowVerticesFromMap',
    );
    expect(
      edge,
      `Expected usesPlain -> buildDataflowVerticesFromMap; got: ${JSON.stringify(edges)}`,
    ).toBeDefined();
    expect(edge?.tgt_file).toBe(TARGET_FILE);
  });

  it('creates a calls edge for the parenthesized + `as`-cast destructured binding', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = getCallEdges(dbPath);
    const edge = edges.find((e) => e.src === 'usesCast' && e.tgt === 'buildDataflowP4ForNative');
    expect(
      edge,
      `Expected usesCast -> buildDataflowP4ForNative; got: ${JSON.stringify(edges)}`,
    ).toBeDefined();
    expect(edge?.tgt_file).toBe(TARGET_FILE);
  });

  it('codegraph exports credits both dynamically-imported functions with real consumers', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const data = exportsData(TARGET_FILE, dbPath);

    const vertices = data.results.find(
      (r: { name: string }) => r.name === 'buildDataflowVerticesFromMap',
    );
    expect(vertices).toBeDefined();
    expect(vertices.consumerCount).toBeGreaterThanOrEqual(1);
    expect(vertices.consumers.map((c: { name: string }) => c.name)).toContain('usesPlain');

    const p4 = data.results.find((r: { name: string }) => r.name === 'buildDataflowP4ForNative');
    expect(p4).toBeDefined();
    expect(p4.consumerCount).toBeGreaterThanOrEqual(1);
    expect(p4.consumers.map((c: { name: string }) => c.name)).toContain('usesCast');
  });

  it('does not classify either dynamically-imported export as dead', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const nodes = readNodesWithRoles(dbPath);
    for (const name of ['buildDataflowVerticesFromMap', 'buildDataflowP4ForNative']) {
      const node = nodes.find((n) => n.name === name && n.kind === 'function');
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
  'dynamic import() + destructure consumer crediting (#1781) — native',
  () => {
    let nativeTmpDir: string;

    beforeAll(async () => {
      nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1781-native-'));
      writeFixture(nativeTmpDir);
      await buildGraph(nativeTmpDir, { engine: 'native', incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(nativeTmpDir, { recursive: true, force: true });
    });

    it('creates a calls edge for the bare (uncast) destructured binding', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const edges = getCallEdges(dbPath);
      const edge = edges.find(
        (e) => e.src === 'usesPlain' && e.tgt === 'buildDataflowVerticesFromMap',
      );
      expect(
        edge,
        `Expected native usesPlain -> buildDataflowVerticesFromMap; got: ${JSON.stringify(edges)}`,
      ).toBeDefined();
      expect(edge?.tgt_file).toBe(TARGET_FILE);
    });

    it('creates a calls edge for the parenthesized + `as`-cast destructured binding', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const edges = getCallEdges(dbPath);
      const edge = edges.find((e) => e.src === 'usesCast' && e.tgt === 'buildDataflowP4ForNative');
      expect(
        edge,
        `Expected native usesCast -> buildDataflowP4ForNative; got: ${JSON.stringify(edges)}`,
      ).toBeDefined();
      expect(edge?.tgt_file).toBe(TARGET_FILE);
    });

    it('codegraph exports credits both dynamically-imported functions with real consumers', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const data = exportsData(TARGET_FILE, dbPath);

      const vertices = data.results.find(
        (r: { name: string }) => r.name === 'buildDataflowVerticesFromMap',
      );
      expect(vertices).toBeDefined();
      expect(vertices.consumerCount).toBeGreaterThanOrEqual(1);

      const p4 = data.results.find((r: { name: string }) => r.name === 'buildDataflowP4ForNative');
      expect(p4).toBeDefined();
      expect(p4.consumerCount).toBeGreaterThanOrEqual(1);
    });

    it('does not classify either dynamically-imported export as dead', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const nodes = readNodesWithRoles(dbPath);
      for (const name of ['buildDataflowVerticesFromMap', 'buildDataflowP4ForNative']) {
        const node = nodes.find((n) => n.name === name && n.kind === 'function');
        expect(node, `${name} node not found (native)`).toBeDefined();
        expect(DEAD_ROLES.has(node!.role ?? '')).toBe(false);
      }
    });
  },
);
