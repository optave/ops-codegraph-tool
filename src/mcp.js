/**
 * MCP (Model Context Protocol) server for codegraph.
 * Exposes codegraph queries as tools that AI coding assistants can call.
 *
 * Requires: npm install @modelcontextprotocol/sdk
 */

import { createRequire } from 'node:module';
import { findCycles } from './cycles.js';
import { findDbPath } from './db.js';

const REPO_PROP = {
  repo: {
    type: 'string',
    description: 'Repository name from the registry (omit for local project)',
  },
};

const BASE_TOOLS = [
  {
    name: 'query_function',
    description: 'Find callers and callees of a function by name',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Function name to query (supports partial match)' },
        depth: {
          type: 'number',
          description: 'Traversal depth for transitive callers',
          default: 2,
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'file_deps',
    description: 'Show what a file imports and what imports it',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path (partial match supported)' },
      },
      required: ['file'],
    },
  },
  {
    name: 'impact_analysis',
    description: 'Show files affected by changes to a given file (transitive)',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path to analyze' },
      },
      required: ['file'],
    },
  },
  {
    name: 'find_cycles',
    description: 'Detect circular dependencies in the codebase',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'module_map',
    description: 'Get high-level overview of most-connected files',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of top files to show', default: 20 },
      },
    },
  },
  {
    name: 'fn_deps',
    description: 'Show function-level dependency chain: what a function calls and what calls it',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Function/method/class name (partial match)' },
        depth: { type: 'number', description: 'Transitive caller depth', default: 3 },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
      },
      required: ['name'],
    },
  },
  {
    name: 'fn_impact',
    description:
      'Show function-level blast radius: all functions transitively affected by changes to a function',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Function/method/class name (partial match)' },
        depth: { type: 'number', description: 'Max traversal depth', default: 5 },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
      },
      required: ['name'],
    },
  },
  {
    name: 'diff_impact',
    description: 'Analyze git diff to find which functions changed and their transitive callers',
    inputSchema: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'Analyze staged changes only', default: false },
        ref: { type: 'string', description: 'Git ref to diff against (default: HEAD)' },
        depth: { type: 'number', description: 'Transitive caller depth', default: 3 },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
      },
    },
  },
  {
    name: 'semantic_search',
    description:
      'Search code symbols by meaning using embeddings (requires prior `codegraph embed`)',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        limit: { type: 'number', description: 'Max results to return', default: 15 },
        min_score: { type: 'number', description: 'Minimum similarity score (0-1)', default: 0.2 },
      },
      required: ['query'],
    },
  },
  {
    name: 'export_graph',
    description: 'Export the dependency graph in DOT (Graphviz), Mermaid, or JSON format',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['dot', 'mermaid', 'json'],
          description: 'Export format',
        },
        file_level: {
          type: 'boolean',
          description: 'File-level graph (true) or function-level (false)',
          default: true,
        },
      },
      required: ['format'],
    },
  },
  {
    name: 'list_functions',
    description:
      'List functions, methods, classes, structs, enums, traits, records, and modules in the codebase, optionally filtered by file or name pattern',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Filter by file path (partial match)' },
        pattern: { type: 'string', description: 'Filter by function name (partial match)' },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
      },
    },
  },
  {
    name: 'structure',
    description:
      'Show project structure with directory hierarchy, cohesion scores, and per-file metrics',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Filter to a specific directory path' },
        depth: { type: 'number', description: 'Max directory depth to show' },
        sort: {
          type: 'string',
          enum: ['cohesion', 'fan-in', 'fan-out', 'density', 'files'],
          description: 'Sort directories by metric',
        },
      },
    },
  },
  {
    name: 'hotspots',
    description:
      'Find structural hotspots: files or directories with extreme fan-in, fan-out, or symbol density',
    inputSchema: {
      type: 'object',
      properties: {
        metric: {
          type: 'string',
          enum: ['fan-in', 'fan-out', 'density', 'coupling'],
          description: 'Metric to rank by',
        },
        level: {
          type: 'string',
          enum: ['file', 'directory'],
          description: 'Rank files or directories',
        },
        limit: { type: 'number', description: 'Number of results to return', default: 10 },
      },
    },
  },
];

const LIST_REPOS_TOOL = {
  name: 'list_repos',
  description: 'List all repositories registered in the codegraph registry',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

/**
 * Build the tool list based on multi-repo mode.
 * @param {boolean} multiRepo - If true, inject `repo` prop into each tool and append `list_repos`
 * @returns {object[]}
 */
function buildToolList(multiRepo) {
  if (!multiRepo) return BASE_TOOLS;
  return [
    ...BASE_TOOLS.map((tool) => ({
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: { ...tool.inputSchema.properties, ...REPO_PROP },
      },
    })),
    LIST_REPOS_TOOL,
  ];
}

// Backward-compatible export: full multi-repo tool list
const TOOLS = buildToolList(true);

export { TOOLS, buildToolList };

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
    console.error(
      'MCP server requires @modelcontextprotocol/sdk.\n' +
        'Install it with: npm install @modelcontextprotocol/sdk',
    );
    process.exit(1);
  }

  // Lazy import query functions to avoid circular deps at module load
  const {
    queryNameData,
    impactAnalysisData,
    moduleMapData,
    fileDepsData,
    fnDepsData,
    fnImpactData,
    diffImpactData,
    listFunctionsData,
  } = await import('./queries.js');

  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');

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
        throw new Error(
          'Multi-repo access is disabled. Restart with `codegraph mcp --multi-repo` to access other repositories.',
        );
      }
      if (!multiRepo && name === 'list_repos') {
        throw new Error(
          'Multi-repo access is disabled. Restart with `codegraph mcp --multi-repo` to list repositories.',
        );
      }

      let dbPath = customDbPath || undefined;
      if (args.repo) {
        if (allowedRepos && !allowedRepos.includes(args.repo)) {
          throw new Error(`Repository "${args.repo}" is not in the allowed repos list.`);
        }
        const { resolveRepoDbPath } = await import('./registry.js');
        const resolved = resolveRepoDbPath(args.repo);
        if (!resolved)
          throw new Error(
            `Repository "${args.repo}" not found in registry or its database is missing.`,
          );
        dbPath = resolved;
      }

      let result;
      switch (name) {
        case 'query_function':
          result = queryNameData(args.name, dbPath);
          break;
        case 'file_deps':
          result = fileDepsData(args.file, dbPath);
          break;
        case 'impact_analysis':
          result = impactAnalysisData(args.file, dbPath);
          break;
        case 'find_cycles': {
          const db = new Database(findDbPath(dbPath), { readonly: true });
          const cycles = findCycles(db);
          db.close();
          result = { cycles, count: cycles.length };
          break;
        }
        case 'module_map':
          result = moduleMapData(dbPath, args.limit || 20);
          break;
        case 'fn_deps':
          result = fnDepsData(args.name, dbPath, {
            depth: args.depth,
            noTests: args.no_tests,
          });
          break;
        case 'fn_impact':
          result = fnImpactData(args.name, dbPath, {
            depth: args.depth,
            noTests: args.no_tests,
          });
          break;
        case 'diff_impact':
          result = diffImpactData(dbPath, {
            staged: args.staged,
            ref: args.ref,
            depth: args.depth,
            noTests: args.no_tests,
          });
          break;
        case 'semantic_search': {
          const { searchData } = await import('./embedder.js');
          result = await searchData(args.query, dbPath, {
            limit: args.limit,
            minScore: args.min_score,
          });
          if (result === null) {
            return {
              content: [
                { type: 'text', text: 'Semantic search unavailable. Run `codegraph embed` first.' },
              ],
              isError: true,
            };
          }
          break;
        }
        case 'export_graph': {
          const { exportDOT, exportMermaid, exportJSON } = await import('./export.js');
          const db = new Database(findDbPath(dbPath), { readonly: true });
          const fileLevel = args.file_level !== false;
          switch (args.format) {
            case 'dot':
              result = exportDOT(db, { fileLevel });
              break;
            case 'mermaid':
              result = exportMermaid(db, { fileLevel });
              break;
            case 'json':
              result = exportJSON(db);
              break;
            default:
              db.close();
              return {
                content: [
                  {
                    type: 'text',
                    text: `Unknown format: ${args.format}. Use dot, mermaid, or json.`,
                  },
                ],
                isError: true,
              };
          }
          db.close();
          break;
        }
        case 'list_functions':
          result = listFunctionsData(dbPath, {
            file: args.file,
            pattern: args.pattern,
            noTests: args.no_tests,
          });
          break;
        case 'structure': {
          const { structureData } = await import('./structure.js');
          result = structureData(dbPath, {
            directory: args.directory,
            depth: args.depth,
            sort: args.sort,
          });
          break;
        }
        case 'hotspots': {
          const { hotspotsData } = await import('./structure.js');
          result = hotspotsData(dbPath, {
            metric: args.metric,
            level: args.level,
            limit: args.limit,
          });
          break;
        }
        case 'list_repos': {
          const { listRepos, pruneRegistry } = await import('./registry.js');
          pruneRegistry();
          let repos = listRepos();
          if (allowedRepos) {
            repos = repos.filter((r) => allowedRepos.includes(r.name));
          }
          result = { repos };
          break;
        }
        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
