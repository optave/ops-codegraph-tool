import { effectiveOffset, MCP_DEFAULTS } from '../middleware.js';
import type { McpToolContext } from '../server.js';

export const name = 'dataflow';

interface DataflowArgs {
  mode?: string;
  name: string;
  depth?: number;
  file?: string;
  kind?: string;
  no_tests?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: DataflowArgs, ctx: McpToolContext): Promise<unknown> {
  const dfMode = args.mode || 'edges';
  if (dfMode === 'impact') {
    const { dataflowImpactData } = await import('../../features/dataflow.js');
    return dataflowImpactData(args.name, ctx.dbPath, {
      depth: args.depth,
      file: args.file,
      kind: args.kind,
      noTests: args.no_tests,
      limit: Math.min(args.limit ?? MCP_DEFAULTS.fn_impact ?? 100, ctx.MCP_MAX_LIMIT),
      offset: effectiveOffset(args),
    });
  }
  const { dataflowData } = await import('../../features/dataflow.js');
  return dataflowData(args.name, ctx.dbPath, {
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
    limit: Math.min(args.limit ?? MCP_DEFAULTS.query ?? 100, ctx.MCP_MAX_LIMIT),
    offset: effectiveOffset(args),
  });
}
