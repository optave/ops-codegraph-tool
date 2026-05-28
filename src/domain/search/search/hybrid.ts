import { openReadonlyOrFail } from '../../../db/index.js';
import { loadConfig } from '../../../infrastructure/config.js';
import type { BetterSqlite3Database, CodegraphConfig } from '../../../types.js';
import { hasFtsIndex } from '../stores/fts5.js';
import { ftsSearchData } from './keyword.js';
import type { SemanticSearchOpts } from './semantic.js';
import { searchData } from './semantic.js';

interface HybridResult {
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine: number | null;
  role: string | null;
  fileHash: string | null;
  rrf: number;
  bm25Score: number | null;
  bm25Rank: number | null;
  similarity: number | null;
  semanticRank: number | null;
}

export interface HybridSearchResult {
  results: HybridResult[];
}

interface RankedItem {
  key: string;
  rank: number;
  source: 'bm25' | 'semantic';
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine?: number | null;
  role?: string | null;
  fileHash?: string | null;
  bm25Score?: number;
  similarity?: number;
}

interface FusionEntry {
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine: number | null;
  role: string | null;
  fileHash: string | null;
  rrfScore: number;
  bm25Score: number | null;
  bm25Rank: number | null;
  similarity: number | null;
  semanticRank: number | null;
}

/** Parse a semicolon-delimited query string into individual queries. */
function parseQueries(query: string): string[] {
  return query
    .split(';')
    .map((q) => q.trim())
    .filter((q) => q.length > 0);
}

/** Collect BM25 and semantic ranked lists for each query. */
async function collectRankedLists(
  queries: string[],
  customDbPath: string | undefined,
  opts: SemanticSearchOpts,
  topK: number,
): Promise<RankedItem[][]> {
  const rankedLists: RankedItem[][] = [];

  for (const q of queries) {
    const bm25Data = ftsSearchData(q, customDbPath, { ...opts, limit: topK });
    if (bm25Data?.results) {
      rankedLists.push(
        bm25Data.results.map((r, idx) => ({
          key: `${r.name}:${r.file}:${r.line}`,
          rank: idx + 1,
          source: 'bm25' as const,
          ...r,
        })),
      );
    }

    const semData = await searchData(q, customDbPath, {
      ...opts,
      limit: topK,
      minScore: opts.minScore ?? 0.2,
    });
    if (semData?.results) {
      rankedLists.push(
        semData.results.map((r, idx) => ({
          key: `${r.name}:${r.file}:${r.line}`,
          rank: idx + 1,
          source: 'semantic' as const,
          ...r,
        })),
      );
    }
  }

  return rankedLists;
}

/** Initialise a fusion entry seeded from the first ranked item we see for a key. */
function createFusionEntry(item: RankedItem): FusionEntry {
  return {
    name: item.name,
    kind: item.kind,
    file: item.file,
    line: item.line,
    endLine: (item.endLine as number | null) ?? null,
    role: (item.role as string | null) ?? null,
    fileHash: (item.fileHash as string | null) ?? null,
    rrfScore: 0,
    bm25Score: null,
    bm25Rank: null,
    similarity: null,
    semanticRank: null,
  };
}

/** Merge a single ranked item into its fusion entry: update RRF and best per-source rank. */
function mergeRankedItem(entry: FusionEntry, item: RankedItem, k: number): void {
  entry.rrfScore += 1 / (k + item.rank);
  if (item.source === 'bm25') {
    if (entry.bm25Rank === null || item.rank < entry.bm25Rank) {
      entry.bm25Score = item.bm25Score ?? null;
      entry.bm25Rank = item.rank;
    }
  } else if (entry.semanticRank === null || item.rank < entry.semanticRank) {
    entry.similarity = item.similarity ?? null;
    entry.semanticRank = item.rank;
  }
}

/** Flatten a fusion entry into the public-facing hybrid result shape. */
function toHybridResult(e: FusionEntry): HybridResult {
  return {
    name: e.name,
    kind: e.kind,
    file: e.file,
    line: e.line,
    endLine: e.endLine,
    role: e.role,
    fileHash: e.fileHash,
    rrf: e.rrfScore,
    bm25Score: e.bm25Score,
    bm25Rank: e.bm25Rank,
    similarity: e.similarity,
    semanticRank: e.semanticRank,
  };
}

/** Reciprocal Rank Fusion: merge ranked lists into a single scored result set. */
function fuseResults(rankedLists: RankedItem[][], k: number, limit: number): HybridResult[] {
  const fusionMap = new Map<string, FusionEntry>();
  for (const list of rankedLists) {
    for (const item of list) {
      if (!fusionMap.has(item.key)) {
        fusionMap.set(item.key, createFusionEntry(item));
      }
      mergeRankedItem(fusionMap.get(item.key)!, item, k);
    }
  }

  return [...fusionMap.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit)
    .map(toHybridResult);
}

export async function hybridSearchData(
  query: string,
  customDbPath: string | undefined,
  opts: SemanticSearchOpts = {},
): Promise<HybridSearchResult | null> {
  const config = opts.config || loadConfig();
  const searchCfg = config.search || ({} as CodegraphConfig['search']);
  const limit = opts.limit ?? searchCfg.topK ?? 15;
  const k = opts.rrfK ?? searchCfg.rrfK ?? 60;
  const topK = (opts.limit ?? searchCfg.topK ?? 15) * 5;

  const checkDb = openReadonlyOrFail(customDbPath) as BetterSqlite3Database;
  const ftsAvailable = hasFtsIndex(checkDb);
  checkDb.close();
  if (!ftsAvailable) return null;

  const queries = parseQueries(query);
  const rankedLists = await collectRankedLists(queries, customDbPath, opts, topK);
  const results = fuseResults(rankedLists, k, limit);

  return { results };
}
