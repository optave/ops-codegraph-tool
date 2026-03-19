/**
 * Incremental edge parity CI check.
 *
 * Verifies that incremental rebuilds produce exactly the same edges as a
 * clean full build, across multiple mutation scenarios:
 *   1. Comment-only touch (no semantic change)
 *   2. Body edit (change implementation, keep exports)
 *   3. New export added (structural change)
 *   4. File deletion (stale edges must be purged)
 *
 * Uses the sample-project fixture (CJS, classes, cross-file calls) for
 * broader edge coverage than the barrel-project fixture.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/domain/graph/builder.js';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'fixtures', 'sample-project');

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readEdges(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const edges = db
      .prepare(
        `SELECT n1.name AS source_name, n2.name AS target_name, e.kind
         FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         ORDER BY n1.name, n2.name, e.kind`,
      )
      .all();
    return edges;
  } finally {
    db.close();
  }
}

function readNodes(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const nodes = db.prepare('SELECT name, kind, file FROM nodes ORDER BY name, kind, file').all();
    return nodes;
  } finally {
    db.close();
  }
}

function edgeKey(e) {
  return `${e.source_name} -[${e.kind}]-> ${e.target_name}`;
}

/**
 * Build a full-build copy and an incremental-build copy after applying
 * the same mutation to both, then compare edges.
 */
async function buildAndCompare(fixtureDir, mutate) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-edge-parity-'));
  const fullDir = path.join(tmpBase, 'full');
  const incrDir = path.join(tmpBase, 'incr');

  try {
    copyDirSync(fixtureDir, fullDir);
    copyDirSync(fixtureDir, incrDir);

    // Initial full build on the incr copy (establishes baseline hashes)
    await buildGraph(incrDir, { incremental: false, skipRegistry: true });

    // Apply the mutation to both copies
    mutate(fullDir);
    mutate(incrDir);

    // Full build on the full copy (clean, from scratch)
    await buildGraph(fullDir, { incremental: false, skipRegistry: true });
    // Incremental rebuild on the incr copy
    await buildGraph(incrDir, { incremental: true, skipRegistry: true });

    const fullEdges = readEdges(path.join(fullDir, '.codegraph', 'graph.db'));
    const incrEdges = readEdges(path.join(incrDir, '.codegraph', 'graph.db'));
    const fullNodes = readNodes(path.join(fullDir, '.codegraph', 'graph.db'));
    const incrNodes = readNodes(path.join(incrDir, '.codegraph', 'graph.db'));

    return { fullEdges, incrEdges, fullNodes, incrNodes };
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

describe('Incremental edge parity (CI gate)', () => {
  // Scenario 1: Comment-only touch — edges must be identical
  describe('comment-only touch', () => {
    let result;

    beforeAll(async () => {
      result = await buildAndCompare(FIXTURE_DIR, (dir) => {
        const p = path.join(dir, 'math.js');
        fs.appendFileSync(p, '\n// comment touch\n');
      });
    }, 60_000);

    it('edge count matches', () => {
      expect(result.incrEdges.length).toBe(result.fullEdges.length);
    });

    it('edges are identical', () => {
      expect(result.incrEdges).toEqual(result.fullEdges);
    });
  });

  // Scenario 2: Body edit — change function implementation, keep exports
  describe('body edit (same exports)', () => {
    let result;

    beforeAll(async () => {
      result = await buildAndCompare(FIXTURE_DIR, (dir) => {
        const p = path.join(dir, 'math.js');
        let src = fs.readFileSync(p, 'utf-8');
        // Change add implementation but keep the same signature and exports
        src = src.replace('return a + b;', 'return b + a;');
        if (!src.includes('return b + a;'))
          throw new Error('Mutation failed: target string not found in math.js');
        fs.writeFileSync(p, src);
      });
    }, 60_000);

    it('edge count matches', () => {
      expect(result.incrEdges.length).toBe(result.fullEdges.length);
    });

    it('edges are identical', () => {
      expect(result.incrEdges).toEqual(result.fullEdges);
    });
  });

  // Scenario 3: New export added — edges from consumers should resolve
  describe('new export added', () => {
    let result;

    beforeAll(async () => {
      result = await buildAndCompare(FIXTURE_DIR, (dir) => {
        const mathPath = path.join(dir, 'math.js');
        let src = fs.readFileSync(mathPath, 'utf-8');
        // Add a new function before the module.exports line
        src = src.replace(
          'module.exports = { add, multiply, square };',
          `function subtract(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add, multiply, square, subtract };`,
        );
        if (!src.includes('subtract'))
          throw new Error('Mutation failed: module.exports replacement not applied in math.js');
        fs.writeFileSync(mathPath, src);

        // Have index.js import and call the new function
        const indexPath = path.join(dir, 'index.js');
        let indexSrc = fs.readFileSync(indexPath, 'utf-8');
        indexSrc = indexSrc.replace(
          "const { add } = require('./math');",
          "const { add, subtract } = require('./math');",
        );
        if (!indexSrc.includes('subtract'))
          throw new Error('Mutation failed: require replacement not applied in index.js');
        indexSrc = indexSrc.replace(
          'console.log(add(1, 2));',
          'console.log(add(1, 2));\n  console.log(subtract(5, 3));',
        );
        if (!indexSrc.includes('subtract(5, 3)'))
          throw new Error('Mutation failed: console.log replacement not applied in index.js');
        fs.writeFileSync(indexPath, indexSrc);
      });
    }, 60_000);

    it('node count matches', () => {
      expect(result.incrNodes.length).toBe(result.fullNodes.length);
    });

    it('edge count matches', () => {
      expect(result.incrEdges.length).toBe(result.fullEdges.length);
    });

    it('edges are identical', () => {
      if (result.incrEdges.length !== result.fullEdges.length) {
        // Diagnostic: show which edges differ
        const fullSet = new Set(result.fullEdges.map(edgeKey));
        const incrSet = new Set(result.incrEdges.map(edgeKey));
        const missingInIncr = [...fullSet].filter((k) => !incrSet.has(k));
        const extraInIncr = [...incrSet].filter((k) => !fullSet.has(k));
        expect.fail(
          `Edge mismatch:\n  Missing in incremental: ${missingInIncr.join(', ') || 'none'}\n  Extra in incremental: ${extraInIncr.join(', ') || 'none'}`,
        );
      }
      expect(result.incrEdges).toEqual(result.fullEdges);
    });
  });

  // Scenario 4: File deletion — stale edges must be purged
  describe('file deletion', () => {
    let result;

    beforeAll(async () => {
      result = await buildAndCompare(FIXTURE_DIR, (dir) => {
        // Delete utils.js — edges involving sumOfSquares/Calculator should disappear
        fs.unlinkSync(path.join(dir, 'utils.js'));
        // Update index.js to remove the require
        const indexPath = path.join(dir, 'index.js');
        let src = fs.readFileSync(indexPath, 'utf-8');
        const before = src;
        src = src.replace("const { sumOfSquares, Calculator } = require('./utils');\n", '');
        src = src.replace('  console.log(sumOfSquares(3, 4));\n', '');
        src = src.replace('  const calc = new Calculator();\n', '');
        src = src.replace('  console.log(calc.compute(5, 6));\n', '');
        if (src === before)
          throw new Error(
            'Mutation failed: no replacements applied in index.js for file deletion scenario',
          );
        fs.writeFileSync(indexPath, src);
      });
    }, 60_000);

    it('node count matches', () => {
      expect(result.incrNodes.length).toBe(result.fullNodes.length);
    });

    it('edge count matches', () => {
      expect(result.incrEdges.length).toBe(result.fullEdges.length);
    });

    it('edges are identical', () => {
      expect(result.incrEdges).toEqual(result.fullEdges);
    });
  });
});
