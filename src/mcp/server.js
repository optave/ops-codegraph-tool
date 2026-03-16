/**
 * MCP (Model Context Protocol) server for codegraph.
 * Exposes codegraph queries as tools that AI coding assistants can call.
 *
 * Requires: npm install @modelcontextprotocol/sdk
 */

import { createRequire } from 'node:module';
import { findDbPath } from '../db/index.js';
import { CodegraphError, ConfigError } from '../errors.js';
import { MCP_MAX_LIMIT } from '../paginate.js';
import { buildToolList } from './tool-registry.js';
import { TOOL_HANDLERS } from './tools/index.js';

/**
 * Start the MCP server.
 * This function requires @modelcontextprotocol/sdk to be installed.
 *
 * @param {string} [customDbPath] - Path to a specific graph.db
 * @param {object} [options]
 * @param {boolean} [options.multiRepo] - Enable multi-repo access (default: false)
 * @param {string[]} [options.allowedRepos] - Restrict access to these repo names only
 */
export async function startMCPServer(customDbPath, options = {}) {
  const { allowedRepos } = options;
  const multiRepo = options.multiRepo || !!allowedRepos;
  let Server, StdioServerTransport, ListToolsRequestSchema, CallToolRequestSchema;
  try {
    const sdk = await import('@modelcontextprotocol/sdk/server/index.js');
    Server = sdk.Server;
    const transport = await import('@modelcontextprotocol/sdk/server/stdio.js');
    StdioServerTransport = transport.StdioServerTransport;
    const types = await import('@modelcontextprotocol/sdk/types.js');
    ListToolsRequestSchema = types.ListToolsRequestSchema;
    CallToolRequestSchema = types.CallToolRequestSchema;
  } catch {
    throw new ConfigError(
      'MCP server requires @modelcontextprotocol/sdk.\nInstall it with: npm install @modelcontextprotocol/sdk',
    );
  }

  // Connect transport FIRST so the server can receive the client's
  // `initialize` request while heavy modules (queries, better-sqlite3)
  // are still loading.  These are lazy-loaded on the first tool call
  // and cached for subsequent calls.
  let _queries;
  let _Database;

  async function getQueries() {
    if (!_queries) {
      _queries = await import('../domain/queries.js');
    }
    return _queries;
  }

  function getDatabase() {
    if (!_Database) {
      const require = createRequire(import.meta.url);
      _Database = require('better-sqlite3');
    }
    return _Database;
  }

  const server = new Server(
    { name: 'codegraph', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolList(multiRepo),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
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

      let dbPath = customDbPath || undefined;
      if (args.repo) {
        if (allowedRepos && !allowedRepos.includes(args.repo)) {
          throw new ConfigError(`Repository "${args.repo}" is not in the allowed repos list.`);
        }
        const { resolveRepoDbPath } = await import('../registry.js');
        const resolved = resolveRepoDbPath(args.repo);
        if (!resolved)
          throw new ConfigError(
            `Repository "${args.repo}" not found in registry or its database is missing.`,
          );
        dbPath = resolved;
      }

      const toolEntry = TOOL_HANDLERS.get(name);
      if (!toolEntry) {
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }

      const ctx = {
        dbPath,
        getQueries,
        getDatabase,
        findDbPath,
        allowedRepos,
        MCP_MAX_LIMIT,
      };

      const result = await toolEntry.handler(args, ctx);
      if (result?.content) return result; // pass-through MCP responses
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const code = err instanceof CodegraphError ? err.code : 'UNKNOWN_ERROR';
      const text =
        err instanceof CodegraphError ? `[${code}] ${err.message}` : `Error: ${err.message}`;
      return { content: [{ type: 'text', text }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
