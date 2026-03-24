import { collectFile } from '../../db/query-builder.js';
import { ConfigError } from '../../shared/errors.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'ast [pattern]',
  description: 'Search stored AST nodes (calls, new, string, regex, throw, await) by pattern',
  queryOpts: true,
  options: [
    ['-k, --kind <kind>', 'Filter by AST node kind (call, new, string, regex, throw, await)'],
    ['-f, --file <path>', 'Scope to file (partial match, repeatable)', collectFile],
  ],
  async execute([pattern], opts, ctx) {
    const { AST_NODE_KINDS, astQuery } = await import('../../features/ast.js');
    if (opts.kind && !(AST_NODE_KINDS as readonly string[]).includes(opts.kind)) {
      throw new ConfigError(`Invalid AST kind "${opts.kind}". Valid: ${AST_NODE_KINDS.join(', ')}`);
    }
    astQuery(pattern, opts.db, {
      kind: opts.kind,
      file: opts.file,
      ...ctx.resolveQueryOpts(opts),
    });
  },
};
