import { effectiveLimit, effectiveOffset } from '../middleware.js';

export const name = 'fn_impact';

export async function handler(args, ctx) {
  const { fnImpactData } = await ctx.getQueries();
  return fnImpactData(args.name, ctx.dbPath, {
    depth: args.depth,
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
