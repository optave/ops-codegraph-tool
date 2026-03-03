/**
 * Batch query orchestration — run the same query command against multiple targets
 * and return all results in a single JSON payload.
 *
 * Designed for multi-agent swarms that need to dispatch 20+ queries in one call.
 */

import { complexityData } from './complexity.js';
import { dataflowData } from './dataflow.js';
import { flowData } from './flow.js';
import {
  contextData,
  explainData,
  exportsData,
  fileDepsData,
  fnDepsData,
  fnImpactData,
  impactAnalysisData,
  whereData,
} from './queries.js';

/**
 * Map of supported batch commands → their data function + first-arg semantics.
 * `sig` describes how the target string is passed to the data function:
 *   - 'name'   → dataFn(target, dbPath, opts)
 *   - 'target' → dataFn(target, dbPath, opts)
 *   - 'file'   → dataFn(target, dbPath, opts)
 *   - 'dbOnly' → dataFn(dbPath, { ...opts, target })  (target goes into opts)
 */
export const BATCH_COMMANDS = {
  'fn-impact': { fn: fnImpactData, sig: 'name' },
  context: { fn: contextData, sig: 'name' },
  explain: { fn: explainData, sig: 'target' },
  where: { fn: whereData, sig: 'target' },
  query: { fn: fnDepsData, sig: 'name' },
  impact: { fn: impactAnalysisData, sig: 'file' },
  deps: { fn: fileDepsData, sig: 'file' },
  exports: { fn: exportsData, sig: 'file' },
  flow: { fn: flowData, sig: 'name' },
  dataflow: { fn: dataflowData, sig: 'name' },
  complexity: { fn: complexityData, sig: 'dbOnly' },
};

/**
 * Run a query command against multiple targets, returning all results.
 *
 * @param {string} command - One of the keys in BATCH_COMMANDS
 * @param {string[]} targets - List of target names/paths
 * @param {string} [customDbPath] - Path to graph.db
 * @param {object} [opts] - Shared options passed to every invocation
 * @returns {{ command: string, total: number, succeeded: number, failed: number, results: object[] }}
 */
export function batchData(command, targets, customDbPath, opts = {}) {
  const entry = BATCH_COMMANDS[command];
  if (!entry) {
    throw new Error(
      `Unknown batch command "${command}". Valid commands: ${Object.keys(BATCH_COMMANDS).join(', ')}`,
    );
  }

  const results = [];
  let succeeded = 0;
  let failed = 0;

  for (const target of targets) {
    try {
      let data;
      if (entry.sig === 'dbOnly') {
        // complexityData(dbPath, { ...opts, target })
        data = entry.fn(customDbPath, { ...opts, target });
      } else {
        // All other: dataFn(target, dbPath, opts)
        data = entry.fn(target, customDbPath, opts);
      }
      results.push({ target, ok: true, data });
      succeeded++;
    } catch (err) {
      results.push({ target, ok: false, error: err.message });
      failed++;
    }
  }

  return { command, total: targets.length, succeeded, failed, results };
}

/**
 * CLI wrapper — calls batchData and prints JSON to stdout.
 */
export function batch(command, targets, customDbPath, opts = {}) {
  const data = batchData(command, targets, customDbPath, opts);
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Expand comma-separated positional args into individual entries.
 * `['a,b', 'c']` → `['a', 'b', 'c']`.
 * Trims whitespace, filters empties. Passes through object items unchanged.
 *
 * @param {Array<string|object>} targets
 * @returns {Array<string|object>}
 */
export function splitTargets(targets) {
  const out = [];
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

/**
 * Multi-command batch orchestration — run different commands per target.
 *
 * @param {Array<{command: string, target: string, opts?: object}>} items
 * @param {string} [customDbPath]
 * @param {object} [sharedOpts] - Default opts merged under per-item opts
 * @returns {{ mode: 'multi', total: number, succeeded: number, failed: number, results: object[] }}
 */
export function multiBatchData(items, customDbPath, sharedOpts = {}) {
  const results = [];
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
      let data;
      if (entry.sig === 'dbOnly') {
        data = entry.fn(customDbPath, { ...merged, target });
      } else {
        data = entry.fn(target, customDbPath, merged);
      }
      results.push({ command, target, ok: true, data });
      succeeded++;
    } catch (err) {
      results.push({ command, target, ok: false, error: err.message });
      failed++;
    }
  }

  return { mode: 'multi', total: items.length, succeeded, failed, results };
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
