import { effectiveOffset, MCP_DEFAULTS } from '../middleware.js';
import type { McpToolContext } from '../server.js';

export const name = 'sequence';

interface SequenceArgs {
  name: string;
  depth?: number;
  file?: string;
  kind?: string;
  dataflow?: boolean;
  no_tests?: boolean;
  limit?: number;
  offset?: number;
  format?: string;
}

export async function handler(args: SequenceArgs, ctx: McpToolContext): Promise<unknown> {
  const { sequenceData, sequenceToMermaid } = await import('../../features/sequence.js');
  const seqResult = sequenceData(args.name, ctx.dbPath, {
    depth: args.depth,
    file: args.file,
    kind: args.kind,
    dataflow: args.dataflow,
    noTests: args.no_tests,
    limit: Math.min(args.limit ?? MCP_DEFAULTS.execution_flow ?? 100, ctx.MCP_MAX_LIMIT),
    offset: effectiveOffset(args),
  });
  return args.format === 'json' ? seqResult : { text: sequenceToMermaid(seqResult), ...seqResult };
}
