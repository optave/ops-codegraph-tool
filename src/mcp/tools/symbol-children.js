import { effectiveOffset, MCP_DEFAULTS } from '../middleware.js';

export const name = 'symbol_children';

export async function handler(args, ctx) {
  const { childrenData } = await ctx.getQueries();
  return childrenData(args.name, ctx.dbPath, {
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
    limit: Math.min(args.limit ?? MCP_DEFAULTS.context, ctx.MCP_MAX_LIMIT),
    offset: effectiveOffset(args),
  });
}
