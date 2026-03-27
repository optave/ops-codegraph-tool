import { effectiveOffset, MCP_DEFAULTS } from '../middleware.js';
import type { McpToolContext } from '../server.js';

export const name = 'symbol_children';

interface SymbolChildrenArgs {
  name: string;
  file?: string;
  kind?: string;
  no_tests?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: SymbolChildrenArgs, ctx: McpToolContext): Promise<unknown> {
  const { childrenData } = await ctx.getQueries();
  return childrenData(args.name, ctx.dbPath, {
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
    limit: Math.min(args.limit ?? MCP_DEFAULTS.context ?? 100, ctx.MCP_MAX_LIMIT),
    offset: effectiveOffset(args),
  });
}
