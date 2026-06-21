import { effectiveLimit, effectiveOffset } from '../middleware.js';
import type { McpToolContext } from '../types.js';

export const name = 'co_changes';

interface CoChangesArgs {
  file?: string;
  limit?: number;
  offset?: number;
  min_jaccard?: number;
  no_tests?: boolean;
}

export async function handler(args: CoChangesArgs, ctx: McpToolContext): Promise<unknown> {
  const { coChangeData, coChangeTopData } = await import('../../features/cochange.js');
  return args.file
    ? coChangeData(args.file, ctx.dbPath, {
        limit: effectiveLimit(args, name),
        offset: effectiveOffset(args),
        minJaccard: args.min_jaccard,
        noTests: args.no_tests,
      })
    : coChangeTopData(ctx.dbPath, {
        limit: effectiveLimit(args, name),
        offset: effectiveOffset(args),
        minJaccard: args.min_jaccard,
        noTests: args.no_tests,
      });
}
