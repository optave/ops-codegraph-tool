/**
 * Shared table formatting utilities for CLI output.
 *
 * Pure data → formatted string transforms. No I/O — callers handle printing.
 */

export interface ColumnDef {
  header: string;
  width: number;
  align?: 'left' | 'right';
}

export interface FormatTableOpts {
  columns: ColumnDef[];
  rows: string[][];
  indent?: number;
}

/**
 * Format a table with aligned columns.
 */
export function formatTable({ columns, rows, indent = 2 }: FormatTableOpts): string {
  const prefix = ' '.repeat(indent);
  const header = columns
    .map((c) => (c.align === 'right' ? c.header.padStart(c.width) : c.header.padEnd(c.width)))
    .join(' ');
  const separator = columns.map((c) => '\u2500'.repeat(c.width)).join(' ');
  const lines = [`${prefix}${header}`, `${prefix}${separator}`];
  for (const row of rows) {
    const cells = columns.map((c, i) => {
      const val = row[i] ?? '';
      return c.align === 'right' ? val.padStart(c.width) : val.padEnd(c.width);
    });
    lines.push(`${prefix}${cells.join(' ')}`);
  }
  return lines.join('\n');
}

/**
 * Truncate a string from the end, appending '\u2026' if truncated.
 */
export function truncEnd(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}\u2026`;
}
