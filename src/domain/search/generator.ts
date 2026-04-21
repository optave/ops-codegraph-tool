import fs from 'node:fs';
import path from 'node:path';
import { closeDb, findDbPath, getBuildMeta, openDb } from '../../db/index.js';
import { warn } from '../../infrastructure/logger.js';
import { DbError } from '../../shared/errors.js';
import type { BetterSqlite3Database, NodeRow } from '../../types.js';
import { embed, getModelConfig } from './models.js';
import { buildSourceText } from './strategies/source.js';
import { buildStructuredText } from './strategies/structured.js';

/**
 * Rough token estimate (~4 chars per token for code/English).
 * Conservative — avoids adding a tokenizer dependency.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function initEmbeddingsSchema(db: BetterSqlite3Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      node_id INTEGER PRIMARY KEY,
      vector BLOB NOT NULL,
      text_preview TEXT,
      FOREIGN KEY(node_id) REFERENCES nodes(id)
    );
    CREATE TABLE IF NOT EXISTS embedding_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Add full_text column (idempotent — ignore if already exists)
  try {
    db.exec('ALTER TABLE embeddings ADD COLUMN full_text TEXT');
  } catch {
    /* column already exists */
  }

  // FTS5 virtual table for BM25 keyword search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_index USING fts5(
      name,
      content,
      tokenize='unicode61'
    );
  `);
}

export interface BuildEmbeddingsOptions {
  strategy?: 'structured' | 'source';
}

/**
 * Build embeddings for all functions/methods/classes in the graph.
 */
export async function buildEmbeddings(
  rootDir: string,
  modelKey: string,
  customDbPath?: string,
  options: BuildEmbeddingsOptions = {},
): Promise<void> {
  const strategy = options.strategy || 'structured';
  const dbPath = customDbPath || findDbPath(undefined);

  if (!fs.existsSync(dbPath)) {
    throw new DbError(
      `No codegraph database found at ${dbPath}.\nRun "codegraph build" first to analyze your codebase.`,
      { file: dbPath },
    );
  }

  const db = openDb(dbPath) as BetterSqlite3Database;
  initEmbeddingsSchema(db);

  // Prefer the repo root recorded at build time — embed may be invoked from a
  // different cwd (e.g. `codegraph embed --db /abs/path/graph.db`) and the
  // positional rootDir will be wrong in that case. For legacy DBs without
  // root_dir metadata, fall back to `<dbParent>` only when the DB lives at
  // the conventional `<root>/.codegraph/graph.db` layout — otherwise trust
  // the caller-provided rootDir (which may be an explicit positional arg).
  // `path.dirname(...)` is always non-empty (`'.'` at minimum), so the
  // conventional-layout check is required to keep the rootDir path reachable.
  const metaRoot = getBuildMeta(db, 'root_dir');
  const resolvedDbPath = path.resolve(dbPath);
  const dbDirName = path.basename(path.dirname(resolvedDbPath));
  const dbParent =
    dbDirName === '.codegraph' ? path.dirname(path.dirname(resolvedDbPath)) : undefined;
  const resolvedRoot = metaRoot || dbParent || rootDir;

  db.exec('DELETE FROM embeddings');
  db.exec('DELETE FROM embedding_meta');
  db.exec('DELETE FROM fts_index');

  const nodes = db
    .prepare(
      `SELECT * FROM nodes WHERE kind IN ('function', 'method', 'class') ORDER BY file, line`,
    )
    .all() as Array<NodeRow & { id: number }>;

  console.log(`Building embeddings for ${nodes.length} symbols (strategy: ${strategy})...`);

  const byFile = new Map<string, typeof nodes>();
  for (const node of nodes) {
    if (!byFile.has(node.file)) byFile.set(node.file, []);
    byFile.get(node.file)?.push(node);
  }

  const texts: string[] = [];
  const nodeIds: number[] = [];
  const nodeNames: string[] = [];
  const previews: string[] = [];
  const config = getModelConfig(modelKey);
  const contextWindow = config.contextWindow;
  let overflowCount = 0;
  let filesRead = 0;
  let filesSkipped = 0;

  for (const [file, fileNodes] of byFile) {
    const fullPath = path.isAbsolute(file) ? file : path.join(resolvedRoot, file);
    let lines: string[];
    try {
      lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
      filesRead++;
    } catch (err: unknown) {
      filesSkipped++;
      warn(`Cannot read ${file} for embeddings: ${(err as Error).message}`);
      continue;
    }

    for (const node of fileNodes) {
      let text =
        strategy === 'structured'
          ? buildStructuredText(node, file, lines, db)
          : buildSourceText(node, file, lines);

      // Detect and handle context window overflow
      const tokens = estimateTokens(text);
      if (tokens > contextWindow) {
        overflowCount++;
        const maxChars = contextWindow * 4;
        text = text.slice(0, maxChars);
      }

      texts.push(text);
      nodeIds.push(node.id);
      nodeNames.push(node.name);
      previews.push(`${node.name} (${node.kind}) -- ${file}:${node.line}`);
    }
  }

  if (overflowCount > 0) {
    warn(
      `${overflowCount} symbol(s) exceeded model context window (${contextWindow} tokens) and were truncated`,
    );
  }

  // If there were symbols to embed but every file failed to read, the DB was
  // almost certainly built from a different location than the current cwd.
  // Surface this clearly instead of emitting a silent "Stored 0 embeddings".
  if (byFile.size > 0 && filesRead === 0) {
    closeDb(db);
    throw new DbError(
      `embed: could not read any of the ${filesSkipped} source files recorded in the graph — the DB may have been built from a different location than the current working directory.\n` +
        `Tried resolving against: ${resolvedRoot}\n` +
        'Pass a positional <dir> argument pointing at the original repo root, or re-run "codegraph build" from that directory.',
      { file: dbPath },
    );
  }

  console.log(`Embedding ${texts.length} symbols...`);
  const { vectors, dim } = await embed(texts, modelKey);

  const insert = db.prepare(
    'INSERT OR REPLACE INTO embeddings (node_id, vector, text_preview, full_text) VALUES (?, ?, ?, ?)',
  );
  const insertFts = db.prepare('INSERT INTO fts_index(rowid, name, content) VALUES (?, ?, ?)');
  const insertMeta = db.prepare('INSERT OR REPLACE INTO embedding_meta (key, value) VALUES (?, ?)');
  const insertAll = db.transaction(() => {
    for (let i = 0; i < vectors.length; i++) {
      const vec = vectors[i] as Float32Array;
      insert.run(nodeIds[i], Buffer.from(vec.buffer), previews[i], texts[i]);
      insertFts.run(nodeIds[i], nodeNames[i], texts[i]);
    }
    insertMeta.run('model', config.name);
    insertMeta.run('dim', String(dim));
    insertMeta.run('count', String(vectors.length));
    insertMeta.run('fts_count', String(vectors.length));
    insertMeta.run('strategy', strategy);
    insertMeta.run('built_at', new Date().toISOString());
    if (overflowCount > 0) {
      insertMeta.run('truncated_count', String(overflowCount));
    }
  });
  insertAll();

  console.log(
    `\nStored ${vectors.length} embeddings (${dim}d, ${config.name}, strategy: ${strategy}) in graph.db`,
  );
  closeDb(db);
}
