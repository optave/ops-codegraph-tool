/**
 * Regression test for #1730: consumer resolution must follow a call site
 * through a renamed import specifier (`import { X as Y } from '...'`) back
 * to the original exported symbol.
 *
 * Setup: two files.
 *   - helpers.js: `export function collectFiles() {...}`
 *   - consumer.js: `import { collectFiles as collectFilesUtil } from './helpers.js';`
 *                  calls `collectFilesUtil()` from an exported function.
 *
 * Before the fix, the extractor recorded the *original* exported name
 * (`collectFiles`) instead of the local alias actually used at the call site
 * (`collectFilesUtil`) — so `importedNames` never had a key matching the call
 * site text, and no `calls` edge was ever created. `codegraph exports
 * helpers.js` reported zero consumers for a genuinely-used export.
 *
 * Verified on both engines — this is resolver/extractor logic mirrored in
 * `crates/codegraph-core/`, so WASM and native must agree (#1730 root cause
 * was duplicated in both).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { exportsData } from '../../src/domain/queries.js';

const FILE_HELPERS = `
export function collectFiles() {
  return ['a.js', 'b.js'];
}
`;

const FILE_CONSUMER = `
import { collectFiles as collectFilesUtil } from './helpers.js';

export function useIt() {
  return collectFilesUtil();
}
`;

let tmpWasm: string;
let tmpNative: string;

beforeAll(async () => {
  tmpWasm = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1730-wasm-'));
  fs.writeFileSync(path.join(tmpWasm, 'helpers.js'), FILE_HELPERS);
  fs.writeFileSync(path.join(tmpWasm, 'consumer.js'), FILE_CONSUMER);

  tmpNative = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1730-native-'));
  fs.writeFileSync(path.join(tmpNative, 'helpers.js'), FILE_HELPERS);
  fs.writeFileSync(path.join(tmpNative, 'consumer.js'), FILE_CONSUMER);

  await Promise.all([
    buildGraph(tmpWasm, { incremental: false, skipRegistry: true, engine: 'wasm' }),
    buildGraph(tmpNative, { incremental: false, skipRegistry: true, engine: 'native' }),
  ]);
});

afterAll(() => {
  fs.rmSync(tmpWasm, { recursive: true, force: true });
  fs.rmSync(tmpNative, { recursive: true, force: true });
});

function getCallEdges(dbPath: string) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT n1.name AS src, n1.file AS src_file, n2.name AS tgt, n2.file AS tgt_file
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'calls'
         ORDER BY n1.name, n2.name`,
      )
      .all() as Array<{ src: string; src_file: string; tgt: string; tgt_file: string }>;
  } finally {
    db.close();
  }
}

describe('call-edge resolution through a renamed import specifier (#1730)', () => {
  it('WASM: useIt -> collectFiles calls edge exists (resolved through the rename)', () => {
    const edges = getCallEdges(path.join(tmpWasm, '.codegraph', 'graph.db'));
    const edge = edges.find((e) => e.src === 'useIt' && e.tgt === 'collectFiles');
    expect(edge).toBeDefined();
    expect(edge?.tgt_file).toBe('helpers.js');
  });

  it('Native: useIt -> collectFiles calls edge exists (resolved through the rename)', () => {
    const edges = getCallEdges(path.join(tmpNative, '.codegraph', 'graph.db'));
    const edge = edges.find((e) => e.src === 'useIt' && e.tgt === 'collectFiles');
    expect(edge).toBeDefined();
    expect(edge?.tgt_file).toBe('helpers.js');
  });

  it('no spurious edge is created against a nonexistent "collectFilesUtil" symbol', () => {
    for (const dbPath of [
      path.join(tmpWasm, '.codegraph', 'graph.db'),
      path.join(tmpNative, '.codegraph', 'graph.db'),
    ]) {
      const edges = getCallEdges(dbPath);
      expect(edges.find((e) => e.tgt === 'collectFilesUtil')).toBeUndefined();
    }
  });

  it('WASM: codegraph exports credits collectFiles with the renamed-import consumer', () => {
    const data = exportsData('helpers.js', path.join(tmpWasm, '.codegraph', 'graph.db'));
    const collectFiles = data.results.find((r: { name: string }) => r.name === 'collectFiles');
    expect(collectFiles).toBeDefined();
    expect(collectFiles.consumerCount).toBeGreaterThanOrEqual(1);
    expect(collectFiles.consumers.map((c: { name: string }) => c.name)).toContain('useIt');
  });

  it('Native: codegraph exports credits collectFiles with the renamed-import consumer', () => {
    const data = exportsData('helpers.js', path.join(tmpNative, '.codegraph', 'graph.db'));
    const collectFiles = data.results.find((r: { name: string }) => r.name === 'collectFiles');
    expect(collectFiles).toBeDefined();
    expect(collectFiles.consumerCount).toBeGreaterThanOrEqual(1);
    expect(collectFiles.consumers.map((c: { name: string }) => c.name)).toContain('useIt');
  });
});
