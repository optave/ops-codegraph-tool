import { effectiveLimit, effectiveOffset } from '../middleware.js';

export const name = 'node_roles';

export async function handler(args, ctx) {
  const { rolesData } = await ctx.getQueries();
  return rolesData(ctx.dbPath, {
    role: args.role,
    file: args.file,
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
