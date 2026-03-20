import { effectiveOffset, MCP_DEFAULTS, MCP_MAX_LIMIT } from '../middleware.js';

export const name = 'semantic_search';

export async function handler(args, ctx) {
  const mode = args.mode || 'hybrid';
  const searchOpts = {
    limit: Math.min(args.limit ?? MCP_DEFAULTS.semantic_search, MCP_MAX_LIMIT),
    offset: effectiveOffset(args),
    minScore: args.min_score,
  };

  if (mode === 'keyword') {
    const { ftsSearchData } = await import('../../domain/search/index.js');
    const result = ftsSearchData(args.query, ctx.dbPath, searchOpts);
    if (result === null) {
      return {
        content: [
          {
            type: 'text',
            text: 'No FTS5 index found. Run `codegraph embed` to build the keyword index.',
          },
        ],
        isError: true,
      };
    }
    return result;
  }

  if (mode === 'semantic') {
    const { searchData } = await import('../../domain/search/index.js');
    const result = await searchData(args.query, ctx.dbPath, searchOpts);
    if (result === null) {
      return {
        content: [
          {
            type: 'text',
            text: 'Semantic search unavailable. Run `codegraph embed` first.',
          },
        ],
        isError: true,
      };
    }
    return result;
  }

  // hybrid (default) — falls back to semantic if no FTS5
  const { hybridSearchData, searchData } = await import('../../domain/search/index.js');
  let result = await hybridSearchData(args.query, ctx.dbPath, searchOpts);
  if (result === null) {
    result = await searchData(args.query, ctx.dbPath, searchOpts);
    if (result === null) {
      return {
        content: [
          {
            type: 'text',
            text: 'Semantic search unavailable. Run `codegraph embed` first.',
          },
        ],
        isError: true,
      };
    }
  }
  return result;
}
