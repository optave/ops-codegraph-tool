import { effectiveLimit, effectiveOffset } from '../middleware.js';
import type { McpToolContext } from '../types.js';

export const name = 'interfaces';

interface InterfacesArgs {
  name: string;
  file?: string;
  kind?: string;
  no_tests?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: InterfacesArgs, ctx: McpToolContext): Promise<unknown> {
  const { interfacesData } = await ctx.getQueries();
  return interfacesData(args.name, ctx.dbPath, {
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
