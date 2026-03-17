import { collectFile } from '../../db/query-builder.js';
import { VALID_ROLES } from '../../domain/queries.js';
import { roles } from '../../presentation/queries-cli.js';

export const command = {
  name: 'roles',
  description: 'Show node role classification: entry, core, utility, adapter, dead, leaf',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['--role <role>', `Filter by role (${VALID_ROLES.join(', ')})`],
    ['-f, --file <path>', 'Scope to a specific file (partial match, repeatable)', collectFile],
    ['-T, --no-tests', 'Exclude test/spec files'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['-j, --json', 'Output as JSON'],
    ['--limit <number>', 'Max results to return'],
    ['--offset <number>', 'Skip N results (default: 0)'],
    ['--ndjson', 'Newline-delimited JSON output'],
  ],
  validate(_args, opts) {
    if (opts.role && !VALID_ROLES.includes(opts.role)) {
      return `Invalid role "${opts.role}". Valid roles: ${VALID_ROLES.join(', ')}`;
    }
  },
  execute(_args, opts, ctx) {
    roles(opts.db, {
      role: opts.role,
      file: opts.file,
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
