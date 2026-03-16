export const name = 'module_map';

export async function handler(args, ctx) {
  const { moduleMapData } = await ctx.getQueries();
  return moduleMapData(ctx.dbPath, args.limit || 20, { noTests: args.no_tests });
}
