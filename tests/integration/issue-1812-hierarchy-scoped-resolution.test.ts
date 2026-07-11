/**
 * #1812: extends/implements edges must resolve like any other symbol
 * reference — same-file declaration first, then the file's actually-resolved
 * import, only falling back to a same-language-family global-by-name match
 * as a last resort. Before this fix, a bare heritage-clause name (`extends X`
 * / `implements Y`) matched *every* node in the graph named `X`/`Y`,
 * regardless of file or language, producing false cross-file (even
 * cross-language) hierarchy edges for common type names.
 *
 * Fixture layout (tests/fixtures/hierarchy-scoping/):
 *   moduleA/Base.ts   — Repository (class), Readable (interface), UniqueBase (class)
 *   moduleB/Base.ts   — unrelated Repository/Readable declarations, same names
 *   decoy/Repository.py — unrelated Python Repository/UniqueBase, same names
 *   consumer.ts       — imports Repository + Readable from moduleA/Base.ts;
 *                       UserRepository extends Repository implements Readable
 *   orphan.ts         — Orphan extends UniqueBase with NO import at all
 *   renamed-import.ts — imports Repository as BaseRepo from moduleA/Base.ts;
 *                       RenamedConsumer extends BaseRepo (renamed import)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';
import type { EngineMode } from '../../src/types.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'hierarchy-scoping');

interface HierarchyEdgeRow {
  kind: string;
  source_name: string;
  source_file: string;
  target_name: string;
  target_file: string;
}

function readHierarchyEdges(dbPath: string): HierarchyEdgeRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT e.kind AS kind,
                n1.name AS source_name, n1.file AS source_file,
                n2.name AS target_name, n2.file AS target_file
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind IN ('extends', 'implements')
         ORDER BY n1.file, n1.name, e.kind, n2.file, n2.name`,
      )
      .all() as HierarchyEdgeRow[];
  } finally {
    db.close();
  }
}

const ENGINES: EngineMode[] = ['wasm', 'native'];

describe.each(ENGINES)('issue #1812: hierarchy edge scoping (%s)', (engine) => {
  let tmpDir: string;
  let hierarchyEdges: HierarchyEdgeRow[];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-1812-${engine}-`));
    fs.cpSync(FIXTURE_DIR, tmpDir, { recursive: true });

    await buildGraph(tmpDir, { incremental: false, skipRegistry: true, engine });
    hierarchyEdges = readHierarchyEdges(path.join(tmpDir, '.codegraph', 'graph.db'));
  }, 60_000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extends: resolves UserRepository -> moduleA/Base.ts Repository (import-scoped)', () => {
    const matches = hierarchyEdges.filter(
      (e) => e.kind === 'extends' && e.source_name === 'UserRepository',
    );
    expect(
      matches,
      `Expected exactly one extends edge from UserRepository.\nActual:\n${JSON.stringify(hierarchyEdges, null, 2)}`,
    ).toHaveLength(1);
    expect(matches[0]!.target_file).toBe('moduleA/Base.ts');
    expect(matches[0]!.target_name).toBe('Repository');
  });

  it('extends: does NOT link UserRepository -> moduleB/Base.ts Repository', () => {
    const bogus = hierarchyEdges.find(
      (e) =>
        e.kind === 'extends' &&
        e.source_name === 'UserRepository' &&
        e.target_file === 'moduleB/Base.ts',
    );
    expect(bogus).toBeUndefined();
  });

  it('extends: does NOT link UserRepository -> decoy/Repository.py Repository (cross-language)', () => {
    const bogus = hierarchyEdges.find(
      (e) =>
        e.kind === 'extends' &&
        e.source_name === 'UserRepository' &&
        e.target_file === 'decoy/Repository.py',
    );
    expect(bogus).toBeUndefined();
  });

  it('implements: resolves UserRepository -> moduleA/Base.ts Readable (import-scoped)', () => {
    const matches = hierarchyEdges.filter(
      (e) => e.kind === 'implements' && e.source_name === 'UserRepository',
    );
    expect(
      matches,
      `Expected exactly one implements edge from UserRepository.\nActual:\n${JSON.stringify(hierarchyEdges, null, 2)}`,
    ).toHaveLength(1);
    expect(matches[0]!.target_file).toBe('moduleA/Base.ts');
    expect(matches[0]!.target_name).toBe('Readable');
  });

  it('extends: no-import fallback resolves Orphan -> moduleA/Base.ts UniqueBase (same-language-family)', () => {
    const matches = hierarchyEdges.filter(
      (e) => e.kind === 'extends' && e.source_name === 'Orphan',
    );
    expect(
      matches,
      `Expected exactly one extends edge from Orphan.\nActual:\n${JSON.stringify(hierarchyEdges, null, 2)}`,
    ).toHaveLength(1);
    expect(matches[0]!.target_file).toBe('moduleA/Base.ts');
    expect(matches[0]!.target_name).toBe('UniqueBase');
  });

  it('extends: no-import fallback does NOT link Orphan -> decoy/Repository.py UniqueBase (cross-language)', () => {
    const bogus = hierarchyEdges.find(
      (e) =>
        e.kind === 'extends' &&
        e.source_name === 'Orphan' &&
        e.target_file === 'decoy/Repository.py',
    );
    expect(bogus).toBeUndefined();
  });

  it('extends: resolves RenamedConsumer -> moduleA/Base.ts Repository through a renamed import', () => {
    // Greptile review: the imported file stores the symbol under its
    // original exported name (`Repository`), not the local alias
    // (`BaseRepo`) the heritage clause names — the edge must not be
    // silently dropped for renamed imports (#1730).
    const matches = hierarchyEdges.filter(
      (e) => e.kind === 'extends' && e.source_name === 'RenamedConsumer',
    );
    expect(
      matches,
      `Expected exactly one extends edge from RenamedConsumer.\nActual:\n${JSON.stringify(hierarchyEdges, null, 2)}`,
    ).toHaveLength(1);
    expect(matches[0]!.target_file).toBe('moduleA/Base.ts');
    expect(matches[0]!.target_name).toBe('Repository');
  });
});
