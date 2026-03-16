import { effectiveLimit, effectiveOffset } from '../middleware.js';

export const name = 'context';

export async function handler(args, ctx) {
  const { contextData } = await ctx.getQueries();
  return contextData(args.name, ctx.dbPath, {
    depth: args.depth,
    file: args.file,
    kind: args.kind,
    noSource: args.no_source,
    noTests: args.no_tests,
    includeTests: args.include_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
