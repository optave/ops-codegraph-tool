import { outputResult } from './result-formatter.js';

/**
 * Run a command through the shared lifecycle:
 * 1. Execute dataFn to get data
 * 2. Try JSON/NDJSON output via outputResult()
 * 3. Fall back to formatFn() for human-readable text
 * 4. Handle exit codes for CI gate commands
 *
 * @param {Function} dataFn - Returns result data object
 * @param {Function} formatFn - Formats data for human-readable output (receives data, returns string|void)
 * @param {object} [opts]
 * @param {string|null} [opts.ndjsonField] - Array field name for NDJSON streaming
 * @param {boolean} [opts.exitOnFail] - Call process.exit(1) when data.passed === false
 * @returns {object} The data object from dataFn
 */
export function runCommand(dataFn, formatFn, opts = {}) {
  const data = dataFn();
  if (outputResult(data, opts.ndjsonField ?? null, opts)) {
    if (opts.exitOnFail && data.passed === false) process.exit(1);
    return data;
  }
  const text = formatFn(data);
  if (text) console.log(text);
  if (opts.exitOnFail && data.passed === false) process.exit(1);
  return data;
}
