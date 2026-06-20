import { effectiveLimit, effectiveOffset } from '../middleware.js';
import type { McpToolContext } from '../types.js';

export const name = 'list_functions';

interface ListFunctionsArgs {
  file?: string;
  pattern?: string;
  no_tests?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: ListFunctionsArgs, ctx: McpToolContext): Promise<unknown> {
  const { listFunctionsData } = await ctx.getQueries();
  return listFunctionsData(ctx.dbPath, {
    file: args.file,
    pattern: args.pattern,
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
