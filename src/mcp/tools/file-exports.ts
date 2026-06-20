import { effectiveLimit, effectiveOffset } from '../middleware.js';
import type { McpToolContext } from '../types.js';

export const name = 'file_exports';

interface FileExportsArgs {
  file: string;
  no_tests?: boolean;
  unused?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: FileExportsArgs, ctx: McpToolContext): Promise<unknown> {
  const { exportsData } = await ctx.getQueries();
  return exportsData(args.file, ctx.dbPath, {
    noTests: args.no_tests,
    unused: args.unused,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
