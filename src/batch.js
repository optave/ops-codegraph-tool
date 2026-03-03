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
  fileDepsData,
  fnDepsData,
  fnImpactData,
  impactAnalysisData,
  queryNameData,
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
  query: { fn: queryNameData, sig: 'name' },
  fn: { fn: fnDepsData, sig: 'name' },
  impact: { fn: impactAnalysisData, sig: 'file' },
  deps: { fn: fileDepsData, sig: 'file' },
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
