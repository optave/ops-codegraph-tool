export const name = 'list_repos';

export async function handler(_args, ctx) {
  const { listRepos, pruneRegistry } = await import('../../infrastructure/registry.js');
  pruneRegistry();
  let repos = listRepos();
  if (ctx.allowedRepos) {
    repos = repos.filter((r) => ctx.allowedRepos.includes(r.name));
  }
  return { repos };
}
