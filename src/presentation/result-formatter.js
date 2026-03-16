import { printNdjson } from '../shared/paginate.js';
import { formatTable, truncEnd } from './table.js';

/**
 * Flatten a nested object into dot-notation keys.
 * Arrays are JSON-stringified; nested objects are recursed.
 */
function flattenObject(obj, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, fullKey));
    } else if (Array.isArray(value)) {
      result[fullKey] = JSON.stringify(value);
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

/**
 * Auto-detect column keys from an array of objects.
 * Returns stable insertion-order keys across all items.
 */
function autoColumns(items) {
  const keys = new Set();
  for (const item of items) {
    for (const key of Object.keys(flattenObject(item))) keys.add(key);
  }
  return [...keys];
}

/** Escape a value for RFC 4180 CSV output. */
function escapeCsv(val) {
  const str = val == null ? '' : String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Print data as CSV to stdout.
 * @param {object} data - Result object from a *Data() function
 * @param {string} field - Array field name (e.g. 'results')
 */
function printCsv(data, field) {
  const items = field ? data[field] : data;
  if (!Array.isArray(items) || items.length === 0) return;

  const flatItems = items.map((item) =>
    typeof item === 'object' && item !== null ? flattenObject(item) : { value: item },
  );
  const columns = autoColumns(items.filter((i) => typeof i === 'object' && i !== null));
  if (columns.length === 0) columns.push('value');

  console.log(columns.map(escapeCsv).join(','));
  for (const row of flatItems) {
    console.log(columns.map((col) => escapeCsv(row[col])).join(','));
  }
}

const MAX_COL_WIDTH = 40;

/**
 * Print data as an aligned table to stdout.
 * @param {object} data - Result object from a *Data() function
 * @param {string} field - Array field name (e.g. 'results')
 */
function printAutoTable(data, field) {
  const items = field ? data[field] : data;
  if (!Array.isArray(items) || items.length === 0) return;

  const flatItems = items.map((item) =>
    typeof item === 'object' && item !== null ? flattenObject(item) : { value: item },
  );
  const columns = autoColumns(items.filter((i) => typeof i === 'object' && i !== null));
  if (columns.length === 0) columns.push('value');

  const colDefs = columns.map((col) => {
    const maxLen = Math.max(col.length, ...flatItems.map((item) => String(item[col] ?? '').length));
    const isNumeric = flatItems.every((item) => {
      const v = item[col];
      return v == null || v === '' || Number.isFinite(Number(v));
    });
    return {
      header: col,
      width: Math.min(maxLen, MAX_COL_WIDTH),
      align: isNumeric ? 'right' : 'left',
    };
  });

  const rows = flatItems.map((item) =>
    columns.map((col) => truncEnd(String(item[col] ?? ''), MAX_COL_WIDTH)),
  );

  console.log(formatTable({ columns: colDefs, rows }));
}

/**
 * Shared JSON / NDJSON / table / CSV output dispatch for CLI wrappers.
 *
 * @param {object} data   - Result object from a *Data() function
 * @param {string} field  - Array field name for NDJSON streaming (e.g. 'results')
 * @param {object} opts   - CLI options ({ json?, ndjson?, table?, csv? })
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
  if (opts.csv) {
    printCsv(data, field);
    return true;
  }
  if (opts.table) {
    printAutoTable(data, field);
    return true;
  }
  return false;
}
