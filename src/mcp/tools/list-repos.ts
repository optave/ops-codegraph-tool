import type { McpToolContext } from '../types.js';

export const name = 'list_repos';

interface ListReposArgs {
  [key: string]: unknown;
}

export async function handler(_args: ListReposArgs, ctx: McpToolContext): Promise<unknown> {
  const { listRepos, pruneRegistry } = await import('../../infrastructure/registry.js');
  pruneRegistry();
  let repos = listRepos();
  if (ctx.allowedRepos) {
    repos = repos.filter((r: { name: string }) => (ctx.allowedRepos as string[]).includes(r.name));
  }
  return { repos };
}
