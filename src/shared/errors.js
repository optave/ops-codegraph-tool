/**
 * Domain error hierarchy for codegraph.
 *
 * Library code throws these instead of calling process.exit() or throwing
 * bare Error instances. The CLI top-level catch formats them for humans;
 * MCP returns structured { isError, code } responses.
 */

export class CodegraphError extends Error {
  /** @type {string} */
  code;

  /** @type {string|undefined} */
  file;

  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.code]
   * @param {string} [opts.file]  - Related file path, if applicable
   * @param {Error}  [opts.cause] - Original error that triggered this one
   */
  constructor(message, { code = 'CODEGRAPH_ERROR', file, cause } = {}) {
    super(message, { cause });
    this.name = 'CodegraphError';
    this.code = code;
    this.file = file;
  }
}

export class ParseError extends CodegraphError {
  constructor(message, opts = {}) {
    super(message, { code: 'PARSE_FAILED', ...opts });
    this.name = 'ParseError';
  }
}

export class DbError extends CodegraphError {
  constructor(message, opts = {}) {
    super(message, { code: 'DB_ERROR', ...opts });
    this.name = 'DbError';
  }
}

export class ConfigError extends CodegraphError {
  constructor(message, opts = {}) {
    super(message, { code: 'CONFIG_INVALID', ...opts });
    this.name = 'ConfigError';
  }
}

export class ResolutionError extends CodegraphError {
  constructor(message, opts = {}) {
    super(message, { code: 'RESOLUTION_FAILED', ...opts });
    this.name = 'ResolutionError';
  }
}

export class EngineError extends CodegraphError {
  constructor(message, opts = {}) {
    super(message, { code: 'ENGINE_UNAVAILABLE', ...opts });
    this.name = 'EngineError';
  }
}

export class AnalysisError extends CodegraphError {
  constructor(message, opts = {}) {
    super(message, { code: 'ANALYSIS_FAILED', ...opts });
    this.name = 'AnalysisError';
  }
}

export class BoundaryError extends CodegraphError {
  constructor(message, opts = {}) {
    super(message, { code: 'BOUNDARY_VIOLATION', ...opts });
    this.name = 'BoundaryError';
  }
}
