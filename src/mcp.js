/**
 * MCP (Model Context Protocol) server for codegraph.
 * Exposes codegraph queries as tools that AI coding assistants can call.
 *
 * Requires: npm install @modelcontextprotocol/sdk
 */

import { createRequire } from 'node:module';
import { findCycles } from './cycles.js';
import { findDbPath } from './db.js';
import { ALL_SYMBOL_KINDS, diffImpactMermaid, VALID_ROLES } from './queries.js';

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
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
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
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
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
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
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
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
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
        file: {
          type: 'string',
          description: 'Scope search to functions in this file (partial match)',
        },
        kind: {
          type: 'string',
          enum: ALL_SYMBOL_KINDS,
          description: 'Filter to a specific symbol kind',
        },
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
        file: {
          type: 'string',
          description: 'Scope search to functions in this file (partial match)',
        },
        kind: {
          type: 'string',
          enum: ALL_SYMBOL_KINDS,
          description: 'Filter to a specific symbol kind',
        },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
      },
      required: ['name'],
    },
  },
  {
    name: 'symbol_path',
    description: 'Find the shortest path between two symbols in the call graph (A calls...calls B)',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source symbol name (partial match)' },
        to: { type: 'string', description: 'Target symbol name (partial match)' },
        max_depth: { type: 'number', description: 'Maximum BFS depth', default: 10 },
        edge_kinds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Edge kinds to follow (default: ["calls"])',
        },
        reverse: { type: 'boolean', description: 'Follow edges backward', default: false },
        from_file: { type: 'string', description: 'Disambiguate source by file (partial match)' },
        to_file: { type: 'string', description: 'Disambiguate target by file (partial match)' },
        kind: {
          type: 'string',
          enum: ALL_SYMBOL_KINDS,
          description: 'Filter both symbols by kind',
        },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'context',
    description:
      'Full context for a function: source code, dependencies with summaries, callers, signature, and related tests — everything needed to understand or modify a function in one call',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Function/method/class name (partial match)' },
        depth: {
          type: 'number',
          description: 'Include callee source up to N levels deep (0=no source, 1=direct)',
          default: 0,
        },
        file: {
          type: 'string',
          description: 'Scope search to functions in this file (partial match)',
        },
        kind: {
          type: 'string',
          enum: ALL_SYMBOL_KINDS,
          description: 'Filter to a specific symbol kind',
        },
        no_source: {
          type: 'boolean',
          description: 'Skip source extraction (metadata only)',
          default: false,
        },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
        include_tests: {
          type: 'boolean',
          description: 'Include test file source code',
          default: false,
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'explain',
    description:
      'Structural summary of a file or function: public/internal API, data flow, dependencies. No LLM needed.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'File path or function name' },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
      },
      required: ['target'],
    },
  },
  {
    name: 'where',
    description:
      'Find where a symbol is defined and used, or list symbols/imports/exports for a file. Minimal, fast lookup.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Symbol name or file path' },
        file_mode: {
          type: 'boolean',
          description: 'Treat target as file path (list symbols/imports/exports)',
          default: false,
        },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
      },
      required: ['target'],
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
        format: {
          type: 'string',
          enum: ['json', 'mermaid'],
          description: 'Output format (default: json)',
        },
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
      'Show project structure with directory hierarchy, cohesion scores, and per-file metrics. Per-file details are capped at 25 files by default; use full=true to show all.',
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
        full: {
          type: 'boolean',
          description: 'Return all files without limit',
          default: false,
        },
      },
    },
  },
  {
    name: 'node_roles',
    description:
      'Show node role classification (entry, core, utility, adapter, dead, leaf) based on connectivity patterns',
    inputSchema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          enum: VALID_ROLES,
          description: 'Filter to a specific role',
        },
        file: { type: 'string', description: 'Scope to a specific file (partial match)' },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
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
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
      },
    },
  },
  {
    name: 'co_changes',
    description:
      'Find files that historically change together based on git commit history. Requires prior `codegraph co-change --analyze`.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'File path (partial match). Omit for top global pairs.',
        },
        limit: { type: 'number', description: 'Max results', default: 20 },
        min_jaccard: {
          type: 'number',
          description: 'Minimum Jaccard similarity (0-1)',
          default: 0.3,
        },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
      },
    },
  },
  {
    name: 'execution_flow',
    description:
      'Trace execution flow forward from an entry point (route, command, event) through callees to leaf functions. Answers "what happens when X is called?"',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Entry point or function name (e.g. "POST /login", "build"). Supports prefix-stripped matching.',
        },
        depth: { type: 'number', description: 'Max forward traversal depth', default: 10 },
        file: {
          type: 'string',
          description: 'Scope search to functions in this file (partial match)',
        },
        kind: {
          type: 'string',
          enum: ALL_SYMBOL_KINDS,
          description: 'Filter to a specific symbol kind',
        },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_entry_points',
    description:
      'List all framework entry points (routes, commands, events) in the codebase, grouped by type',
    inputSchema: {
      type: 'object',
      properties: {
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
      },
    },
  },
  {
    name: 'complexity',
    description:
      'Show per-function complexity metrics (cognitive, cyclomatic, max nesting depth). Sorted by most complex first.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Function name filter (partial match)' },
        file: { type: 'string', description: 'Scope to file (partial match)' },
        limit: { type: 'number', description: 'Max results', default: 20 },
        sort: {
          type: 'string',
          enum: ['cognitive', 'cyclomatic', 'nesting'],
          description: 'Sort metric',
          default: 'cognitive',
        },
        above_threshold: {
          type: 'boolean',
          description: 'Only functions exceeding warn thresholds',
          default: false,
        },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
        kind: {
          type: 'string',
          description: 'Filter by symbol kind (function, method, class, etc.)',
        },
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
    pathData,
    contextData,
    explainData,
    whereData,
    diffImpactData,
    listFunctionsData,
    rolesData,
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
          result = queryNameData(args.name, dbPath, { noTests: args.no_tests });
          break;
        case 'file_deps':
          result = fileDepsData(args.file, dbPath, { noTests: args.no_tests });
          break;
        case 'impact_analysis':
          result = impactAnalysisData(args.file, dbPath, { noTests: args.no_tests });
          break;
        case 'find_cycles': {
          const db = new Database(findDbPath(dbPath), { readonly: true });
          const cycles = findCycles(db);
          db.close();
          result = { cycles, count: cycles.length };
          break;
        }
        case 'module_map':
          result = moduleMapData(dbPath, args.limit || 20, { noTests: args.no_tests });
          break;
        case 'fn_deps':
          result = fnDepsData(args.name, dbPath, {
            depth: args.depth,
            file: args.file,
            kind: args.kind,
            noTests: args.no_tests,
          });
          break;
        case 'fn_impact':
          result = fnImpactData(args.name, dbPath, {
            depth: args.depth,
            file: args.file,
            kind: args.kind,
            noTests: args.no_tests,
          });
          break;
        case 'symbol_path':
          result = pathData(args.from, args.to, dbPath, {
            maxDepth: args.max_depth,
            edgeKinds: args.edge_kinds,
            reverse: args.reverse,
            fromFile: args.from_file,
            toFile: args.to_file,
            kind: args.kind,
            noTests: args.no_tests,
          });
          break;
        case 'context':
          result = contextData(args.name, dbPath, {
            depth: args.depth,
            file: args.file,
            kind: args.kind,
            noSource: args.no_source,
            noTests: args.no_tests,
            includeTests: args.include_tests,
          });
          break;
        case 'explain':
          result = explainData(args.target, dbPath, { noTests: args.no_tests });
          break;
        case 'where':
          result = whereData(args.target, dbPath, {
            file: args.file_mode,
            noTests: args.no_tests,
          });
          break;
        case 'diff_impact':
          if (args.format === 'mermaid') {
            result = diffImpactMermaid(dbPath, {
              staged: args.staged,
              ref: args.ref,
              depth: args.depth,
              noTests: args.no_tests,
            });
          } else {
            result = diffImpactData(dbPath, {
              staged: args.staged,
              ref: args.ref,
              depth: args.depth,
              noTests: args.no_tests,
            });
          }
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
        case 'node_roles':
          result = rolesData(dbPath, {
            role: args.role,
            file: args.file,
            noTests: args.no_tests,
          });
          break;
        case 'structure': {
          const { structureData } = await import('./structure.js');
          result = structureData(dbPath, {
            directory: args.directory,
            depth: args.depth,
            sort: args.sort,
            full: args.full,
          });
          break;
        }
        case 'hotspots': {
          const { hotspotsData } = await import('./structure.js');
          result = hotspotsData(dbPath, {
            metric: args.metric,
            level: args.level,
            limit: args.limit,
            noTests: args.no_tests,
          });
          break;
        }
        case 'co_changes': {
          const { coChangeData, coChangeTopData } = await import('./cochange.js');
          result = args.file
            ? coChangeData(args.file, dbPath, {
                limit: args.limit,
                minJaccard: args.min_jaccard,
                noTests: args.no_tests,
              })
            : coChangeTopData(dbPath, {
                limit: args.limit,
                minJaccard: args.min_jaccard,
                noTests: args.no_tests,
              });
          break;
        }
        case 'execution_flow': {
          const { flowData } = await import('./flow.js');
          result = flowData(args.name, dbPath, {
            depth: args.depth,
            file: args.file,
            kind: args.kind,
            noTests: args.no_tests,
          });
          break;
        }
        case 'list_entry_points': {
          const { listEntryPointsData } = await import('./flow.js');
          result = listEntryPointsData(dbPath, {
            noTests: args.no_tests,
          });
          break;
        }
        case 'complexity': {
          const { complexityData } = await import('./complexity.js');
          result = complexityData(dbPath, {
            target: args.name,
            file: args.file,
            limit: args.limit,
            sort: args.sort,
            aboveThreshold: args.above_threshold,
            noTests: args.no_tests,
            kind: args.kind,
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
