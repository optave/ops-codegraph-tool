import { effectiveLimit, effectiveOffset } from '../middleware.js';

export const name = 'co_changes';

export async function handler(args, ctx) {
  const { coChangeData, coChangeTopData } = await import('../../cochange.js');
  return args.file
    ? coChangeData(args.file, ctx.dbPath, {
        limit: effectiveLimit(args, name),
        offset: effectiveOffset(args),
        minJaccard: args.min_jaccard,
        noTests: args.no_tests,
      })
    : coChangeTopData(ctx.dbPath, {
        limit: effectiveLimit(args, name),
        offset: effectiveOffset(args),
        minJaccard: args.min_jaccard,
        noTests: args.no_tests,
      });
}
