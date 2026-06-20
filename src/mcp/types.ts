/**
 * Shared MCP types used by server.ts and all tool modules.
 * Extracted here to break the circular dependency between server.ts and tools/index.ts.
 */

import type { findDbPath } from '../db/index.js';

export interface McpToolContext {
  dbPath: string | undefined;
  getQueries(): Promise<any>;
  getDatabase(): any;
  findDbPath: typeof findDbPath;
  allowedRepos: string[] | undefined;
  MCP_MAX_LIMIT: number;
}

export interface McpToolHandler {
  name: string;
  handler(args: any, ctx: McpToolContext): Promise<unknown>;
}
