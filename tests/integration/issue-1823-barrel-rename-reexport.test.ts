/**
 * Regression test for #1823: barrel re-export with rename
 * (`export { X as Y } from '...'`) must be tracked so resolution through
 * the barrel works for consumers that import the renamed external name.
 *
 * Fixture:
 *   underlying.ts — `export function realName() {}`
 *   barrel.ts     — `export { realName as friendlyName } from './underlying.js';`
 *   consumer.ts   — `import { friendlyName } from './barrel.js';` calls
 *                   `friendlyName()` inside an exported function.
 *
 * Before the fix, `extractImportNames`'s `export_specifier` branch never
 * recorded the rename pair, so `resolveBarrelExport` had no way to translate
 * a consumer's requested external name (`friendlyName`) back to the name
 * actually declared in the underlying module (`realName`) — the call edge
 * was dropped and `codegraph exports underlying.ts` reported zero consumers
 * for a genuinely-used export.
 *
 * Verified on both engines — this is resolver/extractor logic mirrored in
 * `crates/codegraph-core/`, so WASM and native must agree.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import { exportsData } from '../../src/domain/queries.js';
import type { EngineMode } from '../../src/types.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'barrel-rename-reexport');

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

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)('barrel re-export rename resolution (#1823) — %s', (engine) => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-1823-${engine}-`));
    fs.cpSync(FIXTURE_DIR, tmpDir, { recursive: true });
    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine });
    dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
  }, 60_000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('useIt -> realName calls edge exists, resolved through the barrel rename', () => {
    const edges = getCallEdges(dbPath);
    const edge = edges.find((e) => e.src === 'useIt' && e.tgt === 'realName');
    expect(edge, `Actual call edges:\n${JSON.stringify(edges, null, 2)}`).toBeDefined();
    expect(edge?.tgt_file).toBe('underlying.ts');
  });

  it('no spurious edge is created against a nonexistent "friendlyName" symbol', () => {
    const edges = getCallEdges(dbPath);
    expect(edges.find((e) => e.tgt === 'friendlyName')).toBeUndefined();
  });

  it('codegraph exports credits realName with the barrel-renamed consumer', () => {
    const data = exportsData('underlying.ts', dbPath);
    const realName = data.results.find((r: { name: string }) => r.name === 'realName');
    expect(realName).toBeDefined();
    expect(realName.consumerCount).toBeGreaterThanOrEqual(1);
    expect(realName.consumers.map((c: { name: string }) => c.name)).toContain('useIt');
  });
});
