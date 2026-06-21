import { effectiveLimit, effectiveOffset } from '../middleware.js';
import type { McpToolContext } from '../types.js';

export const name = 'execution_flow';

interface ExecutionFlowArgs {
  list?: boolean;
  name?: string;
  depth?: number;
  file?: string;
  kind?: string;
  no_tests?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: ExecutionFlowArgs, ctx: McpToolContext): Promise<unknown> {
  if (args.list) {
    const { listEntryPointsData } = await import('../../features/flow.js');
    return listEntryPointsData(ctx.dbPath, {
      noTests: args.no_tests,
      limit: effectiveLimit(args, name),
      offset: effectiveOffset(args),
    });
  }
  if (!args.name) {
    return { error: 'Provide a name or set list=true' };
  }
  const { flowData } = await import('../../features/flow.js');
  return flowData(args.name, ctx.dbPath, {
    depth: args.depth,
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
