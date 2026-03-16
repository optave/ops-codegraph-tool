import fs from 'node:fs';
import { batch } from '../../commands/batch.js';
import { EVERY_SYMBOL_KIND } from '../../domain/queries.js';
import { ConfigError } from '../../errors.js';
import { BATCH_COMMANDS, multiBatchData, splitTargets } from '../../features/batch.js';

export const command = {
  name: 'batch <command> [targets...]',
  description: `Run a query against multiple targets in one call. Output is always JSON.\nValid commands: ${Object.keys(BATCH_COMMANDS).join(', ')}`,
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['--from-file <path>', 'Read targets from file (JSON array or newline-delimited)'],
    ['--stdin', 'Read targets from stdin (JSON array)'],
    ['--depth <n>', 'Traversal depth passed to underlying command'],
    ['-f, --file <path>', 'Scope to file (partial match)'],
    ['-k, --kind <kind>', 'Filter by symbol kind'],
    ['-T, --no-tests', 'Exclude test/spec files from results'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
  ],
  validate([_command, _targets], opts) {
    if (opts.kind && !EVERY_SYMBOL_KIND.includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  async execute([command, positionalTargets], opts, ctx) {
    let targets;
    try {
      if (opts.fromFile) {
        const raw = fs.readFileSync(opts.fromFile, 'utf-8').trim();
        if (raw.startsWith('[')) {
          targets = JSON.parse(raw);
        } else {
          targets = raw.split(/\r?\n/).filter(Boolean);
        }
      } else if (opts.stdin) {
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        targets = raw.startsWith('[') ? JSON.parse(raw) : raw.split(/\r?\n/).filter(Boolean);
      } else {
        targets = splitTargets(positionalTargets);
      }
    } catch (err) {
      throw new ConfigError(`Failed to parse targets: ${err.message}`, { cause: err });
    }

    if (!targets || targets.length === 0) {
      throw new ConfigError(
        'No targets provided. Pass targets as arguments, --from-file, or --stdin.',
      );
    }

    const batchOpts = {
      depth: opts.depth ? parseInt(opts.depth, 10) : undefined,
      file: opts.file,
      kind: opts.kind,
      noTests: ctx.resolveNoTests(opts),
    };

    const isMulti = targets.length > 0 && typeof targets[0] === 'object' && targets[0].command;
    if (isMulti) {
      const data = multiBatchData(targets, opts.db, batchOpts);
      console.log(JSON.stringify(data, null, 2));
    } else {
      batch(command, targets, opts.db, batchOpts);
    }
  },
};
