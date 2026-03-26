import { effectiveOffset, MCP_DEFAULTS } from '../middleware.js';
import type { McpToolContext } from '../server.js';

export const name = 'cfg';

interface CfgArgs {
  name: string;
  format?: 'json' | 'dot' | 'mermaid';
  file?: string;
  kind?: string;
  no_tests?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: CfgArgs, ctx: McpToolContext): Promise<unknown> {
  const { cfgData, cfgToDOT, cfgToMermaid } = await import('../../features/cfg.js');
  const cfgResult = cfgData(args.name, ctx.dbPath, {
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
    limit: Math.min(args.limit ?? MCP_DEFAULTS.query ?? 100, ctx.MCP_MAX_LIMIT),
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
