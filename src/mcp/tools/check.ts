import { effectiveOffset, MCP_DEFAULTS, MCP_MAX_LIMIT } from '../middleware.js';
import type { McpToolContext } from '../server.js';

export const name = 'check';

interface CheckArgs {
  ref?: string;
  staged?: boolean;
  rules?: boolean;
  cycles?: boolean;
  blast_radius?: number;
  signatures?: boolean;
  boundaries?: boolean;
  depth?: number;
  file?: string;
  kind?: string;
  no_tests?: boolean;
  limit?: number;
  offset?: number;
}

export async function handler(args: CheckArgs, ctx: McpToolContext): Promise<unknown> {
  const isDiffMode = args.ref || args.staged;

  if (!isDiffMode && !args.rules) {
    const { manifestoData } = await import('../../features/manifesto.js');
    return manifestoData(ctx.dbPath, {
      file: args.file,
      noTests: args.no_tests,
      kind: args.kind,
      limit: Math.min(args.limit ?? MCP_DEFAULTS.manifesto ?? 100, MCP_MAX_LIMIT),
      offset: effectiveOffset(args),
    });
  }

  const { checkData } = await import('../../features/check.js');
  const checkResult = checkData(ctx.dbPath, {
    ref: args.ref,
    staged: args.staged,
    cycles: args.cycles,
    blastRadius: args.blast_radius,
    signatures: args.signatures,
    boundaries: args.boundaries,
    depth: args.depth,
    noTests: args.no_tests,
  });

  if (args.rules) {
    const { manifestoData } = await import('../../features/manifesto.js');
    const manifestoResult = manifestoData(ctx.dbPath, {
      file: args.file,
      noTests: args.no_tests,
      kind: args.kind,
      limit: Math.min(args.limit ?? MCP_DEFAULTS.manifesto ?? 100, MCP_MAX_LIMIT),
      offset: effectiveOffset(args),
    });
    return { check: checkResult, manifesto: manifestoResult };
  }
  return checkResult;
}
