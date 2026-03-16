import { effectiveLimit, effectiveOffset } from '../middleware.js';

export const name = 'structure';

export async function handler(args, ctx) {
  const { structureData } = await import('../../features/structure.js');
  return structureData(ctx.dbPath, {
    directory: args.directory,
    depth: args.depth,
    sort: args.sort,
    full: args.full,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
