export const name = 'code_owners';

export async function handler(args, ctx) {
  const { ownersData } = await import('../../owners.js');
  return ownersData(ctx.dbPath, {
    file: args.file,
    owner: args.owner,
    boundary: args.boundary,
    kind: args.kind,
    noTests: args.no_tests,
  });
}
