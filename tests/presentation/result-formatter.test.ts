/**
 * Unit tests for presentation/result-formatter.js — output dispatch logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the config loader so it doesn't touch disk
vi.mock('../../src/infrastructure/config.js', () => ({
  loadConfig: () => ({ display: { maxColWidth: 40 } }),
}));

// Mock paginate to capture NDJSON calls
const mockPrintNdjson = vi.fn();
vi.mock('../../src/shared/paginate.js', () => ({
  printNdjson: (...args) => mockPrintNdjson(...args),
}));

const { outputResult } = await import('../../src/presentation/result-formatter.js');

describe('outputResult', () => {
  let logSpy: any;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockPrintNdjson.mockClear();
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('returns false when no format option is set', () => {
    const result = outputResult({ items: [1, 2] }, 'items', {});
    expect(result).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('handles json option', () => {
    const data = { results: [{ name: 'foo' }] };
    const result = outputResult(data, 'results', { json: true });
    expect(result).toBe(true);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output).toEqual(data);
  });

  it('handles ndjson option', () => {
    const data = { results: [{ name: 'a' }] };
    const result = outputResult(data, 'results', { ndjson: true });
    expect(result).toBe(true);
    expect(mockPrintNdjson).toHaveBeenCalledWith(data, 'results');
  });

  it('handles csv option with array data', () => {
    const data = {
      items: [
        { name: 'a', count: 1 },
        { name: 'b', count: 2 },
      ],
    };
    const result = outputResult(data, 'items', { csv: true });
    expect(result).toBe(true);
    // Header row + 2 data rows
    expect(logSpy).toHaveBeenCalledTimes(3);
    expect(logSpy.mock.calls[0][0]).toContain('name');
    expect(logSpy.mock.calls[0][0]).toContain('count');
  });

  it('csv returns false when field is not an array', () => {
    const result = outputResult({ scalar: 42 }, 'scalar', { csv: true });
    expect(result).toBe(false);
  });

  it('handles table option', () => {
    const data = { items: [{ file: 'a.js', lines: 10 }] };
    const result = outputResult(data, 'items', { table: true });
    expect(result).toBe(true);
    expect(logSpy).toHaveBeenCalled();
    // Should contain table formatting (box-drawing chars)
    const output = logSpy.mock.calls[0][0];
    expect(output).toContain('\u2500');
  });

  it('csv escapes commas and quotes in values', () => {
    const data = { items: [{ text: 'hello, world', quoted: 'say "hi"' }] };
    outputResult(data, 'items', { csv: true });
    const dataRow = logSpy.mock.calls[1][0];
    expect(dataRow).toContain('"hello, world"');
    expect(dataRow).toContain('"say ""hi"""');
  });

  it('flattens nested objects for csv/table output', () => {
    const data = { items: [{ meta: { score: 5, file: 'a.js' } }] };
    outputResult(data, 'items', { csv: true });
    const header = logSpy.mock.calls[0][0];
    expect(header).toContain('meta.score');
    expect(header).toContain('meta.file');
  });
});
