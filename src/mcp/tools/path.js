export const name = 'path';

export async function handler(args, ctx) {
  const { pathData } = await ctx.getQueries();
  return pathData(args.from, args.to, ctx.dbPath, {
    maxDepth: args.depth ?? 10,
    edgeKinds: args.edge_kinds,
    fromFile: args.from_file,
    toFile: args.to_file,
    noTests: args.no_tests,
  });
}
