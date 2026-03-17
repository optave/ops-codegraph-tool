export const name = 'brief';

export async function handler(args, ctx) {
  const { briefData } = await ctx.getQueries();
  return briefData(args.file, ctx.dbPath, {
    noTests: args.no_tests,
  });
}
