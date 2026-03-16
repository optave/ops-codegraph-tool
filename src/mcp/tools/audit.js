import { effectiveOffset, MCP_DEFAULTS, MCP_MAX_LIMIT } from '../middleware.js';

export const name = 'audit';

export async function handler(args, ctx) {
  if (args.quick) {
    const { explainData } = await ctx.getQueries();
    return explainData(args.target, ctx.dbPath, {
      noTests: args.no_tests,
      limit: Math.min(args.limit ?? MCP_DEFAULTS.explain, MCP_MAX_LIMIT),
      offset: effectiveOffset(args),
    });
  }
  const { auditData } = await import('../../features/audit.js');
  return auditData(args.target, ctx.dbPath, {
    depth: args.depth,
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
  });
}
