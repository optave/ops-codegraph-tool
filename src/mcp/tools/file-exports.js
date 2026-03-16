import { effectiveLimit, effectiveOffset } from '../middleware.js';

export const name = 'file_exports';

export async function handler(args, ctx) {
  const { exportsData } = await ctx.getQueries();
  return exportsData(args.file, ctx.dbPath, {
    noTests: args.no_tests,
    unused: args.unused,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
