import { effectiveLimit, effectiveOffset } from '../middleware.js';
import type { McpToolContext } from '../types.js';

export const name = 'complexity';

interface ComplexityArgs {
  name?: string;
  file?: string;
  limit?: number;
  offset?: number;
  sort?: string;
  above_threshold?: boolean;
  health?: boolean;
  no_tests?: boolean;
  kind?: string;
}

export async function handler(args: ComplexityArgs, ctx: McpToolContext): Promise<unknown> {
  const { complexityData } = await import('../../features/complexity.js');
  return complexityData(ctx.dbPath, {
    target: args.name,
    file: args.file,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
    sort: args.sort,
    aboveThreshold: args.above_threshold,
    noTests: args.no_tests,
    kind: args.kind,
  });
}
