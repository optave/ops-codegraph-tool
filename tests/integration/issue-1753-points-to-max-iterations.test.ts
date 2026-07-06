/**
 * Regression test for issue #1753 — `pointsToMaxIterations` config threading.
 *
 * `MAX_SOLVER_ITERATIONS` in the Phase 8.3 points-to solver used to be a
 * hardcoded constant (50) in both `src/domain/graph/resolver/points-to.ts`
 * (WASM) and `crates/codegraph-core/.../build_edges.rs` (native), duplicating
 * — but never reading from — `DEFAULTS.analysis.pointsToMaxIterations` in
 * `src/infrastructure/config.ts`.
 *
 * This suite builds an 8-hop function-alias chain
 * (`a0=a1, a1=a2, ..., a6=a7, a7=handler`) that the fixed-point solver needs
 * exactly 8 iterations to fully resolve (see the equivalent unit tests in
 * `tests/unit/points-to.test.ts` and the Rust `max_iterations_caps_alias_chain_convergence`
 * test for the derivation). A `.codegraphrc.json` setting
 * `analysis.pointsToMaxIterations` below that depth must suppress the
 * resulting call edge on BOTH engines; the default (50) must resolve it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { isNativeAvailable } from '../../src/infrastructure/native.js';

const hasNative = isNativeAvailable();
const requireParity = !!process.env.CODEGRAPH_PARITY;
const itNativeOrSkip = requireParity || hasNative ? it : it.skip;

// 8-hop alias chain: a0 requires exactly 8 fixed-point iterations to resolve
// to `handler` (one hop propagates per solver iteration — see file header).
const CHAIN_LENGTH = 8;

const HANDLER_JS = `
export function handler(item) {
  return item * 2;
}
`.trimStart();

function buildConsumerSource(): string {
  const lines = [
    "import { handler } from './handler.js';",
    '',
    'export function processItems(items) {',
  ];
  for (let i = 0; i < CHAIN_LENGTH - 1; i++) {
    lines.push(`  const a${i} = a${i + 1};`);
  }
  lines.push(`  const a${CHAIN_LENGTH - 1} = handler;`);
  lines.push('  return items.map(a0);');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

const CONSUMER_JS = buildConsumerSource();

const dirsToClean: string[] = [];

function writeFixture(dir: string, maxIterations?: number): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'handler.js'), HANDLER_JS);
  fs.writeFileSync(path.join(dir, 'consumer.js'), CONSUMER_JS);
  if (maxIterations !== undefined) {
    fs.writeFileSync(
      path.join(dir, '.codegraphrc.json'),
      JSON.stringify({ analysis: { pointsToMaxIterations: maxIterations } }),
    );
  }
}

function readCallEdges(dbPath: string): Array<{ source: string; target: string }> {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(`
      SELECT n1.name AS source, n2.name AS target
      FROM edges e
      JOIN nodes n1 ON e.source_id = n1.id
      JOIN nodes n2 ON e.target_id = n2.id
      WHERE e.kind = 'calls'
      ORDER BY n1.name, n2.name
    `)
    .all() as Array<{ source: string; target: string }>;
  db.close();
  return rows;
}

function hasProcessItemsToHandlerEdge(dbPath: string): boolean {
  return readCallEdges(dbPath).some((e) => e.source === 'processItems' && e.target === 'handler');
}

afterAll(() => {
  for (const dir of dirsToClean) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function buildFixture(engine: 'wasm' | 'native', maxIterations?: number): Promise<string> {
  const label = maxIterations === undefined ? 'default' : `cap${maxIterations}`;
  const tmpBase = fs.mkdtempSync(
    path.join(os.tmpdir(), `codegraph-pts-max-iter-${engine}-${label}-`),
  );
  dirsToClean.push(tmpBase);
  writeFixture(tmpBase, maxIterations);
  await buildGraph(tmpBase, { engine, incremental: false, skipRegistry: true });
  return tmpBase;
}

describe('Phase 8.3 pts: pointsToMaxIterations config threading (WASM)', () => {
  it('resolves the 8-hop alias chain with the default cap (50)', async () => {
    const dir = await buildFixture('wasm');
    expect(hasProcessItemsToHandlerEdge(path.join(dir, '.codegraph', 'graph.db'))).toBe(true);
  }, 60_000);

  it('suppresses the alias-chain edge when .codegraphrc.json caps below the required depth', async () => {
    const dir = await buildFixture('wasm', 3);
    expect(hasProcessItemsToHandlerEdge(path.join(dir, '.codegraph', 'graph.db'))).toBe(false);
  }, 60_000);

  it('resolves the alias-chain edge when .codegraphrc.json raises the cap to meet the required depth', async () => {
    const dir = await buildFixture('wasm', CHAIN_LENGTH);
    expect(hasProcessItemsToHandlerEdge(path.join(dir, '.codegraph', 'graph.db'))).toBe(true);
  }, 60_000);
});

describe('Phase 8.3 pts: pointsToMaxIterations config threading (native)', () => {
  itNativeOrSkip(
    'resolves the 8-hop alias chain with the default cap (50)',
    async () => {
      const dir = await buildFixture('native');
      expect(hasProcessItemsToHandlerEdge(path.join(dir, '.codegraph', 'graph.db'))).toBe(true);
    },
    60_000,
  );

  itNativeOrSkip(
    'suppresses the alias-chain edge when .codegraphrc.json caps below the required depth',
    async () => {
      const dir = await buildFixture('native', 3);
      expect(hasProcessItemsToHandlerEdge(path.join(dir, '.codegraph', 'graph.db'))).toBe(false);
    },
    60_000,
  );
});

describe('Phase 8.3 pts: pointsToMaxIterations — engine parity', () => {
  itNativeOrSkip(
    'both engines agree the chain resolves under the default cap',
    async () => {
      const wasmDir = await buildFixture('wasm');
      const nativeDir = await buildFixture('native');
      const wasmEdges = readCallEdges(path.join(wasmDir, '.codegraph', 'graph.db'));
      const nativeEdges = readCallEdges(path.join(nativeDir, '.codegraph', 'graph.db'));
      expect(nativeEdges).toEqual(wasmEdges);
      expect(hasProcessItemsToHandlerEdge(path.join(wasmDir, '.codegraph', 'graph.db'))).toBe(true);
    },
    60_000,
  );

  itNativeOrSkip(
    'both engines agree the chain is suppressed under a below-depth override',
    async () => {
      const wasmDir = await buildFixture('wasm', 3);
      const nativeDir = await buildFixture('native', 3);
      const wasmEdges = readCallEdges(path.join(wasmDir, '.codegraph', 'graph.db'));
      const nativeEdges = readCallEdges(path.join(nativeDir, '.codegraph', 'graph.db'));
      expect(nativeEdges).toEqual(wasmEdges);
      expect(hasProcessItemsToHandlerEdge(path.join(wasmDir, '.codegraph', 'graph.db'))).toBe(
        false,
      );
    },
    60_000,
  );
});
