import { collectFile } from '../../db/query-builder.js';
import { EVERY_SYMBOL_KIND } from '../../domain/queries.js';
import { ConfigError } from '../../shared/errors.js';
import { config } from '../shared/options.js';
import type { CommandDefinition, CommandOpts } from '../types.js';

function validateKind(kind: CommandOpts): void {
  if (kind && !(EVERY_SYMBOL_KIND as readonly string[]).includes(kind)) {
    throw new ConfigError(`Invalid kind "${kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`);
  }
}

async function runManifesto(opts: CommandOpts, qOpts: CommandOpts): Promise<void> {
  validateKind(opts.kind);
  const { manifesto } = await import('../../presentation/manifesto.js');
  manifesto(opts.db, {
    file: opts.file,
    kind: opts.kind,
    ...qOpts,
  });
}

export const command: CommandDefinition = {
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
    ['-f, --file <path>', 'Scope to file (partial match, repeatable, manifesto mode)', collectFile],
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
    const qOpts = ctx.resolveQueryOpts(opts);

    if (!isDiffMode && !opts.rules) {
      await runManifesto(opts, qOpts);
      return;
    }

    const { check } = await import('../../presentation/check.js');
    check(opts.db, {
      ref,
      staged: opts.staged,
      cycles: opts.cycles || undefined,
      blastRadius: opts.blastRadius ? parseInt(opts.blastRadius as string, 10) : undefined,
      signatures: opts.signatures || undefined,
      boundaries: opts.boundaries || undefined,
      depth: opts.depth ? parseInt(opts.depth as string, 10) : undefined,
      noTests: qOpts.noTests,
      json: qOpts.json,
      config,
    });

    if (opts.rules) {
      await runManifesto(opts, qOpts);
    }
  },
};
