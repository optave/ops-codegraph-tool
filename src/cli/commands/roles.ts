import { collectFile } from '../../db/query-builder.js';
import { VALID_ROLES } from '../../domain/queries.js';
import { dynamicCalls, roles } from '../../presentation/queries-cli.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'roles',
  description:
    'Show node role classification: entry, core, utility, adapter, dead (dead-leaf, dead-entry, dead-ffi, dead-unresolved), leaf',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['--role <role>', `Filter by role (${VALID_ROLES.join(', ')})`],
    ['-f, --file <path>', 'Scope to a specific file (partial match, repeatable)', collectFile],
    ['-T, --no-tests', 'Exclude test/spec files'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['-j, --json', 'Output as JSON'],
    ['-n, --limit <number>', 'Max results to return'],
    ['--offset <number>', 'Skip N results (default: 0)'],
    ['--ndjson', 'Newline-delimited JSON output'],
    ['--dynamic', 'Show flagged dynamic call sites instead of symbol roles'],
  ],
  validate(_args, opts) {
    if (opts.role && !(VALID_ROLES as readonly string[]).includes(opts.role)) {
      return `Invalid role "${opts.role}". Valid roles: ${VALID_ROLES.join(', ')}`;
    }
  },
  execute(_args, opts, ctx) {
    if (opts.dynamic) {
      dynamicCalls(opts.db, ctx.resolveQueryOpts(opts));
      return;
    }
    roles(opts.db, {
      role: opts.role,
      file: opts.file,
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
