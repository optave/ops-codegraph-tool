import { loadConfig } from '../infrastructure/config.js';
import type { PaginationMeta } from '../shared/paginate.js';
import { formatTable, truncEnd } from './table.js';

/**
 * Print data as newline-delimited JSON (NDJSON).
 *
 * Emits a `_meta` line with pagination info (if present), then one JSON
 * line per item in the named array field.
 */
export function printNdjson(
  data: Record<string, unknown> & { _pagination?: PaginationMeta },
  field: string,
): void {
  if (data._pagination) console.log(JSON.stringify({ _meta: data._pagination }));
  const items = data[field];
  if (Array.isArray(items)) {
    for (const item of items) console.log(JSON.stringify(item));
  }
}

function flattenObject(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, fullKey));
    } else if (Array.isArray(value)) {
      result[fullKey] = JSON.stringify(value);
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

function prepareFlatItems(
  data: Record<string, unknown>,
  field: string | null,
): { flatItems: Record<string, unknown>[]; columns: string[] } | null {
  const items = field ? (data[field] as unknown) : data;
  if (!Array.isArray(items)) return null;

  const flatItems = items.map((item: unknown) =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? flattenObject(item as Record<string, unknown>)
      : { value: item },
  );
  const columns = (() => {
    const keys = new Set<string>();
    for (const item of flatItems) for (const key of Object.keys(item)) keys.add(key);
    return [...keys];
  })();
  if (columns.length === 0) columns.push('value');

  return { flatItems, columns };
}

function escapeCsv(val: unknown): string {
  const str = val == null ? '' : String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function printCsv(data: Record<string, unknown>, field: string | null): boolean {
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

interface DisplayOpts {
  maxColWidth?: number;
}

function printAutoTable(
  data: Record<string, unknown>,
  field: string | null,
  displayOpts: DisplayOpts = {},
): boolean {
  const prepared = prepareFlatItems(data, field);
  if (!prepared) return false;
  const { flatItems, columns } = prepared;
  const colWidth = displayOpts.maxColWidth ?? MAX_COL_WIDTH;

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
      width: Math.min(maxLen, colWidth),
      align: isNumeric ? ('right' as const) : ('left' as const),
    };
  });

  const rows = flatItems.map((item) =>
    columns.map((col) => truncEnd(String(item[col] ?? ''), colWidth)),
  );

  console.log(formatTable({ columns: colDefs, rows }));
  return true;
}

export interface OutputOpts {
  json?: boolean;
  ndjson?: boolean;
  table?: boolean;
  csv?: boolean;
  display?: DisplayOpts;
}

export function outputResult(
  data: Record<string, any>,
  field: string | null,
  opts: OutputOpts,
): boolean {
  if (opts.ndjson) {
    if (field === null) {
      // No field key — emit the whole object as a single NDJSON line
      console.log(JSON.stringify(data));
    } else {
      printNdjson(data, field);
    }
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
    const displayOpts = opts.display ?? (loadConfig() as { display: DisplayOpts }).display;
    return printAutoTable(data, field, displayOpts) !== false;
  }
  return false;
}
