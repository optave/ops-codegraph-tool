import { effectiveLimit, effectiveOffset } from '../middleware.js';

export const name = 'diff_impact';

export async function handler(args, ctx) {
  if (args.format === 'mermaid') {
    const { diffImpactMermaid } = await ctx.getQueries();
    return diffImpactMermaid(ctx.dbPath, {
      staged: args.staged,
      ref: args.ref,
      depth: args.depth,
      noTests: args.no_tests,
    });
  }
  const { diffImpactData } = await ctx.getQueries();
  return diffImpactData(ctx.dbPath, {
    staged: args.staged,
    ref: args.ref,
    depth: args.depth,
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
