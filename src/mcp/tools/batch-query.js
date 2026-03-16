export const name = 'batch_query';

export async function handler(args, ctx) {
  const { batchData } = await import('../../batch.js');
  return batchData(args.command, args.targets, ctx.dbPath, {
    depth: args.depth,
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
  });
}
