import { effectiveLimit, effectiveOffset } from '../middleware.js';

export const name = 'implementations';

export async function handler(args, ctx) {
  const { implementationsData } = await ctx.getQueries();
  return implementationsData(args.name, ctx.dbPath, {
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
