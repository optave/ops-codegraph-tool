/**
 * Unit tests for the domain error hierarchy (src/errors.js).
 */

import { describe, expect, it } from 'vitest';
import {
  AnalysisError,
  BoundaryError,
  CodegraphError,
  ConfigError,
  DbError,
  EngineError,
  ParseError,
  ResolutionError,
} from '../../src/shared/errors.js';

describe('CodegraphError', () => {
  it('sets defaults', () => {
    const err = new CodegraphError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CodegraphError);
    expect(err.name).toBe('CodegraphError');
    expect(err.code).toBe('CODEGRAPH_ERROR');
    expect(err.message).toBe('boom');
    expect(err.file).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });

  it('accepts opts', () => {
    const cause = new Error('root');
    const err = new CodegraphError('msg', { code: 'CUSTOM', file: 'foo.js', cause });
    expect(err.code).toBe('CUSTOM');
    expect(err.file).toBe('foo.js');
    expect(err.cause).toBe(cause);
  });
});

describe('subclasses', () => {
  const cases = [
    { Class: ParseError, name: 'ParseError', code: 'PARSE_FAILED' },
    { Class: DbError, name: 'DbError', code: 'DB_ERROR' },
    { Class: ConfigError, name: 'ConfigError', code: 'CONFIG_INVALID' },
    { Class: ResolutionError, name: 'ResolutionError', code: 'RESOLUTION_FAILED' },
    { Class: EngineError, name: 'EngineError', code: 'ENGINE_UNAVAILABLE' },
    { Class: AnalysisError, name: 'AnalysisError', code: 'ANALYSIS_FAILED' },
    { Class: BoundaryError, name: 'BoundaryError', code: 'BOUNDARY_VIOLATION' },
  ];

  for (const { Class, name, code } of cases) {
    it(`${name} has correct defaults and instanceof chain`, () => {
      const err = new Class('test');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(CodegraphError);
      expect(err).toBeInstanceOf(Class);
      expect(err.name).toBe(name);
      expect(err.code).toBe(code);
      expect(err.message).toBe('test');
    });

    it(`${name} forwards file and cause`, () => {
      const cause = new Error('root');
      const err = new Class('msg', { file: 'bar.js', cause });
      expect(err.file).toBe('bar.js');
      expect(err.cause).toBe(cause);
      // code should stay as the subclass default
      expect(err.code).toBe(code);
    });
  }
});
