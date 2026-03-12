import { effectiveLimit, effectiveOffset } from '../middleware.js';

export const name = 'list_functions';

export async function handler(args, ctx) {
  const { listFunctionsData } = await ctx.getQueries();
  return listFunctionsData(ctx.dbPath, {
    file: args.file,
    pattern: args.pattern,
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
