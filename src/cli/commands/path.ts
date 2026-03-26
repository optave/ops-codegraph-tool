import { EVERY_SYMBOL_KIND } from '../../domain/queries.js';
import { symbolPath } from '../../presentation/queries-cli.js';
import type { CommandDefinition } from '../types.js';

export const command: CommandDefinition = {
  name: 'path <from> <to>',
  description: 'Find shortest path between two symbols (or files with --file)',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['-f, --file', 'Treat <from> and <to> as file paths instead of symbol names'],
    ['--reverse', 'Follow edges backward'],
    [
      '--kinds <kinds>',
      'Comma-separated edge kinds to follow (default: calls; file mode: imports,imports-type)',
    ],
    ['--from-file <path>', 'Disambiguate source symbol by file'],
    ['--to-file <path>', 'Disambiguate target symbol by file'],
    ['--depth <n>', 'Max traversal depth', '10'],
    ['-k, --kind <kind>', 'Filter to a specific symbol kind'],
    ['-T, --no-tests', 'Exclude test/spec files from results'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['-j, --json', 'Output as JSON'],
  ],
  validate([_from, _to], opts) {
    if (opts.kind && !(EVERY_SYMBOL_KIND as readonly string[]).includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  execute([from, to], opts, ctx) {
    symbolPath(from!, to!, opts.db, {
      maxDepth: opts.depth ? parseInt(opts.depth as string, 10) : 10,
      edgeKinds: opts.kinds ? (opts.kinds as string).split(',').map((s) => s.trim()) : undefined,
      reverse: opts.reverse,
      fromFile: opts.fromFile,
      toFile: opts.toFile,
      kind: opts.kind,
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
      file: opts.file,
    });
  },
};
