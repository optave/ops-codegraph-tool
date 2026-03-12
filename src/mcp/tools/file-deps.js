import { effectiveLimit, effectiveOffset } from '../middleware.js';

export const name = 'file_deps';

export async function handler(args, ctx) {
  const { fileDepsData } = await ctx.getQueries();
  return fileDepsData(args.file, ctx.dbPath, {
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
