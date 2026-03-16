import { warn } from '../../../infrastructure/logger.js';
import { normalizeSymbol } from '../../queries.js';
import { embed } from '../models.js';
import { cosineSim } from '../stores/sqlite-blob.js';
import { prepareSearch } from './prepare.js';

/**
 * Single-query semantic search — returns data instead of printing.
 * Returns { results: [{ name, kind, file, line, similarity }] } or null on failure.
 */
export async function searchData(query, customDbPath, opts = {}) {
  const limit = opts.limit || 15;
  const minScore = opts.minScore || 0.2;

  const prepared = prepareSearch(customDbPath, opts);
  if (!prepared) return null;
  const { db, rows, modelKey, storedDim } = prepared;

  try {
    const {
      vectors: [queryVec],
      dim,
    } = await embed([query], modelKey);

    if (storedDim && dim !== storedDim) {
      console.log(
        `Warning: query model dimension (${dim}) doesn't match stored embeddings (${storedDim}).`,
      );
      console.log(`  Re-run \`codegraph embed\` with the same model, or use --model to match.`);
      return null;
    }

    const hc = new Map();
    const results = [];
    for (const row of rows) {
      const vec = new Float32Array(new Uint8Array(row.vector).buffer);
      const sim = cosineSim(queryVec, vec);

      if (sim >= minScore) {
        results.push({
          ...normalizeSymbol(row, db, hc),
          similarity: sim,
        });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return { results: results.slice(0, limit) };
  } finally {
    db.close();
  }
}

/**
 * Multi-query semantic search with Reciprocal Rank Fusion (RRF).
 * Returns { results: [{ name, kind, file, line, rrf, queryScores }] } or null on failure.
 */
export async function multiSearchData(queries, customDbPath, opts = {}) {
  const limit = opts.limit || 15;
  const minScore = opts.minScore || 0.2;
  const k = opts.rrfK || 60;

  const prepared = prepareSearch(customDbPath, opts);
  if (!prepared) return null;
  const { db, rows, modelKey, storedDim } = prepared;

  try {
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
    const hc = new Map();
    const results = [];
    for (const [rowIndex, entry] of fusionMap) {
      const row = rows[rowIndex];
      results.push({
        ...normalizeSymbol(row, db, hc),
        rrf: entry.rrfScore,
        queryScores: entry.queryScores,
      });
    }

    results.sort((a, b) => b.rrf - a.rrf);
    return { results: results.slice(0, limit) };
  } finally {
    db.close();
  }
}
