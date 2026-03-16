import { effectiveLimit, effectiveOffset } from '../middleware.js';

export const name = 'communities';

export async function handler(args, ctx) {
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
