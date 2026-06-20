import { effectiveLimit, effectiveOffset } from '../middleware.js';
import type { McpToolContext } from '../types.js';

export const name = 'node_roles';

interface NodeRolesArgs {
  role?: string;
  file?: string;
  no_tests?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: NodeRolesArgs, ctx: McpToolContext): Promise<unknown> {
  const { rolesData } = await ctx.getQueries();
  return rolesData(ctx.dbPath, {
    role: args.role,
    file: args.file,
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
