import { collectFile } from '../../db/query-builder.js';
import { EVERY_SYMBOL_KIND } from '../../domain/queries.js';
import { audit } from '../../presentation/audit.js';
import { explain } from '../../presentation/queries-cli.js';
import { config } from '../shared/options.js';

export const command = {
  name: 'audit <target>',
  description: 'Composite report: explain + impact + health metrics per function',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['--quick', 'Structural summary only (skip impact analysis and health metrics)'],
    ['--depth <n>', 'Impact/explain depth', '3'],
    ['-f, --file <path>', 'Scope to file (partial match, repeatable)', collectFile],
    ['-k, --kind <kind>', 'Filter by symbol kind'],
    ['-T, --no-tests', 'Exclude test/spec files from results'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['-j, --json', 'Output as JSON'],
    ['--limit <number>', 'Max results to return (quick mode)'],
    ['--offset <number>', 'Skip N results (quick mode)'],
    ['--ndjson', 'Newline-delimited JSON output (quick mode)'],
  ],
  validate([_target], opts) {
    if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  execute([target], opts, ctx) {
    const qOpts = ctx.resolveQueryOpts(opts);
    if (opts.quick) {
      explain(target, opts.db, {
        depth: parseInt(opts.depth, 10),
        ...qOpts,
      });
      return;
    }
    audit(target, opts.db, {
      depth: parseInt(opts.depth, 10),
      file: opts.file,
      kind: opts.kind,
      noTests: qOpts.noTests,
      json: qOpts.json,
      config,
    });
  },
};
