import { effectiveLimit, effectiveOffset } from '../middleware.js';

export const name = 'where';

export async function handler(args, ctx) {
  const { whereData } = await ctx.getQueries();
  return whereData(args.target, ctx.dbPath, {
    file: args.file_mode,
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
