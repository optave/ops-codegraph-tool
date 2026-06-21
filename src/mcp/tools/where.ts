import { effectiveLimit, effectiveOffset } from '../middleware.js';
import type { McpToolContext } from '../types.js';

export const name = 'where';

interface WhereArgs {
  target: string;
  file_mode?: string;
  no_tests?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: WhereArgs, ctx: McpToolContext): Promise<unknown> {
  const { whereData } = await ctx.getQueries();
  return whereData(args.target, ctx.dbPath, {
    file: args.file_mode,
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
