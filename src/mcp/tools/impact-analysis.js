export const name = 'impact_analysis';

export async function handler(args, ctx) {
  const { impactAnalysisData } = await ctx.getQueries();
  return impactAnalysisData(args.file, ctx.dbPath, {
    noTests: args.no_tests,
  });
}
