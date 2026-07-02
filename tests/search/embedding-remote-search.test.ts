import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { buildEmbeddings, searchData } from '../../src/domain/search/index.js';

// buildEmbeddings/searchData must never touch @huggingface/transformers when a
// remote provider is configured for both the index and query embedding steps.
vi.mock('@huggingface/transformers', () => {
  throw new Error('local transformers pipeline should not be loaded on the remote path');
});

function insertNode(db, name, kind, file, line, endLine) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)')
    .run(name, kind, file, line, endLine).lastInsertRowid;
}

describe('semantic search against remotely-built embeddings', () => {
  let tmpDir: string, dbPath: string;
  const fetchMock = vi.fn();
  const config = {
    embeddings: { model: 'my-remote-model', llmProvider: null, provider: 'openai' },
    llm: {
      provider: null,
      model: null,
      baseUrl: 'http://localhost:9999/v1',
      apiKey: 'sk-x',
      apiKeyCommand: null,
    },
    search: { defaultMinScore: 0, rrfK: 60, topK: 15, similarityWarnThreshold: 0.85 },
  } as never;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-remote-search-'));
    fs.writeFileSync(path.join(tmpDir, 'math.js'), 'export function add(a, b) { return a + b; }\n');

    const dbDir = path.join(tmpDir, '.codegraph');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'graph.db');

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    initSchema(db);
    insertNode(db, 'add', 'function', 'math.js', 1, 1);
    db.close();
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    // Every call (index or query) gets the same fixed vector, so the indexed
    // symbol always scores a perfect match against any query.
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      const data = body.input.map((_text: string, i: number) => ({
        embedding: [1, 0, 0, 0],
        index: i,
      }));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  test('query embedding is routed to the remote provider, not the local model', async () => {
    await buildEmbeddings(tmpDir, 'my-remote-model', dbPath, {
      remote: { baseUrl: 'http://localhost:9999/v1', model: 'my-remote-model', apiKey: 'sk-x' },
    });

    const result = await searchData('addition helper', dbPath, { config });

    expect(result).not.toBeNull();
    expect(result!.results.map((r) => r.name)).toContain('add');
    // One call to build the index embedding, one to embed the query.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe('http://localhost:9999/v1/embeddings');
    }
  });

  test('query embedding still routes remotely when embeddings.provider config drifts after embed', async () => {
    await buildEmbeddings(tmpDir, 'my-remote-model', dbPath, {
      remote: { baseUrl: 'http://localhost:9999/v1', model: 'my-remote-model', apiKey: 'sk-x' },
    });

    // Simulate config drift: whoever/whatever runs `search` no longer has
    // embeddings.provider set to "openai" (e.g. cleared on a CI machine, or a
    // different .codegraphrc.json applies). Routing must still honor the
    // provider recorded in embedding_meta at embed time, not this live value
    // — otherwise the query would silently fall back to the local model.
    const driftedConfig = {
      ...config,
      embeddings: { model: 'my-remote-model', llmProvider: null, provider: null },
    } as never;

    const result = await searchData('addition helper', dbPath, { config: driftedConfig });

    expect(result).not.toBeNull();
    expect(result!.results.map((r) => r.name)).toContain('add');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe('http://localhost:9999/v1/embeddings');
    }
  });
});
