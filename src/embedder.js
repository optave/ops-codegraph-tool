import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import Database from 'better-sqlite3';
import { findDbPath, openReadonlyOrFail } from './db.js';
import { info, warn } from './logger.js';

/**
 * Split an identifier into readable words.
 * camelCase/PascalCase → "camel Case", snake_case → "snake case", kebab-case → "kebab case"
 */
function splitIdentifier(name) {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
}

/**
 * Match a file path against a glob pattern.
 * Supports *, **, and ? wildcards. Zero dependencies.
 */
function globMatch(filePath, pattern) {
  // Normalize separators to forward slashes
  const normalized = filePath.replace(/\\/g, '/');
  // Escape regex specials except glob chars
  let regex = pattern.replace(/\\/g, '/').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Replace ** first (matches any path segment), then * and ?
  regex = regex.replace(/\*\*/g, '\0');
  regex = regex.replace(/\*/g, '[^/]*');
  regex = regex.replace(/\0/g, '.*');
  regex = regex.replace(/\?/g, '[^/]');
  try {
    return new RegExp(`^${regex}$`).test(normalized);
  } catch {
    // Malformed pattern — fall back to substring match
    return normalized.includes(pattern);
  }
}

// Lazy-load transformers (heavy, optional module)
let pipeline = null;
let _cos_sim = null;
let extractor = null;
let activeModel = null;

export const MODELS = {
  minilm: {
    name: 'Xenova/all-MiniLM-L6-v2',
    dim: 384,
    contextWindow: 256,
    desc: 'Smallest, fastest (~23MB). General text.',
    quantized: true,
  },
  'jina-small': {
    name: 'Xenova/jina-embeddings-v2-small-en',
    dim: 512,
    contextWindow: 8192,
    desc: 'Small, good quality (~33MB). General text.',
    quantized: false,
  },
  'jina-base': {
    name: 'Xenova/jina-embeddings-v2-base-en',
    dim: 768,
    contextWindow: 8192,
    desc: 'Good quality (~137MB). General text, 8192 token context.',
    quantized: false,
  },
  'jina-code': {
    name: 'Xenova/jina-embeddings-v2-base-code',
    dim: 768,
    contextWindow: 8192,
    desc: 'Code-aware (~137MB). Trained on code+text, best for code search.',
    quantized: false,
  },
  nomic: {
    name: 'Xenova/nomic-embed-text-v1',
    dim: 768,
    contextWindow: 8192,
    desc: 'Good local quality (~137MB). 8192 context.',
    quantized: false,
  },
  'nomic-v1.5': {
    name: 'nomic-ai/nomic-embed-text-v1.5',
    dim: 768,
    contextWindow: 8192,
    desc: 'Improved nomic (~137MB). Matryoshka dimensions, 8192 context.',
    quantized: false,
  },
  'bge-large': {
    name: 'Xenova/bge-large-en-v1.5',
    dim: 1024,
    contextWindow: 512,
    desc: 'Best general retrieval (~335MB). Top MTEB scores.',
    quantized: false,
  },
};

export const EMBEDDING_STRATEGIES = ['structured', 'source'];

export const DEFAULT_MODEL = 'nomic-v1.5';
const BATCH_SIZE_MAP = {
  minilm: 32,
  'jina-small': 16,
  'jina-base': 8,
  'jina-code': 8,
  nomic: 8,
  'nomic-v1.5': 8,
  'bge-large': 4,
};
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
 * Rough token estimate (~4 chars per token for code/English).
 * Conservative — avoids adding a tokenizer dependency.
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Extract leading comment text (JSDoc, //, #, etc.) above a function line.
 * Returns the cleaned comment text or null if none found.
 */
function extractLeadingComment(lines, fnLineIndex) {
  if (fnLineIndex > lines.length) return null;
  const raw = [];
  for (let i = fnLineIndex - 1; i >= Math.max(0, fnLineIndex - 15); i--) {
    if (i >= lines.length) continue;
    const trimmed = lines[i].trim();
    if (/^(\/\/|\/\*|\*\/|\*|#|\/\/\/)/.test(trimmed)) {
      raw.unshift(trimmed);
    } else if (trimmed === '') {
      if (raw.length > 0) break;
    } else {
      break;
    }
  }
  if (raw.length === 0) return null;
  return raw
    .map((line) =>
      line
        .replace(/^\/\*\*?\s?|\*\/$/g, '') // opening /** or /* and closing */
        .replace(/^\*\s?/, '') // middle * lines
        .replace(/^\/\/\/?\s?/, '') // // or ///
        .replace(/^#\s?/, '') // # (Python/Ruby)
        .trim(),
    )
    .filter((l) => l.length > 0)
    .join(' ');
}

/**
 * Build graph-enriched text for a symbol using dependency context.
 * Produces compact, semantic text (~100 tokens) instead of full source code.
 */
function buildStructuredText(node, file, lines, calleesStmt, callersStmt) {
  const readable = splitIdentifier(node.name);
  const parts = [`${node.kind} ${node.name} (${readable}) in ${file}`];
  const startLine = Math.max(0, node.line - 1);

  // Extract parameters from signature (best-effort, single-line)
  const sigLine = lines[startLine] || '';
  const paramMatch = sigLine.match(/\(([^)]*)\)/);
  if (paramMatch?.[1]?.trim()) {
    parts.push(`Parameters: ${paramMatch[1].trim()}`);
  }

  // Graph context: callees (capped at 10)
  const callees = calleesStmt.all(node.id);
  if (callees.length > 0) {
    parts.push(
      `Calls: ${callees
        .slice(0, 10)
        .map((c) => c.name)
        .join(', ')}`,
    );
  }

  // Graph context: callers (capped at 10)
  const callers = callersStmt.all(node.id);
  if (callers.length > 0) {
    parts.push(
      `Called by: ${callers
        .slice(0, 10)
        .map((c) => c.name)
        .join(', ')}`,
    );
  }

  // Leading comment (high semantic value) or first few lines of code
  const comment = extractLeadingComment(lines, startLine);
  if (comment) {
    parts.push(comment);
  } else {
    const endLine = Math.min(lines.length, startLine + 4);
    const snippet = lines.slice(startLine, endLine).join('\n').trim();
    if (snippet) parts.push(snippet);
  }

  return parts.join('\n');
}

/**
 * Build raw source-code text for a symbol (original strategy).
 */
function buildSourceText(node, file, lines) {
  const startLine = Math.max(0, node.line - 1);
  const endLine = node.end_line
    ? Math.min(lines.length, node.end_line)
    : Math.min(lines.length, startLine + 15);
  const context = lines.slice(startLine, endLine).join('\n');
  const readable = splitIdentifier(node.name);
  return `${node.kind} ${node.name} (${readable}) in ${file}\n${context}`;
}

/**
 * Prompt the user to install a missing package interactively.
 * Returns true if the package was installed, false otherwise.
 * Skips the prompt entirely in non-TTY environments (CI, piped stdin).
 */
function promptInstall(packageName) {
  if (!process.stdin.isTTY) return Promise.resolve(false);

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`Semantic search requires ${packageName}. Install it now? [y/N] `, (answer) => {
      rl.close();
      if (answer.trim().toLowerCase() !== 'y') return resolve(false);
      try {
        execFileSync('npm', ['install', packageName], {
          stdio: 'inherit',
          timeout: 300_000,
        });
        resolve(true);
      } catch {
        resolve(false);
      }
    });
  });
}

/**
 * Lazy-load @huggingface/transformers.
 * If the package is missing, prompts the user to install it interactively.
 * In non-TTY environments, prints an error and exits.
 */
async function loadTransformers() {
  try {
    return await import('@huggingface/transformers');
  } catch {
    const pkg = '@huggingface/transformers';
    const installed = await promptInstall(pkg);
    if (installed) {
      try {
        return await import(pkg);
      } catch {
        console.error(`\n${pkg} was installed but failed to load. Please check your environment.`);
        process.exit(1);
      }
    }
    console.error(`Semantic search requires ${pkg}.\n` + `Install it with: npm install ${pkg}`);
    process.exit(1);
  }
}

/**
 * Dispose the current ONNX session and free memory.
 * Safe to call when no model is loaded (no-op).
 */
export async function disposeModel() {
  if (extractor) {
    await extractor.dispose();
    extractor = null;
  }
  activeModel = null;
}

async function loadModel(modelKey) {
  const config = getModelConfig(modelKey);

  if (extractor && activeModel === config.name) return { extractor, config };

  // Dispose previous model before loading a different one
  await disposeModel();

  const transformers = await loadTransformers();
  pipeline = transformers.pipeline;
  _cos_sim = transformers.cos_sim;

  info(`Loading embedding model: ${config.name} (${config.dim}d)...`);
  const pipelineOpts = config.quantized ? { quantized: true } : {};
  try {
    extractor = await pipeline('feature-extraction', config.name, pipelineOpts);
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes('Unauthorized') || msg.includes('401') || msg.includes('gated')) {
      console.error(
        `\nModel "${config.name}" requires authentication.\n` +
          `This model is gated on HuggingFace and needs an access token.\n\n` +
          `Options:\n` +
          `  1. Set HF_TOKEN env var: export HF_TOKEN=hf_...\n` +
          `  2. Use a public model instead: codegraph embed --model minilm\n`,
      );
    } else {
      console.error(
        `\nFailed to load model "${config.name}": ${msg}\n` +
          `Try a different model: codegraph embed --model minilm\n`,
      );
    }
    process.exit(1);
  }
  activeModel = config.name;
  info('Model loaded.');
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
  let dot = 0,
    normA = 0,
    normB = 0;
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
    console.error(
      `No codegraph database found at ${dbPath}.\n` +
        `Run "codegraph build" first to analyze your codebase.`,
    );
    process.exit(1);
  }

  const db = new Database(dbPath);
  initEmbeddingsSchema(db);

  db.exec('DELETE FROM embeddings');
  db.exec('DELETE FROM embedding_meta');

  const nodes = db
    .prepare(
      `SELECT * FROM nodes WHERE kind IN ('function', 'method', 'class') ORDER BY file, line`,
    )
    .all();

  console.log(`Building embeddings for ${nodes.length} symbols (strategy: ${strategy})...`);

  // Prepare graph-context queries for structured strategy
  let calleesStmt, callersStmt;
  if (strategy === 'structured') {
    calleesStmt = db.prepare(`
      SELECT DISTINCT n.name FROM edges e
      JOIN nodes n ON e.target_id = n.id
      WHERE e.source_id = ? AND e.kind = 'calls'
      ORDER BY n.name
    `);
    callersStmt = db.prepare(`
      SELECT DISTINCT n.name FROM edges e
      JOIN nodes n ON e.source_id = n.id
      WHERE e.target_id = ? AND e.kind = 'calls'
      ORDER BY n.name
    `);
  }

  const byFile = new Map();
  for (const node of nodes) {
    if (!byFile.has(node.file)) byFile.set(node.file, []);
    byFile.get(node.file).push(node);
  }

  const texts = [];
  const nodeIds = [];
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
          ? buildStructuredText(node, file, lines, calleesStmt, callersStmt)
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
    'INSERT OR REPLACE INTO embeddings (node_id, vector, text_preview) VALUES (?, ?, ?)',
  );
  const insertMeta = db.prepare('INSERT OR REPLACE INTO embedding_meta (key, value) VALUES (?, ?)');
  const insertAll = db.transaction(() => {
    for (let i = 0; i < vectors.length; i++) {
      insert.run(nodeIds[i], Buffer.from(vectors[i].buffer), previews[i]);
    }
    insertMeta.run('model', config.name);
    insertMeta.run('dim', String(dim));
    insertMeta.run('count', String(vectors.length));
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
    count = db.prepare('SELECT COUNT(*) as c FROM embeddings').get().c;
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
    if (dimRow) storedDim = parseInt(dimRow.value, 10);
  } catch {
    /* old DB without meta table */
  }

  let modelKey = opts.model || null;
  if (!modelKey && storedModel) {
    for (const [key, config] of Object.entries(MODELS)) {
      if (config.name === storedModel) {
        modelKey = key;
        break;
      }
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
  const isGlob = opts.filePattern && /[*?[\]]/.test(opts.filePattern);
  if (opts.filePattern && !isGlob) {
    conditions.push('n.file LIKE ?');
    params.push(`%${opts.filePattern}%`);
  }
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(' AND ')}`;
  }

  let rows = db.prepare(sql).all(...params);
  if (isGlob) {
    rows = rows.filter((row) => globMatch(row.file, opts.filePattern));
  }
  if (noTests) {
    rows = rows.filter((row) => !TEST_PATTERN.test(row.file));
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

  const {
    vectors: [queryVec],
    dim,
  } = await embed([query], modelKey);

  if (storedDim && dim !== storedDim) {
    console.log(
      `Warning: query model dimension (${dim}) doesn't match stored embeddings (${storedDim}).`,
    );
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
        similarity: sim,
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
            `Consider using more distinct queries.`,
        );
      }
    }
  }

  if (storedDim && dim !== storedDim) {
    console.log(
      `Warning: query model dimension (${dim}) doesn't match stored embeddings (${storedDim}).`,
    );
    console.log(`  Re-run \`codegraph embed\` with the same model, or use --model to match.`);
    db.close();
    return null;
  }

  // Parse row vectors once
  const rowVecs = rows.map((row) => new Float32Array(new Uint8Array(row.vector).buffer));

  // For each query: compute similarities, filter by minScore, rank
  const perQueryRanked = queries.map((_query, qi) => {
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
        rank: item.rank,
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
      queryScores: entry.queryScores,
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
  const queries = query
    .split(';')
    .map((q) => q.trim())
    .filter((q) => q.length > 0);

  if (queries.length <= 1) {
    // Single-query path — preserve original output format
    const singleQuery = queries[0] || query;
    const data = await searchData(singleQuery, customDbPath, opts);
    if (!data) return;

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

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

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    console.log(`\nMulti-query semantic search (RRF, k=${opts.rrfK || 60}):`);
    queries.forEach((q, i) => {
      console.log(`  [${i + 1}] "${q}"`);
    });
    console.log();

    if (data.results.length === 0) {
      console.log('  No results above threshold.');
    } else {
      for (const r of data.results) {
        const kindIcon = r.kind === 'function' ? 'f' : r.kind === 'class' ? '*' : 'o';
        console.log(`  RRF ${r.rrf.toFixed(4)}  ${kindIcon} ${r.name} -- ${r.file}:${r.line}`);
        for (const qs of r.queryScores) {
          const bar = '#'.repeat(Math.round(qs.similarity * 20));
          console.log(
            `    [${queries.indexOf(qs.query) + 1}] ${(qs.similarity * 100).toFixed(1)}% ${bar} (rank ${qs.rank})`,
          );
        }
      }
    }

    console.log(`\n  ${data.results.length} results shown\n`);
  }
}
