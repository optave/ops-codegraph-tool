/**
 * MCP middleware helpers — pagination defaults and limits.
 */

import { getMcpDefaults, MCP_DEFAULTS, MCP_MAX_LIMIT } from '../shared/paginate.js';

export { MCP_DEFAULTS, MCP_MAX_LIMIT };

/** Resolved MCP defaults (may include config overrides). Set via initMcpDefaults(). */
let resolvedDefaults: Record<string, number> = MCP_DEFAULTS;

/**
 * Initialize MCP defaults from config. Call once at server startup.
 */
export function initMcpDefaults(configMcpDefaults?: Record<string, number>): void {
  resolvedDefaults = getMcpDefaults(configMcpDefaults) as Record<string, number>;
}

/**
 * Reset MCP defaults back to the base defaults. Useful for test isolation.
 */
export function resetMcpDefaults(): void {
  resolvedDefaults = MCP_DEFAULTS;
}

/**
 * Resolve effective limit for a tool call.
 */
export function effectiveLimit(args: { limit?: number }, toolName: string): number {
  return Math.min(args.limit ?? resolvedDefaults[toolName] ?? 100, MCP_MAX_LIMIT);
}

/**
 * Resolve effective offset for a tool call.
 */
export function effectiveOffset(args: { offset?: number }): number {
  return args.offset ?? 0;
}
