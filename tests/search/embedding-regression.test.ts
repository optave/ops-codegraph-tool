/**
 * Embedding regression test — validates the embed+search pipeline
 * produces semantically meaningful results with a real ML model.
 *
 * Skips automatically when @huggingface/transformers is not installed.
 * Run explicitly: npx vitest run tests/search/embedding-regression.test.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, type TestContext, test } from 'vitest';
import { flushDeferredClose } from '../../src/db/index.js';

// Detect whether transformers is available (optional dep)
let hasTransformers = false;
try {
  await import('@huggingface/transformers');
  hasTransformers = true;
} catch {
  // not installed — tests will skip
}

// Lazy-import to avoid top-level errors when transformers is missing
const { buildGraph } = await import('../../src/domain/graph/builder.js');
const { buildEmbeddings, searchData } = await import('../../src/domain/search/index.js');

// Same ES-module fixture files used by build.test.js
const FIXTURE_FILES = {
  'math.js': `
export function add(a, b) { return a + b; }
export function multiply(a, b) { return a * b; }
export function square(x) { return multiply(x, x); }
`.trimStart(),
  'utils.js': `
import { add, square } from './math.js';
export function sumOfSquares(a, b) { return add(square(a), square(b)); }
export class Calculator {
  compute(x, y) { return sumOfSquares(x, y); }
}
`.trimStart(),
  'index.js': `
import { sumOfSquares, Calculator } from './utils.js';
import { add } from './math.js';
export function main() {
  console.log(add(1, 2));
  console.log(sumOfSquares(3, 4));
  const calc = new Calculator();
  console.log(calc.compute(5, 6));
}
`.trimStart(),
};

let tmpDir: string, dbPath: string;
// Set to true when the model download is rate-limited (HTTP 429) so all tests skip.
let rateLimited = false;

describe.skipIf(!hasTransformers)('embedding regression (real model)', () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-embed-regression-'));
    for (const [name, content] of Object.entries(FIXTURE_FILES)) {
      fs.writeFileSync(path.join(tmpDir, name), content);
    }

    // Build the dependency graph
    await buildGraph(tmpDir, { skipRegistry: true });
    dbPath = path.join(tmpDir, '.codegraph', 'graph.db');

    // Build embeddings with the smallest/fastest model.
    // Skip gracefully when HuggingFace rate-limits the model download (HTTP 429).
    try {
      await buildEmbeddings(tmpDir, 'minilm', dbPath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('429')) {
        rateLimited = true;
        return;
      }
      throw err;
    }
  }, 240_000);

  afterAll(() => {
    if (!tmpDir) return;
    // Flush any deferred DB closes before deleting the temp directory.
    // On Windows, SQLite WAL files can remain locked briefly after db.close(),
    // causing intermittent EBUSY errors. Node's built-in maxRetries handles
    // retrying EBUSY/EMFILE automatically with retryDelay ms between attempts.
    flushDeferredClose();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  describe('smoke tests', () => {
    test('stored at least 6 embeddings', (ctx: TestContext) => {
      if (rateLimited) ctx.skip();
      const db = new Database(dbPath, { readonly: true });
      const count = db.prepare('SELECT COUNT(*) as c FROM embeddings').get().c;
      db.close();
      expect(count).toBeGreaterThanOrEqual(6);
    });

    test('metadata records correct model and dimension', (ctx: TestContext) => {
      if (rateLimited) ctx.skip();
      const db = new Database(dbPath, { readonly: true });
      const model = db.prepare("SELECT value FROM embedding_meta WHERE key = 'model'").get().value;
      const dim = db.prepare("SELECT value FROM embedding_meta WHERE key = 'dim'").get().value;
      db.close();
      expect(model).toBe('Xenova/all-MiniLM-L6-v2');
      expect(Number(dim)).toBe(384);
    });

    test('search returns results with positive similarity', async (ctx: TestContext) => {
      if (rateLimited) ctx.skip();
      const data = await searchData('add numbers', dbPath, { minScore: 0.01 });
      expect(data).not.toBeNull();
      expect(data.results.length).toBeGreaterThan(0);
      for (const r of data.results) {
        expect(r.similarity).toBeGreaterThan(0);
      }
    });
  });

  describe('regression queries', () => {
    /**
     * Helper: search for a query and assert that a given function name
     * appears within the top N results.
     */
    async function expectInTopN(query, expectedName, topN) {
      const data = await searchData(query, dbPath, { minScore: 0.01, limit: topN });
      expect(data).not.toBeNull();
      const names = data.results.map((r) => r.name);
      expect(names).toContain(expectedName);
    }

    test('"add two numbers together" finds add in top 3', async (ctx: TestContext) => {
      if (rateLimited) ctx.skip();
      await expectInTopN('add two numbers together', 'add', 3);
    });

    test('"multiply values" finds multiply in top 3', async (ctx: TestContext) => {
      if (rateLimited) ctx.skip();
      await expectInTopN('multiply values', 'multiply', 3);
    });

    test('"compute the square of a number" finds square in top 3', async (ctx: TestContext) => {
      if (rateLimited) ctx.skip();
      await expectInTopN('compute the square of a number', 'square', 3);
    });

    test('"sum of squares calculation" finds sumOfSquares in top 3', async (ctx: TestContext) => {
      if (rateLimited) ctx.skip();
      await expectInTopN('sum of squares calculation', 'sumOfSquares', 3);
    });

    test('"main entry point function" finds main in top 5', async (ctx: TestContext) => {
      if (rateLimited) ctx.skip();
      await expectInTopN('main entry point function', 'main', 5);
    });
  });
});
