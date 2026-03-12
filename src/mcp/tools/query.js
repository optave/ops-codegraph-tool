import { effectiveOffset, MCP_DEFAULTS } from '../middleware.js';

export const name = 'query';

export async function handler(args, ctx) {
  const { fnDepsData, pathData } = await ctx.getQueries();
  const qMode = args.mode || 'deps';
  if (qMode === 'path') {
    if (!args.to) {
      return { error: 'path mode requires a "to" argument' };
    }
    return pathData(args.name, args.to, ctx.dbPath, {
      maxDepth: args.depth ?? 10,
      edgeKinds: args.edge_kinds,
      reverse: args.reverse,
      fromFile: args.from_file,
      toFile: args.to_file,
      kind: args.kind,
      noTests: args.no_tests,
    });
  }
  return fnDepsData(args.name, ctx.dbPath, {
    depth: args.depth,
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
    limit: Math.min(args.limit ?? MCP_DEFAULTS.query, ctx.MCP_MAX_LIMIT),
    offset: effectiveOffset(args),
  });
}
