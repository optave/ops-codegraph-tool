import { effectiveOffset, MCP_DEFAULTS } from '../middleware.js';

export const name = 'cfg';

export async function handler(args, ctx) {
  const { cfgData, cfgToDOT, cfgToMermaid } = await import('../../cfg.js');
  const cfgResult = cfgData(args.name, ctx.dbPath, {
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
    limit: Math.min(args.limit ?? MCP_DEFAULTS.query, ctx.MCP_MAX_LIMIT),
    offset: effectiveOffset(args),
  });
  if (args.format === 'dot') {
    return { text: cfgToDOT(cfgResult) };
  }
  if (args.format === 'mermaid') {
    return { text: cfgToMermaid(cfgResult) };
  }
  return cfgResult;
}
