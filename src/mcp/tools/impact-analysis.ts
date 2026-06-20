import type { McpToolContext } from '../types.js';

export const name = 'impact_analysis';

interface ImpactAnalysisArgs {
  file: string;
  no_tests?: boolean;
}

export async function handler(args: ImpactAnalysisArgs, ctx: McpToolContext): Promise<unknown> {
  const { impactAnalysisData } = await ctx.getQueries();
  return impactAnalysisData(args.file, ctx.dbPath, {
    noTests: args.no_tests,
  });
}
