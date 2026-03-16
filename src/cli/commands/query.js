import { EVERY_SYMBOL_KIND } from '../../domain/queries.js';
import { fnDeps, symbolPath } from '../../presentation/queries-cli.js';

export const command = {
  name: 'query <name>',
  description: 'Function-level dependency chain or shortest path between symbols',
  queryOpts: true,
  options: [
    ['--depth <n>', 'Transitive caller depth', '3'],
    ['-f, --file <path>', 'Scope search to functions in this file (partial match)'],
    ['-k, --kind <kind>', 'Filter to a specific symbol kind'],
    ['--path <to>', 'Path mode: find shortest path to <to>'],
    ['--kinds <kinds>', 'Path mode: comma-separated edge kinds to follow (default: calls)'],
    ['--reverse', 'Path mode: follow edges backward'],
    ['--from-file <path>', 'Path mode: disambiguate source symbol by file'],
    ['--to-file <path>', 'Path mode: disambiguate target symbol by file'],
  ],
  validate([_name], opts) {
    if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  execute([name], opts, ctx) {
    if (opts.path) {
      console.error('Note: "query --path" is deprecated, use "codegraph path <from> <to>" instead');
      symbolPath(name, opts.path, opts.db, {
        maxDepth: opts.depth ? parseInt(opts.depth, 10) : 10,
        edgeKinds: opts.kinds ? opts.kinds.split(',').map((s) => s.trim()) : undefined,
        reverse: opts.reverse,
        fromFile: opts.fromFile,
        toFile: opts.toFile,
        kind: opts.kind,
        noTests: ctx.resolveNoTests(opts),
        json: opts.json,
      });
    } else {
      fnDeps(name, opts.db, {
        depth: parseInt(opts.depth, 10),
        file: opts.file,
        kind: opts.kind,
        ...ctx.resolveQueryOpts(opts),
      });
    }
  },
};
