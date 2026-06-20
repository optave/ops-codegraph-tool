import { effectiveLimit, effectiveOffset } from '../middleware.js';
import type { McpToolContext } from '../types.js';

export const name = 'implementations';

interface ImplementationsArgs {
  name: string;
  file?: string;
  kind?: string;
  no_tests?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: ImplementationsArgs, ctx: McpToolContext): Promise<unknown> {
  const { implementationsData } = await ctx.getQueries();
  return implementationsData(args.name, ctx.dbPath, {
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
