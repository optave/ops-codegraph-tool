import type { McpToolContext } from '../types.js';

export const name = 'code_owners';

interface CodeOwnersArgs {
  file?: string;
  owner?: string;
  boundary?: boolean;
  kind?: string;
  no_tests?: boolean;
}

export async function handler(args: CodeOwnersArgs, ctx: McpToolContext): Promise<unknown> {
  const { ownersData } = await import('../../features/owners.js');
  return ownersData(ctx.dbPath, {
    file: args.file,
    owner: args.owner,
    boundary: args.boundary,
    kind: args.kind,
    noTests: args.no_tests,
  });
}
