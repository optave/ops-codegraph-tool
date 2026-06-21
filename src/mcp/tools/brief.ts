import type { McpToolContext } from '../types.js';

export const name = 'brief';

interface BriefArgs {
  file: string;
  no_tests?: boolean;
}

export async function handler(args: BriefArgs, ctx: McpToolContext): Promise<unknown> {
  const { briefData } = await ctx.getQueries();
  return briefData(args.file, ctx.dbPath, {
    noTests: args.no_tests,
  });
}
