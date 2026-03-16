import { effectiveOffset, MCP_DEFAULTS, MCP_MAX_LIMIT } from '../middleware.js';

export const name = 'check';

export async function handler(args, ctx) {
  const isDiffMode = args.ref || args.staged;

  if (!isDiffMode && !args.rules) {
    const { manifestoData } = await import('../../manifesto.js');
    return manifestoData(ctx.dbPath, {
      file: args.file,
      noTests: args.no_tests,
      kind: args.kind,
      limit: Math.min(args.limit ?? MCP_DEFAULTS.manifesto, MCP_MAX_LIMIT),
      offset: effectiveOffset(args),
    });
  }

  const { checkData } = await import('../../check.js');
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
    const { manifestoData } = await import('../../manifesto.js');
    const manifestoResult = manifestoData(ctx.dbPath, {
      file: args.file,
      noTests: args.no_tests,
      kind: args.kind,
      limit: Math.min(args.limit ?? MCP_DEFAULTS.manifesto, MCP_MAX_LIMIT),
      offset: effectiveOffset(args),
    });
    return { check: checkResult, manifesto: manifestoResult };
  }
  return checkResult;
}
