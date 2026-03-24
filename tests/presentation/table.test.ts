/**
 * Unit tests for presentation/table.ts — pure formatting functions.
 */
import { describe, expect, it } from 'vitest';
import { formatTable, truncEnd } from '../../src/presentation/table.js';

describe('truncEnd', () => {
  it('returns string unchanged when within limit', () => {
    expect(truncEnd('hello', 10)).toBe('hello');
  });

  it('returns string unchanged when exactly at limit', () => {
    expect(truncEnd('hello', 5)).toBe('hello');
  });

  it('truncates and appends ellipsis when over limit', () => {
    expect(truncEnd('hello world', 5)).toBe('hell\u2026');
  });

  it('truncates to single char plus ellipsis for maxLen=2', () => {
    expect(truncEnd('abcdef', 2)).toBe('a\u2026');
  });

  it('handles empty string', () => {
    expect(truncEnd('', 5)).toBe('');
  });
});

describe('formatTable', () => {
  it('renders header, separator, and data rows', () => {
    const result = formatTable({
      columns: [
        { header: 'Name', width: 10 },
        { header: 'Count', width: 5, align: 'right' },
      ],
      rows: [
        ['alpha', '42'],
        ['beta', '7'],
      ],
    });

    const lines = result.split('\n');
    expect(lines).toHaveLength(4); // header + separator + 2 rows
    expect(lines[0]).toContain('Name');
    expect(lines[0]).toContain('Count');
    // Separator uses unicode box-drawing char
    expect(lines[1]).toContain('\u2500');
  });

  it('right-aligns numeric columns', () => {
    const result = formatTable({
      columns: [{ header: 'Val', width: 6, align: 'right' }],
      rows: [['42']],
    });
    const dataLine = result.split('\n')[2];
    // '42' right-aligned in 6-char column → 4 leading spaces
    expect(dataLine).toMatch(/\s+42/);
  });

  it('left-aligns by default', () => {
    const result = formatTable({
      columns: [{ header: 'Name', width: 8 }],
      rows: [['hi']],
    });
    const dataLine = result.split('\n')[2];
    // 'hi' left-aligned → followed by spaces
    expect(dataLine).toContain('hi      ');
  });

  it('respects custom indent', () => {
    const result = formatTable({
      columns: [{ header: 'X', width: 3 }],
      rows: [['a']],
      indent: 4,
    });
    // Each line starts with 4-space indent
    for (const line of result.split('\n')) {
      expect(line).toMatch(/^ {4}/);
    }
  });

  it('uses default indent of 2', () => {
    const result = formatTable({
      columns: [{ header: 'X', width: 3 }],
      rows: [],
    });
    const lines = result.split('\n');
    expect(lines[0]).toMatch(/^ {2}/);
  });

  it('handles empty rows', () => {
    const result = formatTable({
      columns: [{ header: 'A', width: 5 }],
      rows: [],
    });
    const lines = result.split('\n');
    expect(lines).toHaveLength(2); // header + separator only
  });

  it('handles missing cell values gracefully', () => {
    const result = formatTable({
      columns: [
        { header: 'A', width: 5 },
        { header: 'B', width: 5 },
      ],
      rows: [['only-a']], // missing second cell
    });
    // Should not throw
    expect(result).toContain('only-a');
  });

  it('separator width matches column widths', () => {
    const result = formatTable({
      columns: [
        { header: 'Name', width: 10 },
        { header: 'Size', width: 6 },
      ],
      rows: [],
    });
    const separator = result.split('\n')[1].trim();
    // 10 + 1 (space) + 6 = 17 box-drawing chars and spaces
    const boxChars = separator.replace(/ /g, '');
    expect(boxChars.length).toBe(16); // 10 + 6 box chars
  });
});
