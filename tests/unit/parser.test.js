/**
 * Unit tests for isWasmAvailable() in src/parser.js
 */

import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isWasmAvailable, LANGUAGE_REGISTRY } from '../../src/domain/parser.js';

describe('isWasmAvailable', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a boolean', () => {
    expect(typeof isWasmAvailable()).toBe('boolean');
  });

  it('returns true when all required grammar files exist', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    expect(isWasmAvailable()).toBe(true);
  });

  it('returns false when any required grammar file is missing', () => {
    // First call returns true (JS), second returns false (TS missing)
    const mock = vi.spyOn(fs, 'existsSync');
    let callCount = 0;
    mock.mockImplementation(() => {
      callCount++;
      return callCount !== 2; // second required grammar "missing"
    });
    expect(isWasmAvailable()).toBe(false);
  });

  it('returns false when all required grammar files are missing', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(isWasmAvailable()).toBe(false);
  });

  it('only checks required grammars (JS, TS, TSX)', () => {
    const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    isWasmAvailable();

    const requiredEntries = LANGUAGE_REGISTRY.filter((e) => e.required);
    expect(requiredEntries.length).toBe(3);
    expect(spy).toHaveBeenCalledTimes(3);

    // Verify it checks the correct grammar files
    for (const entry of requiredEntries) {
      expect(spy).toHaveBeenCalledWith(expect.stringContaining(entry.grammarFile));
    }
  });

  it('checks files in the grammars/ directory', () => {
    const spy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    isWasmAvailable();

    for (const call of spy.mock.calls) {
      expect(call[0]).toContain('grammars');
    }
  });
});
