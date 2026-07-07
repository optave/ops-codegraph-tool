/**
 * Integration test for #1824: `const { a: b } = await import(...)` recorded
 * the wrong binding name, dropping the call edge for `b(...)`.
 *
 * Root cause: `extractDynamicImportNames` (TS) / `extract_dynamic_import_names`
 * (Rust) preferred the tree-sitter `pair_pattern`'s `key` field (the name
 * exported by the target module) over `value` (the local binding actually
 * referenced by call sites) — the same class of bug fixed for static
 * `import { X as Y }` specifiers in #1730. Since `names` held the original
 * exported name (`a`) instead of the local alias (`b`), `importedNames` never
 * gained an entry for `b`, so a call to `b(...)` never resolved to the
 * imported symbol.
 *
 * Fix: `names` now carries the local alias, with the local -> original
 * mapping recorded in `Import.renamedImports` so call-edge resolution can
 * still find the target module's real export — mirroring #1730's
 * `renamedImports` mechanism for static imports.
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

const TARGET_FILE = 'features/math.ts';

const FIXTURE = {
  [TARGET_FILE]: `
export function add(a: number, b: number): number {
  return a + b;
}
`,
  'domain/stages/consumer.ts': `
export async function usesRenamedImport() {
  const { add: sum } = await import('../../features/math.js');
  return sum(1, 2);
}
`,
};

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

function writeFixture(rootDir: string) {
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const abs = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

describe('dynamic import() destructuring rename (#1824) — WASM', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1824-wasm-'));
    writeFixture(tmpDir);
    await buildGraph(tmpDir, { engine: 'wasm', incremental: false, skipRegistry: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a calls edge through the local alias, not the original name', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const edges = getCallEdges(dbPath);
    const edge = edges.find((e) => e.src === 'usesRenamedImport' && e.tgt === 'add');
    expect(edge, `Expected usesRenamedImport -> add; got: ${JSON.stringify(edges)}`).toBeDefined();
    expect(edge?.tgt_file).toBe(TARGET_FILE);
  });

  it('codegraph exports credits the dynamically-imported, renamed export with a real consumer', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const data = exportsData(TARGET_FILE, dbPath);
    const addExport = data.results.find((r: { name: string }) => r.name === 'add');
    expect(addExport).toBeDefined();
    expect(addExport.consumerCount).toBeGreaterThanOrEqual(1);
    expect(addExport.consumers.map((c: { name: string }) => c.name)).toContain('usesRenamedImport');
  });

  it('does not classify the dynamically-imported export as dead', () => {
    const dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
    const nodes = readNodesWithRoles(dbPath);
    const node = nodes.find((n) => n.name === 'add' && n.kind === 'function');
    expect(node, 'add node not found').toBeDefined();
    expect(
      DEAD_ROLES.has(node!.role ?? ''),
      `add was classified as ${node!.role} — expected a non-dead role now that a real edge exists`,
    ).toBe(false);
  });
});

// ── Native engine parity ────────────────────────────────────────────────────
// Skipped when the native addon is not installed.

describe.skipIf(!isNativeAvailable())(
  'dynamic import() destructuring rename (#1824) — native',
  () => {
    let nativeTmpDir: string;

    beforeAll(async () => {
      nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1824-native-'));
      writeFixture(nativeTmpDir);
      await buildGraph(nativeTmpDir, { engine: 'native', incremental: false, skipRegistry: true });
    }, 60_000);

    afterAll(() => {
      fs.rmSync(nativeTmpDir, { recursive: true, force: true });
    });

    it('creates a calls edge through the local alias, not the original name', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const edges = getCallEdges(dbPath);
      const edge = edges.find((e) => e.src === 'usesRenamedImport' && e.tgt === 'add');
      expect(
        edge,
        `Expected native usesRenamedImport -> add; got: ${JSON.stringify(edges)}`,
      ).toBeDefined();
      expect(edge?.tgt_file).toBe(TARGET_FILE);
    });

    it('codegraph exports credits the dynamically-imported, renamed export with a real consumer', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const data = exportsData(TARGET_FILE, dbPath);
      const addExport = data.results.find((r: { name: string }) => r.name === 'add');
      expect(addExport).toBeDefined();
      expect(addExport.consumerCount).toBeGreaterThanOrEqual(1);
    });

    it('does not classify the dynamically-imported export as dead', () => {
      const dbPath = path.join(nativeTmpDir, '.codegraph', 'graph.db');
      const nodes = readNodesWithRoles(dbPath);
      const node = nodes.find((n) => n.name === 'add' && n.kind === 'function');
      expect(node, 'add node not found (native)').toBeDefined();
      expect(DEAD_ROLES.has(node!.role ?? '')).toBe(false);
    });
  },
);
