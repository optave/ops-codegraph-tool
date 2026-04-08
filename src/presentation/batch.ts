import { batchData, multiBatchData } from '../features/batch.js';

interface BatchOpts {
  json?: boolean;
  ndjson?: boolean;
  noTests?: boolean;
  file?: string;
  kind?: string;
  command?: string;
  limit?: number;
  offset?: number;
  [key: string]: unknown;
}

interface MultiBatchTarget {
  command: string;
  target: string;
  [key: string]: unknown;
}

export function batch(
  command: string,
  targets: string[],
  customDbPath: string | undefined,
  opts: BatchOpts = {},
): void {
  const data = batchData(command, targets, customDbPath, opts);
  console.log(JSON.stringify(data, null, 2));
}

export function batchQuery(
  targets: Array<string | MultiBatchTarget>,
  customDbPath: string | undefined,
  opts: BatchOpts = {},
): void {
  const { command: defaultCommand = 'where', ...rest } = opts;
  const isMulti =
    targets.length > 0 &&
    targets[0] !== null &&
    typeof targets[0] === 'object' &&
    !!(targets[0] as MultiBatchTarget).command;

  let data: unknown;
  if (isMulti) {
    data = multiBatchData(targets as MultiBatchTarget[], customDbPath, rest);
  } else {
    data = batchData(defaultCommand, targets as string[], customDbPath, rest);
  }
  console.log(JSON.stringify(data, null, 2));
}
