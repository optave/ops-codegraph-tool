import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { initSchema } from '../../src/db/index.js';

// Local pipeline mock — needed because this suite switches back to the local
// model after a remote run, unlike the other embedding-remote-*.test.ts files
// which only ever exercise the remote path and mock transformers to throw.
vi.mock('@huggingface/transformers', () => ({
  pipeline: async () => async (batch) => {
    const dim = 4;
    const data = new Float32Array(dim * batch.length);
    for (let t = 0; t < batch.length; t++) {
      data[t * dim] = 0.5;
    }
    return { data };
  },
  cos_sim: () => 0,
}));

import { buildEmbeddings } from '../../src/domain/search/index.js';

function insertNode(db, name, kind, file, line, endLine) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)')
    .run(name, kind, file, line, endLine).lastInsertRowid;
}

function getProviderMeta(dbPath: string): string | undefined {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT value FROM embedding_meta WHERE key = 'provider'").get() as
    | { value: string }
    | undefined;
  db.close();
  return row?.value;
}

describe('embedding_meta provider bookkeeping across provider switches', () => {
  let tmpDir: string, dbPath: string;
  const fetchMock = vi.fn();

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-provider-meta-'));
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
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }] }), {
        status: 200,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  test('a full rebuild with the local model does not carry over a prior remote provider value', async () => {
    // `buildEmbeddings` always deletes every embedding_meta row up front
    // (loadNodesByFile) before persistEmbeddings writes fresh ones, so a
    // later local-model build can never inherit a stale 'openai' marker from
    // an earlier remote build — this test locks in that invariant.
    await buildEmbeddings(tmpDir, 'my-remote-model', dbPath, {
      remote: { baseUrl: 'http://localhost:9999/v1', model: 'my-remote-model', apiKey: 'sk-x' },
    });
    expect(getProviderMeta(dbPath)).toBe('openai');

    await buildEmbeddings(tmpDir, 'minilm', dbPath, {});

    expect(getProviderMeta(dbPath)).not.toBe('openai');
  });
});
