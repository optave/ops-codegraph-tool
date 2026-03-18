/**
 * MCP middleware helpers — pagination defaults and limits.
 */

import { getMcpDefaults, MCP_DEFAULTS, MCP_MAX_LIMIT } from '../shared/paginate.js';

export { MCP_DEFAULTS, MCP_MAX_LIMIT };

/** Resolved MCP defaults (may include config overrides). Set via initMcpDefaults(). */
let resolvedDefaults = MCP_DEFAULTS;

/**
 * Initialize MCP defaults from config. Call once at server startup.
 * @param {object} [configMcpDefaults] - config.mcp.defaults overrides
 */
export function initMcpDefaults(configMcpDefaults) {
  resolvedDefaults = getMcpDefaults(configMcpDefaults);
}

/**
 * Resolve effective limit for a tool call.
 * @param {object} args - Tool arguments
 * @param {string} toolName - Tool name (for default lookup)
 * @returns {number}
 */
export function effectiveLimit(args, toolName) {
  return Math.min(args.limit ?? resolvedDefaults[toolName] ?? 100, MCP_MAX_LIMIT);
}

/**
 * Resolve effective offset for a tool call.
 * @param {object} args - Tool arguments
 * @returns {number}
 */
export function effectiveOffset(args) {
  return args.offset ?? 0;
}
