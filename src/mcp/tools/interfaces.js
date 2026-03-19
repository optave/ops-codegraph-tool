import { effectiveLimit, effectiveOffset } from '../middleware.js';

export const name = 'interfaces';

export async function handler(args, ctx) {
  const { interfacesData } = await ctx.getQueries();
  return interfacesData(args.name, ctx.dbPath, {
    file: args.file,
    kind: args.kind,
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
