import { loadConfig } from '../../../infrastructure/config.js';
import { warn } from '../../../infrastructure/logger.js';
import type { BetterSqlite3Database, CodegraphConfig } from '../../../types.js';
import { normalizeSymbol } from '../../queries.js';
import { embed } from '../models.js';
import { cosineSim } from '../stores/sqlite-blob.js';
import { type PreparedSearch, prepareSearch } from './prepare.js';

export interface SemanticSearchOpts {
  config?: CodegraphConfig;
  limit?: number;
  minScore?: number;
  model?: string;
  kind?: string;
  filePattern?: string | string[];
  noTests?: boolean;
  rrfK?: number;
}

interface SemanticResult {
  name: string;
  kind: string;
  file: string;
  line: number;
  similarity: number;
  [key: string]: unknown;
}

export interface SearchDataResult {
  results: SemanticResult[];
}

type StoredRow = PreparedSearch['rows'][number];

/** Reconstitute a stored embedding row's vector blob into a Float32Array. */
function rowVector(row: StoredRow): Float32Array {
  return new Float32Array(new Uint8Array(row.vector as unknown as ArrayBuffer).buffer);
}

/** Warn when stored embeddings and the query model use different dimensions. */
function checkDimensionMismatch(storedDim: number | null, dim: number): boolean {
  if (storedDim && dim !== storedDim) {
    console.log(
      `Warning: query model dimension (${dim}) doesn't match stored embeddings (${storedDim}).`,
    );
    console.log(`  Re-run \`codegraph embed\` with the same model, or use --model to match.`);
    return true;
  }
  return false;
}

export async function searchData(
  query: string,
  customDbPath: string | undefined,
  opts: SemanticSearchOpts = {},
): Promise<SearchDataResult | null> {
  const config = opts.config || loadConfig();
  const searchCfg = config.search || ({} as CodegraphConfig['search']);
  const limit = opts.limit ?? searchCfg.topK ?? 15;
  const minScore = opts.minScore ?? searchCfg.defaultMinScore ?? 0.2;

  const prepared = prepareSearch(customDbPath, opts);
  if (!prepared) return null;
  const { db, rows, modelKey, storedDim } = prepared;

  try {
    const {
      vectors: [queryVec],
      dim,
    } = await embed([query], modelKey ?? undefined);

    if (checkDimensionMismatch(storedDim, dim)) return null;

    const hc = new Map<string, string>();
    const results: SemanticResult[] = [];
    for (const row of rows) {
      const sim = cosineSim(queryVec!, rowVector(row));
      if (sim >= minScore) {
        results.push({
          ...normalizeSymbol(row, db as BetterSqlite3Database, hc),
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

export interface MultiSearchResult {
  results: Array<{
    name: string;
    kind: string;
    file: string;
    line: number;
    rrf: number;
    queryScores: Array<{ query: string; similarity: number; rank: number }>;
    [key: string]: unknown;
  }>;
}

interface RankedHit {
  rowIndex: number;
  similarity: number;
  rank: number;
}

interface FusionEntry {
  rrfScore: number;
  queryScores: Array<{ query: string; similarity: number; rank: number }>;
}

/**
 * Emit a warning for any query pair whose embeddings are nearly identical,
 * since RRF would over-weight matches shared between them.
 */
function warnOnSimilarQueries(
  queries: string[],
  queryVecs: Float32Array[],
  threshold: number,
): void {
  for (let i = 0; i < queryVecs.length; i++) {
    for (let j = i + 1; j < queryVecs.length; j++) {
      const sim = cosineSim(queryVecs[i]!, queryVecs[j]!);
      if (sim >= threshold) {
        warn(
          `Queries "${queries[i]}" and "${queries[j]}" are very similar ` +
            `(${(sim * 100).toFixed(0)}% cosine similarity). ` +
            `This may bias RRF results toward their shared matches. ` +
            `Consider using more distinct queries.`,
        );
      }
    }
  }
}

/** Rank stored rows for a single query, keeping only those above minScore. */
function rankRowsForQuery(
  queryVec: Float32Array,
  rowVecs: Float32Array[],
  minScore: number,
): RankedHit[] {
  const scored: Array<{ rowIndex: number; similarity: number }> = [];
  for (let ri = 0; ri < rowVecs.length; ri++) {
    const sim = cosineSim(queryVec, rowVecs[ri]!);
    if (sim >= minScore) {
      scored.push({ rowIndex: ri, similarity: sim });
    }
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.map((item, rank) => ({ ...item, rank: rank + 1 }));
}

/** Reciprocal Rank Fusion across each query's ranked hits. */
function fuseRankedHits(
  queries: string[],
  perQueryRanked: RankedHit[][],
  k: number,
): Map<number, FusionEntry> {
  const fusionMap = new Map<number, FusionEntry>();
  for (let qi = 0; qi < queries.length; qi++) {
    for (const item of perQueryRanked[qi]!) {
      if (!fusionMap.has(item.rowIndex)) {
        fusionMap.set(item.rowIndex, { rrfScore: 0, queryScores: [] });
      }
      const entry = fusionMap.get(item.rowIndex)!;
      entry.rrfScore += 1 / (k + item.rank);
      entry.queryScores.push({
        query: queries[qi]!,
        similarity: item.similarity,
        rank: item.rank,
      });
    }
  }
  return fusionMap;
}

export async function multiSearchData(
  queries: string[],
  customDbPath: string | undefined,
  opts: SemanticSearchOpts = {},
): Promise<MultiSearchResult | null> {
  const config = opts.config || loadConfig();
  const searchCfg = config.search || ({} as CodegraphConfig['search']);
  const limit = opts.limit ?? searchCfg.topK ?? 15;
  const minScore = opts.minScore ?? searchCfg.defaultMinScore ?? 0.2;
  const k = opts.rrfK ?? searchCfg.rrfK ?? 60;
  const similarityWarnThreshold = searchCfg.similarityWarnThreshold ?? 0.85;

  const prepared = prepareSearch(customDbPath, opts);
  if (!prepared) return null;
  const { db, rows, modelKey, storedDim } = prepared;

  try {
    const { vectors: queryVecs, dim } = await embed(queries, modelKey ?? undefined);

    warnOnSimilarQueries(queries, queryVecs as Float32Array[], similarityWarnThreshold);

    if (checkDimensionMismatch(storedDim, dim)) return null;

    const rowVecs = rows.map(rowVector);
    const perQueryRanked = queries.map((_q, qi) =>
      rankRowsForQuery(queryVecs[qi]!, rowVecs, minScore),
    );
    const fusionMap = fuseRankedHits(queries, perQueryRanked, k);

    const hc = new Map<string, string>();
    const results: MultiSearchResult['results'] = [];
    for (const [rowIndex, entry] of fusionMap) {
      const row = rows[rowIndex]!;
      results.push({
        ...normalizeSymbol(row, db as BetterSqlite3Database, hc),
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
