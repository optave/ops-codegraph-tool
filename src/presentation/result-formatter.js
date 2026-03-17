import { printNdjson } from '../shared/paginate.js';
import { formatTable, truncEnd } from './table.js';

/**
 * Flatten a nested object into dot-notation keys.
 * Arrays are JSON-stringified; nested objects are recursed.
 *
 * Note: this assumes input objects do not contain literal dot-notation keys
 * (e.g. `{ "a.b": 1 }`). If they do, flattened keys will silently collide
 * with nested paths (e.g. `{ a: { b: 2 } }` also produces `"a.b"`).
 */
function flattenObject(obj, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
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
 * Flatten items array and derive column names.
 * Shared by printCsv and printAutoTable.
 * @returns {{ flatItems: object[], columns: string[] } | null}
 */
function prepareFlatItems(data, field) {
  const items = field ? data[field] : data;
  if (!Array.isArray(items)) return null;

  const flatItems = items.map((item) =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? flattenObject(item)
      : { value: item },
  );
  const columns = (() => {
    const keys = new Set();
    for (const item of flatItems) for (const key of Object.keys(item)) keys.add(key);
    return [...keys];
  })();
  if (columns.length === 0) columns.push('value');

  return { flatItems, columns };
}

/** Escape a value for CSV output (LF line endings). */
function escapeCsv(val) {
  const str = val == null ? '' : String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
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
  const prepared = prepareFlatItems(data, field);
  if (!prepared) return false;
  const { flatItems, columns } = prepared;

  console.log(columns.map(escapeCsv).join(','));
  for (const row of flatItems) {
    console.log(columns.map((col) => escapeCsv(row[col])).join(','));
  }
  return true;
}

const MAX_COL_WIDTH = 40;

/**
 * Print data as an aligned table to stdout.
 * @param {object} data - Result object from a *Data() function
 * @param {string} field - Array field name (e.g. 'results')
 */
function printAutoTable(data, field) {
  const prepared = prepareFlatItems(data, field);
  if (!prepared) return false;
  const { flatItems, columns } = prepared;

  const colDefs = columns.map((col) => {
    const maxLen = flatItems.reduce(
      (max, item) => Math.max(max, String(item[col] ?? '').length),
      col.length,
    );
    const isNumeric =
      flatItems.length > 0 &&
      flatItems.every((item) => {
        const v = item[col];
        return v == null || v === '' || (typeof v !== 'boolean' && Number.isFinite(Number(v)));
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
  return true;
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
    return printCsv(data, field) !== false;
  }
  if (opts.table) {
    return printAutoTable(data, field) !== false;
  }
  return false;
}
