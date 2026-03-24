import fs from 'node:fs';
import { collectFile } from '../../db/query-builder.js';
import { EVERY_SYMBOL_KIND } from '../../domain/queries.js';
import { BATCH_COMMANDS, multiBatchData, splitTargets } from '../../features/batch.js';
import { batch } from '../../presentation/batch.js';
import { ConfigError } from '../../shared/errors.js';
import type { CommandDefinition } from '../types.js';

interface MultiBatchItem {
  command: string;
  target: string;
  opts?: Record<string, unknown>;
}

function isMultiBatch(targets: unknown[]): targets is MultiBatchItem[] {
  return (
    targets.length > 0 &&
    typeof targets[0] === 'object' &&
    targets[0] !== null &&
    'command' in targets[0]
  );
}

export const command: CommandDefinition = {
  name: 'batch <command> [targets...]',
  description: `Run a query against multiple targets in one call. Output is always JSON.\nValid commands: ${Object.keys(BATCH_COMMANDS).join(', ')}`,
  options: [
    ['-d, --db <path>', 'Path to graph.db'],
    ['--from-file <path>', 'Read targets from file (JSON array or newline-delimited)'],
    ['--stdin', 'Read targets from stdin (JSON array)'],
    ['--depth <n>', 'Traversal depth passed to underlying command'],
    ['-f, --file <path>', 'Scope to file (partial match, repeatable)', collectFile],
    ['-k, --kind <kind>', 'Filter by symbol kind'],
    ['-T, --no-tests', 'Exclude test/spec files from results'],
    ['--include-tests', 'Include test/spec files (overrides excludeTests config)'],
  ],
  validate([_command, _targets], opts) {
    if (opts.kind && !(EVERY_SYMBOL_KIND as readonly string[]).includes(opts.kind)) {
      return `Invalid kind "${opts.kind}". Valid: ${EVERY_SYMBOL_KIND.join(', ')}`;
    }
  },
  async execute([command, positionalTargets], opts, ctx) {
    let targets: unknown[];
    try {
      if (opts.fromFile) {
        const raw = fs.readFileSync(opts.fromFile as string, 'utf-8').trim();
        if (raw.startsWith('[')) {
          targets = JSON.parse(raw);
        } else {
          targets = raw.split(/\r?\n/).filter(Boolean);
        }
      } else if (opts.stdin) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        targets = raw.startsWith('[') ? JSON.parse(raw) : raw.split(/\r?\n/).filter(Boolean);
      } else {
        targets = splitTargets(positionalTargets as unknown as string[]);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ConfigError(`Failed to parse targets: ${message}`, { cause: err as Error });
    }

    if (!targets || targets.length === 0) {
      throw new ConfigError(
        'No targets provided. Pass targets as arguments, --from-file, or --stdin.',
      );
    }

    const batchOpts = {
      depth: opts.depth ? parseInt(opts.depth as string, 10) : undefined,
      file: opts.file,
      kind: opts.kind,
      noTests: ctx.resolveNoTests(opts),
    };

    if (isMultiBatch(targets)) {
      const data = multiBatchData(targets as MultiBatchItem[], opts.db, batchOpts);
      console.log(JSON.stringify(data, null, 2));
    } else {
      batch(command, targets as string[], opts.db, batchOpts);
    }
  },
};
