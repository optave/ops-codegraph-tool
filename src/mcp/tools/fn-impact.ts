import { effectiveLimit, effectiveOffset } from '../middleware.js';
import type { McpToolContext } from '../types.js';

export const name = 'fn_impact';

interface FnImpactArgs {
  name: string;
  depth?: number;
  file?: string;
  kind?: string;
  no_tests?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: FnImpactArgs, ctx: McpToolContext): Promise<unknown> {
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
