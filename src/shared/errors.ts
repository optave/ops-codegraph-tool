/**
 * Domain error hierarchy for codegraph.
 *
 * Library code throws these instead of calling process.exit() or throwing
 * bare Error instances. The CLI top-level catch formats them for humans;
 * MCP returns structured { isError, code } responses.
 */

import { debug } from '../infrastructure/logger.js';

export interface CodegraphErrorOpts {
  code?: string;
  file?: string;
  cause?: Error;
}

export class CodegraphError extends Error {
  code: string;
  file: string | undefined;

  constructor(message: string, { code = 'CODEGRAPH_ERROR', file, cause }: CodegraphErrorOpts = {}) {
    super(message, { cause });
    this.name = 'CodegraphError';
    this.code = code;
    this.file = file;
  }
}

export class ParseError extends CodegraphError {
  constructor(message: string, opts: CodegraphErrorOpts = {}) {
    super(message, { code: 'PARSE_FAILED', ...opts });
    this.name = 'ParseError';
  }
}

export class DbError extends CodegraphError {
  constructor(message: string, opts: CodegraphErrorOpts = {}) {
    super(message, { code: 'DB_ERROR', ...opts });
    this.name = 'DbError';
  }
}

export class ConfigError extends CodegraphError {
  constructor(message: string, opts: CodegraphErrorOpts = {}) {
    super(message, { code: 'CONFIG_INVALID', ...opts });
    this.name = 'ConfigError';
  }
}

export class ResolutionError extends CodegraphError {
  constructor(message: string, opts: CodegraphErrorOpts = {}) {
    super(message, { code: 'RESOLUTION_FAILED', ...opts });
    this.name = 'ResolutionError';
  }
}

export class EngineError extends CodegraphError {
  constructor(message: string, opts: CodegraphErrorOpts = {}) {
    super(message, { code: 'ENGINE_UNAVAILABLE', ...opts });
    this.name = 'EngineError';
  }
}

export class AnalysisError extends CodegraphError {
  constructor(message: string, opts: CodegraphErrorOpts = {}) {
    super(message, { code: 'ANALYSIS_FAILED', ...opts });
    this.name = 'AnalysisError';
  }
}

export class BoundaryError extends CodegraphError {
  constructor(message: string, opts: CodegraphErrorOpts = {}) {
    super(message, { code: 'BOUNDARY_VIOLATION', ...opts });
    this.name = 'BoundaryError';
  }
}

/** Safely extract a string message from an unknown thrown value. */
export function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Run `fn` and return its result. If it throws, log a debug message and
 * return `fallback` instead. Use this for intentional catch suppression
 * where the error is expected and non-fatal (e.g. optional file reads,
 * graceful feature probes, cleanup that may fail).
 *
 * @example
 *   const version = suppressError(() => readPkgVersion(), 'read package version', '');
 */
export function suppressError<T>(fn: () => T, context: string, fallback: T): T {
  try {
    return fn();
  } catch (e: unknown) {
    debug(`${context}: ${toErrorMessage(e)}`);
    return fallback;
  }
}

/**
 * Async variant of {@link suppressError}. Awaits `fn()` and returns `fallback`
 * on rejection, logging the error via `debug()`.
 *
 * @example
 *   const data = await suppressErrorAsync(() => fetchOptionalData(), 'fetch data', null);
 */
export async function suppressErrorAsync<T>(
  fn: () => Promise<T>,
  context: string,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (e: unknown) {
    debug(`${context}: ${toErrorMessage(e)}`);
    return fallback;
  }
}
