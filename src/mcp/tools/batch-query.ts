import type { McpToolContext } from '../types.js';

export const name = 'batch_query';

interface BatchQueryArgs {
  command: string;
  targets: string[];
  depth?: number;
  file?: string;
  kind?: string;
  no_tests?: boolean;
}

export async function handler(args: BatchQueryArgs, ctx: McpToolContext): Promise<unknown> {
  const { batchData } = await import('../../features/batch.js');
  return batchData(args.command, args.targets, ctx.dbPath, {
    depth: args.depth,
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
  });
}
