import { openReadonlyOrFail } from '../../db.js';
import { hasFtsIndex } from '../stores/fts5.js';
import { ftsSearchData } from './keyword.js';
import { searchData } from './semantic.js';

/**
 * Hybrid BM25 + semantic search with RRF fusion.
 * Returns { results: [{ name, kind, file, line, rrf, bm25Score, bm25Rank, similarity, semanticRank }] }
 * or null if no FTS5 index (caller should fall back to semantic-only).
 */
export async function hybridSearchData(query, customDbPath, opts = {}) {
  const limit = opts.limit || 15;
  const k = opts.rrfK || 60;
  const topK = (opts.limit || 15) * 5;

  // Split semicolons for multi-query support
  const queries =
    typeof query === 'string'
      ? query
          .split(';')
          .map((q) => q.trim())
          .filter((q) => q.length > 0)
      : [query];

  // Check FTS5 availability first (sync, cheap)
  const checkDb = openReadonlyOrFail(customDbPath);
  const ftsAvailable = hasFtsIndex(checkDb);
  checkDb.close();
  if (!ftsAvailable) return null;

  // Collect ranked lists: for each query, one BM25 list + one semantic list
  const rankedLists = [];

  for (const q of queries) {
    // BM25 ranked list (sync)
    const bm25Data = ftsSearchData(q, customDbPath, { ...opts, limit: topK });
    if (bm25Data?.results) {
      rankedLists.push(
        bm25Data.results.map((r, idx) => ({
          key: `${r.name}:${r.file}:${r.line}`,
          rank: idx + 1,
          source: 'bm25',
          ...r,
        })),
      );
    }

    // Semantic ranked list (async)
    const semData = await searchData(q, customDbPath, {
      ...opts,
      limit: topK,
      minScore: opts.minScore || 0.2,
    });
    if (semData?.results) {
      rankedLists.push(
        semData.results.map((r, idx) => ({
          key: `${r.name}:${r.file}:${r.line}`,
          rank: idx + 1,
          source: 'semantic',
          ...r,
        })),
      );
    }
  }

  // RRF fusion across all ranked lists
  const fusionMap = new Map();
  for (const list of rankedLists) {
    for (const item of list) {
      if (!fusionMap.has(item.key)) {
        fusionMap.set(item.key, {
          name: item.name,
          kind: item.kind,
          file: item.file,
          line: item.line,
          endLine: item.endLine ?? null,
          role: item.role ?? null,
          fileHash: item.fileHash ?? null,
          rrfScore: 0,
          bm25Score: null,
          bm25Rank: null,
          similarity: null,
          semanticRank: null,
        });
      }
      const entry = fusionMap.get(item.key);
      entry.rrfScore += 1 / (k + item.rank);
      if (item.source === 'bm25') {
        if (entry.bm25Rank === null || item.rank < entry.bm25Rank) {
          entry.bm25Score = item.bm25Score;
          entry.bm25Rank = item.rank;
        }
      } else {
        if (entry.semanticRank === null || item.rank < entry.semanticRank) {
          entry.similarity = item.similarity;
          entry.semanticRank = item.rank;
        }
      }
    }
  }

  const results = [...fusionMap.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit)
    .map((e) => ({
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
    }));

  return { results };
}
