import { effectiveLimit, effectiveOffset } from '../middleware.js';
import type { McpToolContext } from '../types.js';

export const name = 'structure';

interface StructureArgs {
  directory?: string;
  depth?: number;
  sort?: string;
  full?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: StructureArgs, ctx: McpToolContext): Promise<unknown> {
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
