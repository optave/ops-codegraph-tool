import type { McpToolContext } from '../server.js';

export const name = 'path';

interface PathArgs {
  from: string;
  to: string;
  depth?: number;
  edge_kinds?: string[];
  from_file?: string;
  to_file?: string;
  no_tests?: boolean;
  file_mode?: boolean;
}

export async function handler(args: PathArgs, ctx: McpToolContext): Promise<unknown> {
  if (args.file_mode) {
    const { filePathData } = await ctx.getQueries();
    return filePathData(args.from, args.to, ctx.dbPath, {
      maxDepth: args.depth ?? 10,
      edgeKinds: args.edge_kinds,
      reverse: false,
      noTests: args.no_tests,
    });
  }
  const { pathData } = await ctx.getQueries();
  return pathData(args.from, args.to, ctx.dbPath, {
    maxDepth: args.depth ?? 10,
    edgeKinds: args.edge_kinds,
    fromFile: args.from_file,
    toFile: args.to_file,
    noTests: args.no_tests,
  });
}
