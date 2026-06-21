import type { McpToolContext } from '../types.js';

export const name = 'branch_compare';

interface BranchCompareArgs {
  base: string;
  target: string;
  depth?: number;
  no_tests?: boolean;
  format?: 'json' | 'mermaid';
}

export async function handler(args: BranchCompareArgs, _ctx: McpToolContext): Promise<unknown> {
  const { branchCompareData, branchCompareMermaid } = await import(
    '../../features/branch-compare.js'
  );
  const bcData = await branchCompareData(args.base, args.target, {
    depth: args.depth,
    noTests: args.no_tests,
  });
  return args.format === 'mermaid' ? branchCompareMermaid(bcData) : bcData;
}
