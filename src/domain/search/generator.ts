import fs from 'node:fs';
import path from 'node:path';
import { closeDb, findDbPath, getBuildMeta, openDb } from '../../db/index.js';
import { warn } from '../../infrastructure/logger.js';
import { DbError } from '../../shared/errors.js';
import type { BetterSqlite3Database, NodeRow } from '../../types.js';
import { embed, getModelConfig } from './models.js';
import { buildSourceText } from './strategies/source.js';
import { buildStructuredText } from './strategies/structured.js';

type EmbeddingNode = NodeRow & { id: number };
type EmbeddingStrategy = 'structured' | 'source';

interface PreparedEmbeddings {
  texts: string[];
  nodeIds: number[];
  nodeNames: string[];
  previews: string[];
  overflowCount: number;
  filesRead: number;
  filesSkipped: number;
}

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

/**
 * Resolve the repo root for embedding. Prefer the root recorded at build time;
 * fall back to `<dbParent>` only when the DB lives at the conventional
 * `<root>/.codegraph/graph.db` layout — otherwise trust the caller's rootDir.
 */
function resolveRoot(db: BetterSqlite3Database, dbPath: string, rootDir: string): string {
  const metaRoot = getBuildMeta(db, 'root_dir');
  const resolvedDbPath = path.resolve(dbPath);
  const dbDirName = path.basename(path.dirname(resolvedDbPath));
  const dbParent =
    dbDirName === '.codegraph' ? path.dirname(path.dirname(resolvedDbPath)) : undefined;
  return metaRoot || dbParent || rootDir;
}

/** Reset embedding tables and load eligible symbols grouped by file. */
function loadNodesByFile(db: BetterSqlite3Database): Map<string, EmbeddingNode[]> {
  db.exec('DELETE FROM embeddings');
  db.exec('DELETE FROM embedding_meta');
  db.exec('DELETE FROM fts_index');

  const nodes = db
    .prepare(
      `SELECT * FROM nodes WHERE kind IN ('function', 'method', 'class') ORDER BY file, line`,
    )
    .all() as EmbeddingNode[];

  const byFile = new Map<string, EmbeddingNode[]>();
  for (const node of nodes) {
    if (!byFile.has(node.file)) byFile.set(node.file, []);
    byFile.get(node.file)?.push(node);
  }
  return byFile;
}

/** Build embedding text for a single node, truncating if it would overflow. */
function buildNodeText(
  node: EmbeddingNode,
  file: string,
  lines: string[],
  db: BetterSqlite3Database,
  strategy: EmbeddingStrategy,
  contextWindow: number,
): { text: string; overflowed: boolean } {
  let text =
    strategy === 'structured'
      ? buildStructuredText(node, file, lines, db)
      : buildSourceText(node, file, lines);
  const tokens = estimateTokens(text);
  if (tokens > contextWindow) {
    text = text.slice(0, contextWindow * 4);
    return { text, overflowed: true };
  }
  return { text, overflowed: false };
}

/**
 * Walk files in the graph, read source, and produce parallel arrays of
 * texts / nodeIds / nodeNames / previews ready for embedding.
 */
function prepareEmbeddingTexts(
  byFile: Map<string, EmbeddingNode[]>,
  db: BetterSqlite3Database,
  resolvedRoot: string,
  strategy: EmbeddingStrategy,
  contextWindow: number,
): PreparedEmbeddings {
  const texts: string[] = [];
  const nodeIds: number[] = [];
  const nodeNames: string[] = [];
  const previews: string[] = [];
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
      const { text, overflowed } = buildNodeText(node, file, lines, db, strategy, contextWindow);
      if (overflowed) overflowCount++;
      texts.push(text);
      nodeIds.push(node.id);
      nodeNames.push(node.name);
      previews.push(`${node.name} (${node.kind}) -- ${file}:${node.line}`);
    }
  }

  return { texts, nodeIds, nodeNames, previews, overflowCount, filesRead, filesSkipped };
}

/** Persist vectors, FTS rows, and embedding metadata in a single transaction. */
function persistEmbeddings(
  db: BetterSqlite3Database,
  prepared: PreparedEmbeddings,
  vectors: Float32Array[],
  dim: number,
  modelName: string,
  strategy: EmbeddingStrategy,
): void {
  const { nodeIds, nodeNames, previews, texts, overflowCount } = prepared;
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
    insertMeta.run('model', modelName);
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
}

export interface BuildEmbeddingsOptions {
  strategy?: EmbeddingStrategy;
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

  const resolvedRoot = resolveRoot(db, dbPath, rootDir);
  const byFile = loadNodesByFile(db);

  const nodeCount = [...byFile.values()].reduce((acc, list) => acc + list.length, 0);
  console.log(`Building embeddings for ${nodeCount} symbols (strategy: ${strategy})...`);

  const config = getModelConfig(modelKey);
  const prepared = prepareEmbeddingTexts(byFile, db, resolvedRoot, strategy, config.contextWindow);

  if (prepared.overflowCount > 0) {
    warn(
      `${prepared.overflowCount} symbol(s) exceeded model context window (${config.contextWindow} tokens) and were truncated`,
    );
  }

  // If there were symbols to embed but every file failed to read, the DB was
  // almost certainly built from a different location than the current cwd.
  // Surface this clearly instead of emitting a silent "Stored 0 embeddings".
  if (byFile.size > 0 && prepared.filesRead === 0) {
    closeDb(db);
    throw new DbError(
      `embed: could not read any of the ${prepared.filesSkipped} source files recorded in the graph — the DB may have been built from a different location than the current working directory.\n` +
        `Tried resolving against: ${resolvedRoot}\n` +
        'Pass a positional <dir> argument pointing at the original repo root, or re-run "codegraph build" from that directory.',
      { file: dbPath },
    );
  }

  console.log(`Embedding ${prepared.texts.length} symbols...`);
  const { vectors, dim } = await embed(prepared.texts, modelKey);

  persistEmbeddings(db, prepared, vectors as Float32Array[], dim, config.name, strategy);

  console.log(
    `\nStored ${vectors.length} embeddings (${dim}d, ${config.name}, strategy: ${strategy}) in graph.db`,
  );
  closeDb(db);
}
