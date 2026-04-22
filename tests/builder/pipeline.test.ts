/**
 * Unit tests for the pipeline orchestrator.
 *
 * Verifies that buildGraph from the new pipeline produces the same results
 * as the integration tests expect — correct return shape, phase timing, etc.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder/pipeline.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'sample-project');
let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pipeline-'));
  fs.cpSync(FIXTURE_DIR, tmpDir, {
    recursive: true,
    filter: (src) => path.basename(src) !== '.codegraph',
  });
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildGraph pipeline', () => {
  it('returns phases timing object', async () => {
    const result = await buildGraph(tmpDir, { incremental: false });
    expect(result).toBeDefined();
    expect(result.phases).toBeDefined();
    expect(typeof result.phases.setupMs).toBe('number');
    expect(typeof result.phases.collectMs).toBe('number');
    expect(result.phases.collectMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.phases.detectMs).toBe('number');
    expect(result.phases.detectMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.phases.parseMs).toBe('number');
    expect(typeof result.phases.insertMs).toBe('number');
    expect(typeof result.phases.resolveMs).toBe('number');
    expect(typeof result.phases.edgesMs).toBe('number');
    expect(typeof result.phases.structureMs).toBe('number');
    expect(typeof result.phases.rolesMs).toBe('number');
    expect(typeof result.phases.finalizeMs).toBe('number');
  });

  it('returns undefined on early exit (no changes)', async () => {
    // First build
    await buildGraph(tmpDir, { incremental: false });
    // Second build — incremental, no changes
    const result = await buildGraph(tmpDir, { incremental: true });
    expect(result).toBeUndefined();
  });

  it('creates expected nodes and edges', async () => {
    await buildGraph(tmpDir, { incremental: false });

    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path.join(tmpDir, '.codegraph', 'graph.db'), { readonly: true });

    const nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
    const edgeCount = db.prepare('SELECT COUNT(*) as c FROM edges').get().c;

    expect(nodeCount).toBeGreaterThan(0);
    expect(edgeCount).toBeGreaterThan(0);

    // Should have file nodes for all 3 fixture files
    const fileNodes = db
      .prepare("SELECT name FROM nodes WHERE kind = 'file'")
      .all()
      .map((r) => r.name);
    expect(fileNodes).toContain('math.js');
    expect(fileNodes).toContain('utils.js');
    expect(fileNodes).toContain('index.js');

    db.close();
  });

  it('exports from barrel are identical to direct import', async () => {
    // Verify the barrel re-export works
    const { buildGraph: fromBarrel } = await import('../../src/domain/graph/builder.js');
    expect(fromBarrel).toBe(buildGraph);
  });
});
