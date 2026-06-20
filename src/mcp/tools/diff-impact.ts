import { effectiveLimit, effectiveOffset } from '../middleware.js';
import type { McpToolContext } from '../types.js';

export const name = 'diff_impact';

interface DiffImpactArgs {
  format?: string;
  staged?: boolean;
  ref?: string;
  depth?: number;
  no_tests?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: DiffImpactArgs, ctx: McpToolContext): Promise<unknown> {
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
