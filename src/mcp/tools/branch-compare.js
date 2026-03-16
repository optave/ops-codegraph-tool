export const name = 'branch_compare';

export async function handler(args, _ctx) {
  const { branchCompareData, branchCompareMermaid } = await import(
    '../../features/branch-compare.js'
  );
  const bcData = await branchCompareData(args.base, args.target, {
    depth: args.depth,
    noTests: args.no_tests,
  });
  return args.format === 'mermaid' ? branchCompareMermaid(bcData) : bcData;
}
