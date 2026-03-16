/**
 * MCP middleware helpers — pagination defaults and limits.
 */

import { MCP_DEFAULTS, MCP_MAX_LIMIT } from '../shared/paginate.js';

export { MCP_DEFAULTS, MCP_MAX_LIMIT };

/**
 * Resolve effective limit for a tool call.
 * @param {object} args - Tool arguments
 * @param {string} toolName - Tool name (for default lookup)
 * @returns {number}
 */
export function effectiveLimit(args, toolName) {
  return Math.min(args.limit ?? MCP_DEFAULTS[toolName] ?? 100, MCP_MAX_LIMIT);
}

/**
 * Resolve effective offset for a tool call.
 * @param {object} args - Tool arguments
 * @returns {number}
 */
export function effectiveOffset(args) {
  return args.offset ?? 0;
}
