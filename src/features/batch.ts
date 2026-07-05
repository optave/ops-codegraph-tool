import {
  contextData,
  explainData,
  exportsData,
  fileDepsData,
  fnDepsData,
  fnImpactData,
  impactAnalysisData,
  whereData,
} from '../domain/queries.js';
import { ConfigError } from '../shared/errors.js';
import { complexityData } from './complexity.js';
import { dataflowData } from './dataflow.js';
import { flowData } from './flow.js';

type BatchSig = 'name' | 'target' | 'file' | 'dbOnly';

interface BatchCommandEntry {
  fn: (...args: unknown[]) => unknown;
  sig: BatchSig;
  /**
   * For `sig: 'dbOnly'` commands only: the `opts` key each target should be
   * written to before calling `fn(customDbPath, opts)`. Defaults to `'target'`
   * (a symbol/name filter). Commands whose underlying query function expects a
   * *file path* target (rather than a symbol name) — e.g. `complexityData`,
   * which treats `opts.target` as a name filter and `opts.file` as the file
   * scope — must override this so the batch target lands in the right filter.
   */
  targetKey?: string;
}

export const BATCH_COMMANDS: Record<string, BatchCommandEntry> = {
  'fn-impact': { fn: fnImpactData as (...args: unknown[]) => unknown, sig: 'name' },
  context: { fn: contextData as (...args: unknown[]) => unknown, sig: 'name' },
  explain: { fn: explainData as (...args: unknown[]) => unknown, sig: 'target' },
  where: { fn: whereData as (...args: unknown[]) => unknown, sig: 'target' },
  query: { fn: fnDepsData as (...args: unknown[]) => unknown, sig: 'name' },
  impact: { fn: impactAnalysisData as (...args: unknown[]) => unknown, sig: 'file' },
  deps: { fn: fileDepsData as (...args: unknown[]) => unknown, sig: 'file' },
  exports: { fn: exportsData as (...args: unknown[]) => unknown, sig: 'file' },
  flow: { fn: flowData as (...args: unknown[]) => unknown, sig: 'name' },
  dataflow: { fn: dataflowData as (...args: unknown[]) => unknown, sig: 'name' },
  complexity: {
    fn: complexityData as (...args: unknown[]) => unknown,
    sig: 'dbOnly',
    targetKey: 'file',
  },
};

/** Resolve the opts key a `dbOnly` command's target should be written to. */
function dbOnlyTargetOpts(
  entry: BatchCommandEntry,
  opts: Record<string, unknown>,
  target: string,
): Record<string, unknown> {
  return { ...opts, [entry.targetKey ?? 'target']: target };
}

interface BatchResultOk {
  target: string;
  ok: true;
  data: unknown;
}

interface BatchResultErr {
  target: string;
  ok: false;
  error: string;
}

type BatchResultItem = BatchResultOk | BatchResultErr;

interface BatchResult {
  command: string;
  total: number;
  succeeded: number;
  failed: number;
  results: BatchResultItem[];
}

export function batchData(
  command: string,
  targets: string[],
  customDbPath: string | undefined,
  opts: Record<string, unknown> = {},
): BatchResult {
  const entry = BATCH_COMMANDS[command];
  if (!entry) {
    throw new ConfigError(
      `Unknown batch command "${command}". Valid commands: ${Object.keys(BATCH_COMMANDS).join(', ')}`,
    );
  }

  const results: BatchResultItem[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const target of targets) {
    try {
      let data: unknown;
      if (entry.sig === 'dbOnly') {
        data = entry.fn(customDbPath, dbOnlyTargetOpts(entry, opts, target));
      } else {
        data = entry.fn(target, customDbPath, opts);
      }
      results.push({ target, ok: true, data });
      succeeded++;
    } catch (err) {
      results.push({ target, ok: false, error: (err as Error).message });
      failed++;
    }
  }

  return { command, total: targets.length, succeeded, failed, results };
}

export function splitTargets(targets: Array<string | object>): Array<string | object> {
  const out: Array<string | object> = [];
  for (const item of targets) {
    if (typeof item !== 'string') {
      out.push(item);
      continue;
    }
    for (const part of item.split(',')) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

interface MultiBatchItem {
  command: string;
  target: string;
  opts?: Record<string, unknown>;
}

interface MultiBatchResultOk {
  command: string;
  target: string;
  ok: true;
  data: unknown;
}

interface MultiBatchResultErr {
  command: string;
  target: string;
  ok: false;
  error: string;
}

type MultiBatchResultItem = MultiBatchResultOk | MultiBatchResultErr;

interface MultiBatchResult {
  mode: 'multi';
  total: number;
  succeeded: number;
  failed: number;
  results: MultiBatchResultItem[];
}

export function multiBatchData(
  items: MultiBatchItem[],
  customDbPath: string | undefined,
  sharedOpts: Record<string, unknown> = {},
): MultiBatchResult {
  const results: MultiBatchResultItem[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const item of items) {
    const { command, target, opts: itemOpts } = item;
    const entry = BATCH_COMMANDS[command];

    if (!entry) {
      results.push({
        command,
        target,
        ok: false,
        error: `Unknown batch command "${command}". Valid commands: ${Object.keys(BATCH_COMMANDS).join(', ')}`,
      });
      failed++;
      continue;
    }

    const merged = { ...sharedOpts, ...itemOpts };

    try {
      let data: unknown;
      if (entry.sig === 'dbOnly') {
        data = entry.fn(customDbPath, dbOnlyTargetOpts(entry, merged, target));
      } else {
        data = entry.fn(target, customDbPath, merged);
      }
      results.push({ command, target, ok: true, data });
      succeeded++;
    } catch (err) {
      results.push({ command, target, ok: false, error: (err as Error).message });
      failed++;
    }
  }

  return { mode: 'multi', total: items.length, succeeded, failed, results };
}
