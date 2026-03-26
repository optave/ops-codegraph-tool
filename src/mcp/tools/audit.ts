import { effectiveOffset, MCP_DEFAULTS, MCP_MAX_LIMIT } from '../middleware.js';
import type { McpToolContext } from '../server.js';

export const name = 'audit';

interface AuditArgs {
  target: string;
  quick?: boolean;
  depth?: number;
  file?: string;
  kind?: string;
  no_tests?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: AuditArgs, ctx: McpToolContext): Promise<unknown> {
  if (args.quick) {
    const { explainData } = await ctx.getQueries();
    return explainData(args.target, ctx.dbPath, {
      noTests: args.no_tests,
      limit: Math.min(args.limit ?? MCP_DEFAULTS.explain ?? 100, MCP_MAX_LIMIT),
      offset: effectiveOffset(args),
    });
  }
  const { auditData } = await import('../../features/audit.js');
  return auditData(args.target, ctx.dbPath, {
    depth: args.depth,
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
  });
}
