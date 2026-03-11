import { printNdjson } from '../paginate.js';

/**
 * Shared JSON / NDJSON output dispatch for CLI wrappers.
 *
 * @param {object} data   - Result object from a *Data() function
 * @param {string} field  - Array field name for NDJSON streaming (e.g. 'results')
 * @param {object} opts   - CLI options ({ json?, ndjson? })
 * @returns {boolean} true if output was handled (caller should return early)
 */
export function outputResult(data, field, opts) {
  if (opts.ndjson) {
    printNdjson(data, field);
    return true;
  }
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return true;
  }
  return false;
}
