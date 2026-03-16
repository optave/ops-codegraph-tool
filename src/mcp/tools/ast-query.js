import { effectiveLimit, effectiveOffset } from '../middleware.js';

export const name = 'ast_query';

export async function handler(args, ctx) {
  const { astQueryData } = await import('../../ast.js');
  return astQueryData(args.pattern, ctx.dbPath, {
    kind: args.kind,
    file: args.file,
    noTests: args.no_tests,
    limit: effectiveLimit(args, name),
    offset: effectiveOffset(args),
  });
}
