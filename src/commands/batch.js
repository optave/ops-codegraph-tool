import { batchData, multiBatchData } from '../features/batch.js';

/**
 * CLI wrapper — calls batchData and prints JSON to stdout.
 */
export function batch(command, targets, customDbPath, opts = {}) {
  const data = batchData(command, targets, customDbPath, opts);
  console.log(JSON.stringify(data, null, 2));
}

/**
 * CLI wrapper for batch-query — detects multi-command mode (objects with .command)
 * or falls back to single-command batchData (default: 'where').
 */
export function batchQuery(targets, customDbPath, opts = {}) {
  const { command: defaultCommand = 'where', ...rest } = opts;
  const isMulti = targets.length > 0 && typeof targets[0] === 'object' && targets[0].command;

  let data;
  if (isMulti) {
    data = multiBatchData(targets, customDbPath, rest);
  } else {
    data = batchData(defaultCommand, targets, customDbPath, rest);
  }
  console.log(JSON.stringify(data, null, 2));
}
