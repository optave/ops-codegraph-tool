import { effectiveLimit, effectiveOffset } from '../middleware.js';

export const name = 'complexity';

export async function handler(args, ctx) {
  const { complexityData } = await import('../../features/complexity.js');
  return complexityData(ctx.dbPath, {
    target: args.name,
    file: args.file,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
    sort: args.sort,
    aboveThreshold: args.above_threshold,
    health: args.health,
    noTests: args.no_tests,
    kind: args.kind,
  });
}
