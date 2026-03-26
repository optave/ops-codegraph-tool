/**
 * MCP (Model Context Protocol) server for codegraph.
 * Exposes codegraph queries as tools that AI coding assistants can call.
 *
 * Requires: npm install @modelcontextprotocol/sdk
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../../package.json') as { version: string };

import { findDbPath } from '../db/index.js';
import { loadConfig } from '../infrastructure/config.js';
import { CodegraphError, ConfigError } from '../shared/errors.js';
import { MCP_MAX_LIMIT } from '../shared/paginate.js';
import type { CodegraphConfig, MCPServerOptions } from '../types.js';
import { initMcpDefaults } from './middleware.js';
import { buildToolList } from './tool-registry.js';
import { TOOL_HANDLERS } from './tools/index.js';

/**
 * Module-level guard to register shutdown handlers only once per process.
 * Because tests use vi.resetModules(), this module-level variable resets
 * on each re-import — but the process-level flag on `process` persists.
 */
let _activeServer: any = null;

export interface McpToolContext {
  dbPath: string | undefined;
  getQueries(): Promise<any>;
  getDatabase(): any;
  findDbPath: typeof findDbPath;
  allowedRepos: string[] | undefined;
  MCP_MAX_LIMIT: number;
}

interface MCPServerOptionsInternal extends MCPServerOptions {
  config?: CodegraphConfig;
}

async function loadMCPSdk(): Promise<{
  Server: unknown;
  StdioServerTransport: unknown;
  ListToolsRequestSchema: unknown;
  CallToolRequestSchema: unknown;
}> {
  try {
    const sdk = await import('@modelcontextprotocol/sdk/server/index.js');
    const transport = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const types = await import('@modelcontextprotocol/sdk/types.js');
    return {
      Server: sdk.Server,
      StdioServerTransport: transport.StdioServerTransport,
      ListToolsRequestSchema: types.ListToolsRequestSchema,
      CallToolRequestSchema: types.CallToolRequestSchema,
    };
  } catch {
    throw new ConfigError(
      'MCP server requires @modelcontextprotocol/sdk.\nInstall it with: npm install @modelcontextprotocol/sdk',
    );
  }
}

function createLazyLoaders(): {
  getQueries(): Promise<unknown>;
  getDatabase(): unknown;
} {
  let _queries: unknown;
  let _Database: unknown;
  return {
    async getQueries(): Promise<unknown> {
      if (!_queries) _queries = await import('../domain/queries.js');
      return _queries;
    },
    getDatabase(): unknown {
      if (!_Database) {
        const require = createRequire(import.meta.url);
        _Database = require('better-sqlite3');
      }
      return _Database;
    },
  };
}

async function resolveDbPath(
  customDbPath: string | undefined,
  args: { repo?: string },
  allowedRepos?: string[],
): Promise<string | undefined> {
  let dbPath = customDbPath || undefined;
  if (args.repo) {
    if (allowedRepos && !allowedRepos.includes(args.repo)) {
      throw new ConfigError(`Repository "${args.repo}" is not in the allowed repos list.`);
    }
    const { resolveRepoDbPath } = await import('../infrastructure/registry.js');
    const resolved = resolveRepoDbPath(args.repo);
    if (!resolved)
      throw new ConfigError(
        `Repository "${args.repo}" not found in registry or its database is missing.`,
      );
    dbPath = resolved;
  }
  return dbPath;
}

function validateMultiRepoAccess(multiRepo: boolean, name: string, args: { repo?: string }): void {
  if (!multiRepo && args.repo) {
    throw new ConfigError(
      'Multi-repo access is disabled. Restart with `codegraph mcp --multi-repo` to access other repositories.',
    );
  }
  if (!multiRepo && name === 'list_repos') {
    throw new ConfigError(
      'Multi-repo access is disabled. Restart with `codegraph mcp --multi-repo` to list repositories.',
    );
  }
}

export async function startMCPServer(
  customDbPath?: string,
  options: MCPServerOptionsInternal = {},
): Promise<void> {
  const { allowedRepos } = options;
  const multiRepo = options.multiRepo || !!allowedRepos;

  // Apply config-based MCP page-size overrides
  const config = options.config || loadConfig();
  initMcpDefaults(config.mcp?.defaults ? { ...config.mcp.defaults } : undefined);

  const { Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema } =
    await loadMCPSdk();

  // Connect transport FIRST so the server can receive the client's
  // `initialize` request while heavy modules (queries, better-sqlite3)
  // are still loading.  These are lazy-loaded on the first tool call
  // and cached for subsequent calls.
  const { getQueries, getDatabase } = createLazyLoaders();

  const server = new (Server as any)(
    { name: 'codegraph', version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolList(multiRepo),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: args } = request.params;
    try {
      validateMultiRepoAccess(multiRepo, name, args);
      const dbPath = await resolveDbPath(customDbPath, args, allowedRepos);

      const toolEntry = TOOL_HANDLERS.get(name);
      if (!toolEntry) {
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }

      const ctx: McpToolContext = {
        dbPath: dbPath,
        getQueries,
        getDatabase,
        findDbPath,
        allowedRepos,
        MCP_MAX_LIMIT,
      };
      const result: unknown = await toolEntry.handler(args, ctx);
      if (result && typeof result === 'object' && 'content' in result) {
        return result as { content: Array<{ type: string; text: string }> };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: unknown) {
      const code = err instanceof CodegraphError ? err.code : 'UNKNOWN_ERROR';
      const text =
        err instanceof CodegraphError
          ? `[${code}] ${err.message}`
          : `Error: ${(err as Error).message}`;
      return { content: [{ type: 'text', text }], isError: true };
    }
  });

  const transport = new (StdioServerTransport as any)();

  // Graceful shutdown — when the client disconnects (e.g. session clear),
  // close the server cleanly so the process exits without error.
  // Track the active server at module level so handlers always reference
  // the latest instance (matters when tests call startMCPServer repeatedly).
  _activeServer = server;

  // Register handlers once per process to avoid listener accumulation.
  // Use a process-level flag so it survives vi.resetModules() in tests.
  const g = globalThis as Record<string, unknown>;
  if (!g.__codegraph_shutdown_installed) {
    g.__codegraph_shutdown_installed = true;

    const shutdown = async () => {
      try {
        await _activeServer?.close();
      } catch {}
      process.exit(0);
    };
    const silentExit = (err: Error & { code?: string }) => {
      // Only suppress broken-pipe errors from closed stdio transport;
      // let real bugs surface with a non-zero exit code.
      if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
        process.exit(0);
      }
      process.stderr.write(`Uncaught exception: ${err.stack ?? err.message}\n`);
      process.exit(1);
    };
    const silentReject = (reason: unknown) => {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      const code = (err as Error & { code?: string }).code;
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
        process.exit(0);
      }
      process.stderr.write(`Unhandled rejection: ${err.stack ?? err.message}\n`);
      process.exit(1);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGHUP', shutdown);
    process.on('uncaughtException', silentExit);
    process.on('unhandledRejection', silentReject);
  }

  try {
    await server.connect(transport);
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
      process.exit(0);
    }
    process.stderr.write(
      `MCP transport connect failed: ${(err as Error).stack ?? (err as Error).message}\n`,
    );
    process.exit(1);
  }
}
