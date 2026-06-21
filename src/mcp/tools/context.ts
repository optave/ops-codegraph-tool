import { effectiveLimit, effectiveOffset } from '../middleware.js';
import type { McpToolContext } from '../types.js';

export const name = 'context';

interface ContextArgs {
  name: string;
  depth?: number;
  file?: string;
  kind?: string;
  no_source?: boolean;
  no_tests?: boolean;
  include_tests?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: ContextArgs, ctx: McpToolContext): Promise<unknown> {
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
