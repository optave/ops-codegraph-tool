import { warn } from '../../../infrastructure/logger.js';
import { hybridSearchData } from './hybrid.js';
import { ftsSearchData } from './keyword.js';
import { multiSearchData, searchData } from './semantic.js';

/**
 * Search with mode support — CLI wrapper with multi-query detection.
 * Modes: 'hybrid' (default), 'semantic', 'keyword'
 */
export async function search(query, customDbPath, opts = {}) {
  const mode = opts.mode || 'hybrid';

  // Split by semicolons, trim, filter empties
  const queries = query
    .split(';')
    .map((q) => q.trim())
    .filter((q) => q.length > 0);

  const kindIcon = (kind) => (kind === 'function' ? 'f' : kind === 'class' ? '*' : 'o');

  // ─── Keyword-only mode ──────────────────────────────────────────────
  if (mode === 'keyword') {
    const singleQuery = queries.length === 1 ? queries[0] : query;
    const data = ftsSearchData(singleQuery, customDbPath, opts);
    if (!data) {
      console.log('No FTS5 index found. Run `codegraph embed` to build the keyword index.');
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    console.log(`\nKeyword search: "${singleQuery}" (BM25)\n`);
    if (data.results.length === 0) {
      console.log('  No results found.');
    } else {
      for (const r of data.results) {
        console.log(
          `  BM25 ${r.bm25Score.toFixed(2)}  ${kindIcon(r.kind)} ${r.name} -- ${r.file}:${r.line}`,
        );
      }
    }
    console.log(`\n  ${data.results.length} results shown\n`);
    return;
  }

  // ─── Semantic-only mode ─────────────────────────────────────────────
  if (mode === 'semantic') {
    if (queries.length <= 1) {
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
          console.log(`  ${(r.similarity * 100).toFixed(1)}% ${bar}`);
          console.log(`    ${kindIcon(r.kind)} ${r.name} -- ${r.file}:${r.line}`);
        }
      }
      console.log(`\n  ${data.results.length} results shown\n`);
    } else {
      const data = await multiSearchData(queries, customDbPath, opts);
      if (!data) return;

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      console.log(`\nMulti-query semantic search (RRF, k=${opts.rrfK || 60}):`);
      for (let i = 0; i < queries.length; i++) console.log(`  [${i + 1}] "${queries[i]}"`);
      console.log();
      if (data.results.length === 0) {
        console.log('  No results above threshold.');
      } else {
        for (const r of data.results) {
          console.log(
            `  RRF ${r.rrf.toFixed(4)}  ${kindIcon(r.kind)} ${r.name} -- ${r.file}:${r.line}`,
          );
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
    return;
  }

  // ─── Hybrid mode (default) ──────────────────────────────────────────
  const data = await hybridSearchData(query, customDbPath, opts);

  if (!data) {
    // No FTS5 index — fall back to semantic-only
    warn(
      'FTS5 index not found — using semantic search only. Re-run `codegraph embed` to enable hybrid mode.',
    );
    return search(query, customDbPath, { ...opts, mode: 'semantic' });
  }

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const rrfK = opts.rrfK || 60;
  if (queries.length <= 1) {
    const singleQuery = queries[0] || query;
    console.log(`\nHybrid search: "${singleQuery}" (BM25 + semantic, RRF k=${rrfK})\n`);
  } else {
    console.log(`\nHybrid multi-query search (BM25 + semantic, RRF k=${rrfK}):`);
    for (let i = 0; i < queries.length; i++) console.log(`  [${i + 1}] "${queries[i]}"`);
    console.log();
  }

  if (data.results.length === 0) {
    console.log('  No results found.');
  } else {
    for (const r of data.results) {
      console.log(
        `  RRF ${r.rrf.toFixed(4)}  ${kindIcon(r.kind)} ${r.name} -- ${r.file}:${r.line}`,
      );
      const parts = [];
      if (r.bm25Rank != null) {
        parts.push(`BM25: rank ${r.bm25Rank} (score ${r.bm25Score.toFixed(2)})`);
      }
      if (r.semanticRank != null) {
        parts.push(`Semantic: rank ${r.semanticRank} (${(r.similarity * 100).toFixed(1)}%)`);
      }
      if (parts.length > 0) {
        console.log(`    ${parts.join('  |  ')}`);
      }
    }
  }

  console.log(`\n  ${data.results.length} results shown\n`);
}
