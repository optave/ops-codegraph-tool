import { effectiveOffset, MCP_DEFAULTS } from '../middleware.js';

export const name = 'dataflow';

export async function handler(args, ctx) {
  const dfMode = args.mode || 'edges';
  if (dfMode === 'impact') {
    const { dataflowImpactData } = await import('../../dataflow.js');
    return dataflowImpactData(args.name, ctx.dbPath, {
      depth: args.depth,
      file: args.file,
      kind: args.kind,
      noTests: args.no_tests,
      limit: Math.min(args.limit ?? MCP_DEFAULTS.fn_impact, ctx.MCP_MAX_LIMIT),
      offset: effectiveOffset(args),
    });
  }
  const { dataflowData } = await import('../../dataflow.js');
  return dataflowData(args.name, ctx.dbPath, {
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
    limit: Math.min(args.limit ?? MCP_DEFAULTS.query, ctx.MCP_MAX_LIMIT),
    offset: effectiveOffset(args),
  });
}
