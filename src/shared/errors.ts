/**
 * Domain error hierarchy for codegraph.
 *
 * Library code throws these instead of calling process.exit() or throwing
 * bare Error instances. The CLI top-level catch formats them for humans;
 * MCP returns structured { isError, code } responses.
 */

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
