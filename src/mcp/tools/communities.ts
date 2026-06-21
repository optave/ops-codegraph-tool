import { effectiveLimit, effectiveOffset } from '../middleware.js';
import type { McpToolContext } from '../types.js';

export const name = 'communities';

interface CommunitiesArgs {
  functions?: boolean;
  resolution?: number;
  drift?: boolean;
  no_tests?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: CommunitiesArgs, ctx: McpToolContext): Promise<unknown> {
  const { communitiesData } = await import('../../features/communities.js');
  return communitiesData(ctx.dbPath, {
    functions: args.functions,
    resolution: args.resolution,
    drift: args.drift,
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
