import { loadConfig } from '../../../infrastructure/config.js';
import { warn } from '../../../infrastructure/logger.js';
import type { BetterSqlite3Database, CodegraphConfig } from '../../../types.js';
import { normalizeSymbol } from '../../queries.js';
import { embed } from '../models.js';
import { cosineSim } from '../stores/sqlite-blob.js';
import { prepareSearch } from './prepare.js';

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

    if (storedDim && dim !== storedDim) {
      console.log(
        `Warning: query model dimension (${dim}) doesn't match stored embeddings (${storedDim}).`,
      );
      console.log(`  Re-run \`codegraph embed\` with the same model, or use --model to match.`);
      return null;
    }

    const hc = new Map<string, string>();
    const results: SemanticResult[] = [];
    for (const row of rows) {
      const vec = new Float32Array(new Uint8Array(row.vector as unknown as ArrayBuffer).buffer);
      const sim = cosineSim(queryVec!, vec);

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

  const prepared = prepareSearch(customDbPath, opts);
  if (!prepared) return null;
  const { db, rows, modelKey, storedDim } = prepared;

  try {
    const { vectors: queryVecs, dim } = await embed(queries, modelKey ?? undefined);

    const SIMILARITY_WARN_THRESHOLD = searchCfg.similarityWarnThreshold ?? 0.85;
    for (let i = 0; i < queryVecs.length; i++) {
      for (let j = i + 1; j < queryVecs.length; j++) {
        const sim = cosineSim(queryVecs[i]!, queryVecs[j]!);
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

    const rowVecs = rows.map(
      (row) => new Float32Array(new Uint8Array(row.vector as unknown as ArrayBuffer).buffer),
    );

    const perQueryRanked = queries.map((_query, qi) => {
      const scored: Array<{ rowIndex: number; similarity: number }> = [];
      for (let ri = 0; ri < rows.length; ri++) {
        const sim = cosineSim(queryVecs[qi]!, rowVecs[ri]!);
        if (sim >= minScore) {
          scored.push({ rowIndex: ri, similarity: sim });
        }
      }
      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.map((item, rank) => ({ ...item, rank: rank + 1 }));
    });

    const fusionMap = new Map<
      number,
      { rrfScore: number; queryScores: Array<{ query: string; similarity: number; rank: number }> }
    >();
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
