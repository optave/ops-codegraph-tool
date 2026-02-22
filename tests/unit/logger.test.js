/**
 * Unit tests for src/logger.js
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { debug, error, info, isVerbose, setVerbose, warn } from '../../src/logger.js';

describe('logger', () => {
  let stderrSpy;

  afterEach(() => {
    setVerbose(false);
    if (stderrSpy) stderrSpy.mockRestore();
  });

  describe('setVerbose / isVerbose', () => {
    it('defaults to false', () => {
      expect(isVerbose()).toBe(false);
    });

    it('round-trips to true', () => {
      setVerbose(true);
      expect(isVerbose()).toBe(true);
    });

    it('round-trips back to false', () => {
      setVerbose(true);
      setVerbose(false);
      expect(isVerbose()).toBe(false);
    });
  });

  describe('warn', () => {
    it('writes WARN prefix and message to stderr', () => {
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      warn('something broke');
      expect(stderrSpy).toHaveBeenCalledOnce();
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toContain('WARN');
      expect(output).toContain('something broke');
      expect(output).toMatch(/\n$/);
    });
  });

  describe('info', () => {
    it('writes codegraph prefix and message to stderr', () => {
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      info('indexing files');
      expect(stderrSpy).toHaveBeenCalledOnce();
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toContain('codegraph');
      expect(output).toContain('indexing files');
      expect(output).toMatch(/\n$/);
    });
  });

  describe('error', () => {
    it('writes ERROR prefix and message to stderr', () => {
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      error('fatal crash');
      expect(stderrSpy).toHaveBeenCalledOnce();
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toContain('ERROR');
      expect(output).toContain('fatal crash');
      expect(output).toMatch(/\n$/);
    });
  });

  describe('debug', () => {
    it('writes nothing when verbose is false', () => {
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      debug('hidden message');
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('writes DEBUG prefix and message when verbose is true', () => {
      setVerbose(true);
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      debug('detailed info');
      expect(stderrSpy).toHaveBeenCalledOnce();
      const output = stderrSpy.mock.calls[0][0];
      expect(output).toContain('DEBUG');
      expect(output).toContain('detailed info');
      expect(output).toMatch(/\n$/);
    });
  });
});
