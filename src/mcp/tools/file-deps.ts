import { effectiveLimit, effectiveOffset } from '../middleware.js';
import type { McpToolContext } from '../types.js';

export const name = 'file_deps';

interface FileDepsArgs {
  file: string;
  no_tests?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: FileDepsArgs, ctx: McpToolContext): Promise<unknown> {
  const { fileDepsData } = await ctx.getQueries();
  return fileDepsData(args.file, ctx.dbPath, {
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
