import fs from 'node:fs';
import path from 'node:path';
import { closeDb, findDbPath, openDb } from '../db.js';
import { DbError } from '../errors.js';
import { warn } from '../logger.js';
import { embed, getModelConfig } from './models.js';
import { buildSourceText } from './strategies/source.js';
import { buildStructuredText } from './strategies/structured.js';

/**
 * Rough token estimate (~4 chars per token for code/English).
 * Conservative — avoids adding a tokenizer dependency.
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function initEmbeddingsSchema(db) {
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
 * Build embeddings for all functions/methods/classes in the graph.
 * @param {string} rootDir - Project root directory
 * @param {string} modelKey - Model identifier from MODELS registry
 * @param {string} [customDbPath] - Override path to graph.db
 * @param {object} [options] - Embedding options
 * @param {string} [options.strategy='structured'] - 'structured' (graph-enriched) or 'source' (raw code)
 */
export async function buildEmbeddings(rootDir, modelKey, customDbPath, options = {}) {
  const strategy = options.strategy || 'structured';
  const dbPath = customDbPath || findDbPath(null);

  if (!fs.existsSync(dbPath)) {
    throw new DbError(
      `No codegraph database found at ${dbPath}.\nRun "codegraph build" first to analyze your codebase.`,
      { file: dbPath },
    );
  }

  const db = openDb(dbPath);
  initEmbeddingsSchema(db);

  db.exec('DELETE FROM embeddings');
  db.exec('DELETE FROM embedding_meta');
  db.exec('DELETE FROM fts_index');

  const nodes = db
    .prepare(
      `SELECT * FROM nodes WHERE kind IN ('function', 'method', 'class') ORDER BY file, line`,
    )
    .all();

  console.log(`Building embeddings for ${nodes.length} symbols (strategy: ${strategy})...`);

  const byFile = new Map();
  for (const node of nodes) {
    if (!byFile.has(node.file)) byFile.set(node.file, []);
    byFile.get(node.file).push(node);
  }

  const texts = [];
  const nodeIds = [];
  const nodeNames = [];
  const previews = [];
  const config = getModelConfig(modelKey);
  const contextWindow = config.contextWindow;
  let overflowCount = 0;

  for (const [file, fileNodes] of byFile) {
    const fullPath = path.join(rootDir, file);
    let lines;
    try {
      lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
    } catch (err) {
      warn(`Cannot read ${file} for embeddings: ${err.message}`);
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

  console.log(`Embedding ${texts.length} symbols...`);
  const { vectors, dim } = await embed(texts, modelKey);

  const insert = db.prepare(
    'INSERT OR REPLACE INTO embeddings (node_id, vector, text_preview, full_text) VALUES (?, ?, ?, ?)',
  );
  const insertFts = db.prepare('INSERT INTO fts_index(rowid, name, content) VALUES (?, ?, ?)');
  const insertMeta = db.prepare('INSERT OR REPLACE INTO embedding_meta (key, value) VALUES (?, ?)');
  const insertAll = db.transaction(() => {
    for (let i = 0; i < vectors.length; i++) {
      insert.run(nodeIds[i], Buffer.from(vectors[i].buffer), previews[i], texts[i]);
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
