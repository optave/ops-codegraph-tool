/**
 * Shared table formatting utilities for CLI output.
 *
 * Pure data → formatted string transforms. No I/O — callers handle printing.
 */

/**
 * Format a table with aligned columns.
 *
 * @param {object} opts
 * @param {Array<{ header: string, width: number, align?: 'left'|'right' }>} opts.columns
 * @param {string[][]} opts.rows - Each row is an array of string cell values
 * @param {number} [opts.indent=2] - Leading spaces per line
 * @returns {string} Formatted table string (header + separator + data rows)
 */
export function formatTable({ columns, rows, indent = 2 }) {
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
export function truncEnd(str, maxLen) {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}\u2026`;
}
