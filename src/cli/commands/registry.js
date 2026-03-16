import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../../shared/errors.js';
import {
  listRepos,
  pruneRegistry,
  REGISTRY_PATH,
  registerRepo,
  unregisterRepo,
} from '../../infrastructure/registry.js';

export const command = {
  name: 'registry',
  description: 'Manage the multi-repo project registry',
  subcommands: [
    {
      name: 'list',
      description: 'List all registered repositories',
      options: [['-j, --json', 'Output as JSON']],
      execute(_args, opts) {
        pruneRegistry();
        const repos = listRepos();
        if (opts.json) {
          console.log(JSON.stringify(repos, null, 2));
        } else if (repos.length === 0) {
          console.log(`No repositories registered.\nRegistry: ${REGISTRY_PATH}`);
        } else {
          console.log(`Registered repositories (${REGISTRY_PATH}):\n`);
          for (const r of repos) {
            const dbExists = fs.existsSync(r.dbPath);
            const status = dbExists ? '' : ' [DB missing]';
            console.log(`  ${r.name}${status}`);
            console.log(`    Path: ${r.path}`);
            console.log(`    DB:   ${r.dbPath}`);
            console.log();
          }
        }
      },
    },
    {
      name: 'add <dir>',
      description: 'Register a project directory',
      options: [['-n, --name <name>', 'Custom name (defaults to directory basename)']],
      execute([dir], opts) {
        const absDir = path.resolve(dir);
        const { name, entry } = registerRepo(absDir, opts.name);
        console.log(`Registered "${name}" → ${entry.path}`);
      },
    },
    {
      name: 'remove <name>',
      description: 'Unregister a repository by name',
      execute([name]) {
        const removed = unregisterRepo(name);
        if (removed) {
          console.log(`Removed "${name}" from registry.`);
        } else {
          throw new ConfigError(`Repository "${name}" not found in registry.`);
        }
      },
    },
    {
      name: 'prune',
      description: 'Remove stale registry entries (missing directories or idle beyond TTL)',
      options: [
        ['--ttl <days>', 'Days of inactivity before pruning (default: 30)', '30'],
        ['--exclude <names>', 'Comma-separated repo names to preserve from pruning'],
        ['--dry-run', 'Show what would be pruned without removing anything'],
      ],
      execute(_args, opts) {
        const excludeNames = opts.exclude
          ? opts.exclude
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0)
          : [];
        const dryRun = !!opts.dryRun;
        const pruned = pruneRegistry(undefined, parseInt(opts.ttl, 10), excludeNames, dryRun);
        if (pruned.length === 0) {
          console.log('No stale entries found.');
        } else {
          const prefix = dryRun ? 'Would prune' : 'Pruned';
          for (const entry of pruned) {
            const tag = entry.reason === 'expired' ? 'expired' : 'missing';
            console.log(`${prefix} "${entry.name}" (${entry.path}) [${tag}]`);
          }
          if (dryRun) {
            console.log(
              `\nDry run: ${pruned.length} ${pruned.length === 1 ? 'entry' : 'entries'} would be removed.`,
            );
          } else {
            console.log(
              `\nRemoved ${pruned.length} stale ${pruned.length === 1 ? 'entry' : 'entries'}.`,
            );
          }
        }
      },
    },
  ],
};
