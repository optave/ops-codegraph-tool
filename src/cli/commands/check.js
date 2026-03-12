import { EVERY_SYMBOL_KIND } from '../../queries.js';

export const command = {
  name: 'check [ref]',
  description:
    'CI gate: run manifesto rules (no args), diff predicates (with ref/--staged), or both (--rules)',
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['--staged', 'Analyze staged changes'],
    ['--rules', 'Also run manifesto rules alongside diff predicates'],
    ['--cycles', 'Assert no dependency cycles involve changed files'],
    ['--blast-radius <n>', 'Assert no function exceeds N transitive callers'],
    ['--signatures', 'Assert no function declaration lines were modified'],
    ['--boundaries', 'Assert no cross-owner boundary violations'],
    ['--depth <n>', 'Max BFS depth for blast radius (default: 3)'],
    ['-f, --file <path>', 'Scope to file (partial match, manifesto mode)'],
    ['-k, --kind <kind>', 'Filter by symbol kind (manifesto mode)'],
    ['-T, --no-tests', 'Exclude test/spec files from results'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
    ['-j, --json', 'Output as JSON'],
    ['--limit <number>', 'Max results to return (manifesto mode)'],
    ['--offset <number>', 'Skip N results (manifesto mode)'],
    ['--ndjson', 'Newline-delimited JSON output (manifesto mode)'],
  ],
  async execute([ref], opts, ctx) {
    const isDiffMode = ref || opts.staged;

    if (!isDiffMode && !opts.rules) {
      if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
        console.error(`Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`);
        process.exit(1);
      }
      const { manifesto } = await import('../../commands/manifesto.js');
      manifesto(opts.db, {
        file: opts.file,
        kind: opts.kind,
        noTests: ctx.resolveNoTests(opts),
        json: opts.json,
        limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
        offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
        ndjson: opts.ndjson,
      });
      return;
    }

    const { check } = await import('../../commands/check.js');
    check(opts.db, {
      ref,
      staged: opts.staged,
      cycles: opts.cycles || undefined,
      blastRadius: opts.blastRadius ? parseInt(opts.blastRadius, 10) : undefined,
      signatures: opts.signatures || undefined,
      boundaries: opts.boundaries || undefined,
      depth: opts.depth ? parseInt(opts.depth, 10) : undefined,
      noTests: ctx.resolveNoTests(opts),
      json: opts.json,
    });

    if (opts.rules) {
      if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
        console.error(`Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`);
        process.exit(1);
      }
      const { manifesto } = await import('../../commands/manifesto.js');
      manifesto(opts.db, {
        file: opts.file,
        kind: opts.kind,
        noTests: ctx.resolveNoTests(opts),
        json: opts.json,
        limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
        offset: opts.offset ? parseInt(opts.offset, 10) : undefined,
        ndjson: opts.ndjson,
      });
    }
  },
};
