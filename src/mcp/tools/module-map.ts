import type { McpToolContext } from '../types.js';

export const name = 'module_map';

interface ModuleMapArgs {
  limit?: number;
  no_tests?: boolean;
}

export async function handler(args: ModuleMapArgs, ctx: McpToolContext): Promise<unknown> {
  const { moduleMapData } = await ctx.getQueries();
  return moduleMapData(ctx.dbPath, args.limit || 20, { noTests: args.no_tests });
}
