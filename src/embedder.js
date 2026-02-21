import fs from "fs";
import path from "path";

import Database from 'better-sqlite3';
import { findDbPath, openReadonlyOrFail } from './db.js';
import { warn, debug } from './logger.js';

// Lazy-load transformers (heavy, optional module)
let pipeline = null;
let cos_sim = null;
let extractor = null;
let activeModel = null;

export const MODELS = {
  'minilm': {
    name: 'Xenova/all-MiniLM-L6-v2',
    dim: 384,
    desc: 'Smallest, fastest (~23MB). General text.',
    quantized: true
  },
  'jina-small': {
    name: 'Xenova/jina-embeddings-v2-small-en',
    dim: 512,
    desc: 'Small, good quality (~33MB). General text.',
    quantized: false
  },
  'jina-base': {
    name: 'Xenova/jina-embeddings-v2-base-en',
    dim: 768,
    desc: 'Good quality (~137MB). General text, 8192 token context.',
    quantized: false
  },
  'nomic': {
    name: 'Xenova/nomic-embed-text-v1',
    dim: 768,
    desc: 'Best local quality (~137MB). 8192 context, beats OpenAI ada-002.',
    quantized: false
  }
};

export const DEFAULT_MODEL = 'minilm';
const BATCH_SIZE_MAP = { 'minilm': 32, 'jina-small': 16, 'jina-base': 8, 'nomic': 8 };
const DEFAULT_BATCH_SIZE = 32;

function getModelConfig(modelKey) {
  const key = modelKey || DEFAULT_MODEL;
  const config = MODELS[key];
  if (!config) {
    console.error(`Unknown model: ${key}. Available: ${Object.keys(MODELS).join(', ')}`);
    process.exit(1);
  }
  return config;
}

/**
 * Lazy-load @huggingface/transformers.
 * This is an optional dependency — gives a clear error if not installed.
 */
async function loadTransformers() {
  try {
    return await import('@huggingface/transformers');
  } catch {
    console.error(
      'Semantic search requires @huggingface/transformers.\n' +
      'Install it with: npm install @huggingface/transformers'
    );
    process.exit(1);
  }
}

async function loadModel(modelKey) {
  const config = getModelConfig(modelKey);

  if (extractor && activeModel === config.name) return { extractor, config };

  const transformers = await loadTransformers();
  pipeline = transformers.pipeline;
  cos_sim = transformers.cos_sim;

  console.log(`Loading embedding model: ${config.name} (${config.dim}d)...`);
  const opts = config.quantized ? { quantized: true } : {};
  extractor = await pipeline('feature-extraction', config.name, opts);
  activeModel = config.name;
  console.log('Model loaded.');
  return { extractor, config };
}

/**
 * Generate embeddings for an array of texts.
 */
export async function embed(texts, modelKey) {
  const { extractor: ext, config } = await loadModel(modelKey);
  const dim = config.dim;
  const results = [];
  const batchSize = BATCH_SIZE_MAP[modelKey || DEFAULT_MODEL] || DEFAULT_BATCH_SIZE;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const output = await ext(batch, { pooling: 'mean', normalize: true });

    for (let j = 0; j < batch.length; j++) {
      const start = j * dim;
      const vec = new Float32Array(dim);
      for (let k = 0; k < dim; k++) {
        vec[k] = output.data[start + k];
      }
      results.push(vec);
    }

    if (texts.length > batchSize) {
      process.stdout.write(`  Embedded ${Math.min(i + batchSize, texts.length)}/${texts.length}\r`);
    }
  }

  return { vectors: results, dim };
}

/**
 * Cosine similarity between two Float32Arrays.
 */
export function cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
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
}

/**
 * Build embeddings for all functions/methods/classes in the graph.
 */
export async function buildEmbeddings(rootDir, modelKey) {
  // path already imported at top
  // fs already imported at top
  const dbPath = findDbPath(null);

  const db = new Database(dbPath);
  initEmbeddingsSchema(db);

  db.exec('DELETE FROM embeddings');
  db.exec('DELETE FROM embedding_meta');

  const nodes = db.prepare(
    `SELECT * FROM nodes WHERE kind IN ('function', 'method', 'class') ORDER BY file, line`
  ).all();

  console.log(`Building embeddings for ${nodes.length} symbols...`);

  const byFile = new Map();
  for (const node of nodes) {
    if (!byFile.has(node.file)) byFile.set(node.file, []);
    byFile.get(node.file).push(node);
  }

  const texts = [];
  const nodeIds = [];
  const previews = [];

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
      const startLine = Math.max(0, node.line - 1);
      const endLine = node.end_line
        ? Math.min(lines.length, node.end_line)
        : Math.min(lines.length, startLine + 15);
      const context = lines.slice(startLine, endLine).join('\n');

      const text = `${node.kind} ${node.name} in ${file}\n${context}`;
      texts.push(text);
      nodeIds.push(node.id);
      previews.push(`${node.name} (${node.kind}) -- ${file}:${node.line}`);
    }
  }

  console.log(`Embedding ${texts.length} symbols...`);
  const { vectors, dim } = await embed(texts, modelKey);

  const insert = db.prepare('INSERT OR REPLACE INTO embeddings (node_id, vector, text_preview) VALUES (?, ?, ?)');
  const insertMeta = db.prepare('INSERT OR REPLACE INTO embedding_meta (key, value) VALUES (?, ?)');
  const insertAll = db.transaction(() => {
    for (let i = 0; i < vectors.length; i++) {
      insert.run(nodeIds[i], Buffer.from(vectors[i].buffer), previews[i]);
    }
    const config = getModelConfig(modelKey);
    insertMeta.run('model', config.name);
    insertMeta.run('dim', String(dim));
    insertMeta.run('count', String(vectors.length));
    insertMeta.run('built_at', new Date().toISOString());
  });
  insertAll();

  console.log(`\nStored ${vectors.length} embeddings (${dim}d, ${getModelConfig(modelKey).name}) in graph.db`);
  db.close();
}

/**
 * Shared setup for search functions: opens DB, validates embeddings/model, loads rows.
 * Returns { db, rows, modelKey, storedDim } or null on failure (prints error).
 */
function _prepareSearch(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);

  let count;
  try {
    count = db.prepare("SELECT COUNT(*) as c FROM embeddings").get().c;
  } catch {
    console.log('No embeddings table found. Run `codegraph embed` first.');
    db.close();
    return null;
  }
  if (count === 0) {
    console.log('No embeddings found. Run `codegraph embed` first.');
    db.close();
    return null;
  }

  let storedModel = null;
  let storedDim = null;
  try {
    const modelRow = db.prepare("SELECT value FROM embedding_meta WHERE key = 'model'").get();
    const dimRow = db.prepare("SELECT value FROM embedding_meta WHERE key = 'dim'").get();
    if (modelRow) storedModel = modelRow.value;
    if (dimRow) storedDim = parseInt(dimRow.value);
  } catch { /* old DB without meta table */ }

  let modelKey = opts.model || null;
  if (!modelKey && storedModel) {
    for (const [key, config] of Object.entries(MODELS)) {
      if (config.name === storedModel) { modelKey = key; break; }
    }
  }

  // Pre-filter: allow filtering by kind or file pattern to reduce search space
  const noTests = opts.noTests || false;
  const TEST_PATTERN = /\.(test|spec)\.|__test__|__tests__|\.stories\./;
  let sql = `
    SELECT e.node_id, e.vector, e.text_preview, n.name, n.kind, n.file, n.line
    FROM embeddings e
    JOIN nodes n ON e.node_id = n.id
  `;
  const params = [];
  const conditions = [];
  if (opts.kind) {
    conditions.push('n.kind = ?');
    params.push(opts.kind);
  }
  if (opts.filePattern) {
    conditions.push('n.file LIKE ?');
    params.push(`%${opts.filePattern}%`);
  }
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  let rows = db.prepare(sql).all(...params);
  if (noTests) {
    rows = rows.filter(row => !TEST_PATTERN.test(row.file));
  }

  return { db, rows, modelKey, storedDim };
}

/**
 * Single-query semantic search — returns data instead of printing.
 * Returns { results: [{ name, kind, file, line, similarity }] } or null on failure.
 */
export async function searchData(query, customDbPath, opts = {}) {
  const limit = opts.limit || 15;
  const minScore = opts.minScore || 0.2;

  const prepared = _prepareSearch(customDbPath, opts);
  if (!prepared) return null;
  const { db, rows, modelKey, storedDim } = prepared;

  const { vectors: [queryVec], dim } = await embed([query], modelKey);

  if (storedDim && dim !== storedDim) {
    console.log(`Warning: query model dimension (${dim}) doesn't match stored embeddings (${storedDim}).`);
    console.log(`  Re-run \`codegraph embed\` with the same model, or use --model to match.`);
    db.close();
    return null;
  }

  const results = [];
  for (const row of rows) {
    const vec = new Float32Array(new Uint8Array(row.vector).buffer);
    const sim = cosineSim(queryVec, vec);

    if (sim >= minScore) {
      results.push({
        name: row.name,
        kind: row.kind,
        file: row.file,
        line: row.line,
        similarity: sim
      });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  db.close();
  return { results: results.slice(0, limit) };
}

/**
 * Multi-query semantic search with Reciprocal Rank Fusion (RRF).
 * Returns { results: [{ name, kind, file, line, rrf, queryScores }] } or null on failure.
 */
export async function multiSearchData(queries, customDbPath, opts = {}) {
  const limit = opts.limit || 15;
  const minScore = opts.minScore || 0.2;
  const k = opts.rrfK || 60;

  const prepared = _prepareSearch(customDbPath, opts);
  if (!prepared) return null;
  const { db, rows, modelKey, storedDim } = prepared;

  const { vectors: queryVecs, dim } = await embed(queries, modelKey);

  // Warn about similar queries that may bias RRF results
  const SIMILARITY_WARN_THRESHOLD = 0.85;
  for (let i = 0; i < queryVecs.length; i++) {
    for (let j = i + 1; j < queryVecs.length; j++) {
      const sim = cosineSim(queryVecs[i], queryVecs[j]);
      if (sim >= SIMILARITY_WARN_THRESHOLD) {
        warn(
          `Queries "${queries[i]}" and "${queries[j]}" are very similar ` +
          `(${(sim * 100).toFixed(0)}% cosine similarity). ` +
          `This may bias RRF results toward their shared matches. ` +
          `Consider using more distinct queries.`
        );
      }
    }
  }

  if (storedDim && dim !== storedDim) {
    console.log(`Warning: query model dimension (${dim}) doesn't match stored embeddings (${storedDim}).`);
    console.log(`  Re-run \`codegraph embed\` with the same model, or use --model to match.`);
    db.close();
    return null;
  }

  // Parse row vectors once
  const rowVecs = rows.map(row => new Float32Array(new Uint8Array(row.vector).buffer));

  // For each query: compute similarities, filter by minScore, rank
  const perQueryRanked = queries.map((query, qi) => {
    const scored = [];
    for (let ri = 0; ri < rows.length; ri++) {
      const sim = cosineSim(queryVecs[qi], rowVecs[ri]);
      if (sim >= minScore) {
        scored.push({ rowIndex: ri, similarity: sim });
      }
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    // Assign 1-indexed ranks
    return scored.map((item, rank) => ({ ...item, rank: rank + 1 }));
  });

  // Fuse results using RRF: for each unique row, sum 1/(k + rank_i) across queries
  const fusionMap = new Map(); // rowIndex -> { rrfScore, queryScores[] }
  for (let qi = 0; qi < queries.length; qi++) {
    for (const item of perQueryRanked[qi]) {
      if (!fusionMap.has(item.rowIndex)) {
        fusionMap.set(item.rowIndex, { rrfScore: 0, queryScores: [] });
      }
      const entry = fusionMap.get(item.rowIndex);
      entry.rrfScore += 1 / (k + item.rank);
      entry.queryScores.push({
        query: queries[qi],
        similarity: item.similarity,
        rank: item.rank
      });
    }
  }

  // Build results sorted by RRF score
  const results = [];
  for (const [rowIndex, entry] of fusionMap) {
    const row = rows[rowIndex];
    results.push({
      name: row.name,
      kind: row.kind,
      file: row.file,
      line: row.line,
      rrf: entry.rrfScore,
      queryScores: entry.queryScores
    });
  }

  results.sort((a, b) => b.rrf - a.rrf);
  db.close();
  return { results: results.slice(0, limit) };
}

/**
 * Semantic search with pre-filter support — CLI wrapper with multi-query detection.
 */
export async function search(query, customDbPath, opts = {}) {
  // Split by semicolons, trim, filter empties
  const queries = query.split(';').map(q => q.trim()).filter(q => q.length > 0);

  if (queries.length <= 1) {
    // Single-query path — preserve original output format
    const singleQuery = queries[0] || query;
    const data = await searchData(singleQuery, customDbPath, opts);
    if (!data) return;

    console.log(`\nSemantic search: "${singleQuery}"\n`);

    if (data.results.length === 0) {
      console.log('  No results above threshold.');
    } else {
      for (const r of data.results) {
        const bar = '#'.repeat(Math.round(r.similarity * 20));
        const kindIcon = r.kind === 'function' ? 'f' : r.kind === 'class' ? '*' : 'o';
        console.log(`  ${(r.similarity * 100).toFixed(1)}% ${bar}`);
        console.log(`    ${kindIcon} ${r.name} -- ${r.file}:${r.line}`);
      }
    }

    console.log(`\n  ${data.results.length} results shown\n`);
  } else {
    // Multi-query path — RRF ranking
    const data = await multiSearchData(queries, customDbPath, opts);
    if (!data) return;

    console.log(`\nMulti-query semantic search (RRF, k=${opts.rrfK || 60}):`);
    queries.forEach((q, i) => console.log(`  [${i + 1}] "${q}"`));
    console.log();

    if (data.results.length === 0) {
      console.log('  No results above threshold.');
    } else {
      for (const r of data.results) {
        const kindIcon = r.kind === 'function' ? 'f' : r.kind === 'class' ? '*' : 'o';
        console.log(`  RRF ${r.rrf.toFixed(4)}  ${kindIcon} ${r.name} -- ${r.file}:${r.line}`);
        for (const qs of r.queryScores) {
          const bar = '#'.repeat(Math.round(qs.similarity * 20));
          console.log(`    [${queries.indexOf(qs.query) + 1}] ${(qs.similarity * 100).toFixed(1)}% ${bar} (rank ${qs.rank})`);
        }
      }
    }

    console.log(`\n  ${data.results.length} results shown\n`);
  }
}

