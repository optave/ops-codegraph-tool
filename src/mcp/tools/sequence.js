import { effectiveOffset, MCP_DEFAULTS } from '../middleware.js';

export const name = 'sequence';

export async function handler(args, ctx) {
  const { sequenceData, sequenceToMermaid } = await import('../../sequence.js');
  const seqResult = sequenceData(args.name, ctx.dbPath, {
    depth: args.depth,
    file: args.file,
    kind: args.kind,
    dataflow: args.dataflow,
    noTests: args.no_tests,
    limit: Math.min(args.limit ?? MCP_DEFAULTS.execution_flow, ctx.MCP_MAX_LIMIT),
    offset: effectiveOffset(args),
  });
  return args.format === 'json' ? seqResult : { text: sequenceToMermaid(seqResult), ...seqResult };
}
