import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { initSchema } from '../../src/db/index.js';
import { buildEmbeddings } from '../../src/domain/search/index.js';

// buildEmbeddings must never touch @huggingface/transformers on the remote
// path — mocking it to throw proves the remote branch doesn't fall through
// to the local loader.
vi.mock('@huggingface/transformers', () => {
  throw new Error('local transformers pipeline should not be loaded on the remote path');
});

function insertNode(db, name, kind, file, line, endLine) {
  return db
    .prepare('INSERT INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)')
    .run(name, kind, file, line, endLine).lastInsertRowid;
}

describe('buildEmbeddings with a remote provider', () => {
  let tmpDir: string, dbPath: string;
  const fetchMock = vi.fn();

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-remote-embed-'));
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

  test('dispatches to the remote endpoint and persists its response', async () => {
    await buildEmbeddings(tmpDir, 'my-remote-model', dbPath, {
      remote: { baseUrl: 'http://localhost:9999/v1', model: 'my-remote-model', apiKey: 'sk-x' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/v1/embeddings');

    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare('SELECT COUNT(*) as c FROM embeddings').get().c;
    const modelMeta = db.prepare("SELECT value FROM embedding_meta WHERE key = 'model'").get();
    const dimMeta = db.prepare("SELECT value FROM embedding_meta WHERE key = 'dim'").get();
    db.close();

    expect(count).toBe(1);
    expect(modelMeta.value).toBe('my-remote-model');
    expect(dimMeta.value).toBe('4');
  });
});
