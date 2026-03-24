/**
 * Integration tests for scoped rebuild (opts.scope + opts.noReverseDeps).
 *
 * Uses the sample-project fixture (math.js, utils.js, index.js) to build
 * a real graph, then verifies that scoped rebuilds surgically update only
 * targeted files while leaving everything else intact.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'sample-project');

let tmpDir;

function copyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-scoped-'));
  fs.cpSync(FIXTURE_DIR, dir, {
    recursive: true,
    filter: (src) => path.basename(src) !== '.codegraph',
  });
  return dir;
}

function openDb(dir) {
  const Database = require('better-sqlite3');
  return new Database(path.join(dir, '.codegraph', 'graph.db'), { readonly: true });
}

function nodeCount(db, file) {
  return db.prepare('SELECT COUNT(*) as c FROM nodes WHERE file = ?').get(file).c;
}

function edgeCount(db) {
  return db.prepare('SELECT COUNT(*) as c FROM edges').get().c;
}

beforeAll(async () => {
  tmpDir = copyFixture();
  // Build the initial full graph
  await buildGraph(tmpDir, { incremental: false });
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scoped rebuild', () => {
  test('scoped rebuild updates only targeted file, preserves others', async () => {
    const db1 = openDb(tmpDir);
    const mathNodesBefore = nodeCount(db1, 'math.js');
    const utilsNodesBefore = nodeCount(db1, 'utils.js');
    const indexNodesBefore = nodeCount(db1, 'index.js');
    db1.close();

    expect(mathNodesBefore).toBeGreaterThan(0);
    expect(utilsNodesBefore).toBeGreaterThan(0);

    // Scoped rebuild only math.js (no content change — should re-parse same result)
    await buildGraph(tmpDir, { scope: ['math.js'] });

    const db2 = openDb(tmpDir);
    const mathNodesAfter = nodeCount(db2, 'math.js');
    const utilsNodesAfter = nodeCount(db2, 'utils.js');
    const indexNodesAfter = nodeCount(db2, 'index.js');
    db2.close();

    // math.js should be rebuilt with same node count
    expect(mathNodesAfter).toBe(mathNodesBefore);
    // utils.js and index.js should be untouched
    expect(utilsNodesAfter).toBe(utilsNodesBefore);
    expect(indexNodesAfter).toBe(indexNodesBefore);
  });

  test('scoped rebuild with deleted file purges it from graph', async () => {
    // Create a temporary extra file, build it in, then delete and scope-rebuild
    const extraPath = path.join(tmpDir, 'extra.js');
    fs.writeFileSync(extraPath, 'function extra() { return 1; }\nmodule.exports = { extra };\n');

    // Full rebuild to pick up the new file
    await buildGraph(tmpDir, { incremental: false });

    const db1 = openDb(tmpDir);
    const extraBefore = nodeCount(db1, 'extra.js');
    const mathBefore = nodeCount(db1, 'math.js');
    db1.close();
    expect(extraBefore).toBeGreaterThan(0);

    // Delete the file and scope-rebuild it
    fs.unlinkSync(extraPath);
    await buildGraph(tmpDir, { scope: ['extra.js'] });

    const db2 = openDb(tmpDir);
    const extraAfter = nodeCount(db2, 'extra.js');
    const mathAfter = nodeCount(db2, 'math.js');
    db2.close();

    // extra.js should be completely purged
    expect(extraAfter).toBe(0);
    // math.js should be untouched
    expect(mathAfter).toBe(mathBefore);
  });

  test('reverse-dep cascade rebuilds importers edges', async () => {
    // Full rebuild to get clean state
    await buildGraph(tmpDir, { incremental: false });

    const db1 = openDb(tmpDir);
    const edgesBefore = edgeCount(db1);
    db1.close();

    // Scoped rebuild of math.js with default (reverse deps enabled)
    // utils.js and index.js import math.js, so their edges should be rebuilt
    await buildGraph(tmpDir, { scope: ['math.js'] });

    const db2 = openDb(tmpDir);
    const edgesAfter = edgeCount(db2);
    db2.close();

    // Edge count should be comparable (rebuilt edges for math.js + reverse deps)
    expect(edgesAfter).toBeGreaterThan(0);
    // Should not lose edges dramatically
    expect(edgesAfter).toBeGreaterThanOrEqual(edgesBefore - 2);
  });

  test('noReverseDeps: true skips the cascade', async () => {
    // Full rebuild to get clean state
    await buildGraph(tmpDir, { incremental: false });

    // Scoped rebuild with noReverseDeps — only math.js edges are rebuilt
    await buildGraph(tmpDir, { scope: ['math.js'], noReverseDeps: true });

    const db2 = openDb(tmpDir);
    const edgesAfter = edgeCount(db2);
    const mathNodes = nodeCount(db2, 'math.js');
    const utilsNodes = nodeCount(db2, 'utils.js');
    db2.close();

    // math.js and utils.js should still have nodes
    expect(mathNodes).toBeGreaterThan(0);
    expect(utilsNodes).toBeGreaterThan(0);
    // With noReverseDeps, we may lose some edges because importers weren't rebuilt
    // but the graph should still be valid
    expect(edgesAfter).toBeGreaterThan(0);
  });

  test('multiple files in scope', async () => {
    // Full rebuild to get clean state
    await buildGraph(tmpDir, { incremental: false });

    const db1 = openDb(tmpDir);
    const mathBefore = nodeCount(db1, 'math.js');
    const utilsBefore = nodeCount(db1, 'utils.js');
    const indexBefore = nodeCount(db1, 'index.js');
    db1.close();

    // Scope both math.js and utils.js
    await buildGraph(tmpDir, { scope: ['math.js', 'utils.js'] });

    const db2 = openDb(tmpDir);
    const mathAfter = nodeCount(db2, 'math.js');
    const utilsAfter = nodeCount(db2, 'utils.js');
    const indexAfter = nodeCount(db2, 'index.js');
    db2.close();

    // Both scoped files should be rebuilt with same counts
    expect(mathAfter).toBe(mathBefore);
    expect(utilsAfter).toBe(utilsBefore);
    // index.js untouched
    expect(indexAfter).toBe(indexBefore);
  });
});
