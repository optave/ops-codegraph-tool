/**
 * MCP (Model Context Protocol) server for codegraph.
 * Exposes codegraph queries as tools that AI coding assistants can call.
 *
 * Requires: npm install @modelcontextprotocol/sdk
 */

import { createRequire } from 'node:module';
import { AST_NODE_KINDS } from './ast.js';
import { findCycles } from './cycles.js';
import { findDbPath } from './db.js';
import { MCP_DEFAULTS, MCP_MAX_LIMIT } from './paginate.js';
import { diffImpactMermaid, EVERY_EDGE_KIND, EVERY_SYMBOL_KIND, VALID_ROLES } from './queries.js';

const REPO_PROP = {
  repo: {
    type: 'string',
    description: 'Repository name from the registry (omit for local project)',
  },
};

const PAGINATION_PROPS = {
  limit: { type: 'number', description: 'Max results to return (pagination)' },
  offset: { type: 'number', description: 'Skip this many results (pagination, default: 0)' },
};

const BASE_TOOLS = [
  {
    name: 'query',
    description:
      'Query the call graph: find callers/callees with transitive chain, or find shortest path between two symbols',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Function/method/class name (partial match)' },
        mode: {
          type: 'string',
          enum: ['deps', 'path'],
          description: 'deps (default): dependency chain. path: shortest path to target',
        },
        depth: {
          type: 'number',
          description: 'Transitive depth (deps default: 3, path default: 10)',
        },
        file: {
          type: 'string',
          description: 'Scope search to functions in this file (partial match)',
        },
        kind: {
          type: 'string',
          enum: EVERY_SYMBOL_KIND,
          description: 'Filter by symbol kind',
        },
        to: { type: 'string', description: 'Target symbol for path mode (required in path mode)' },
        edge_kinds: {
          type: 'array',
          items: { type: 'string', enum: EVERY_EDGE_KIND },
          description: 'Edge kinds to follow in path mode (default: ["calls"])',
        },
        reverse: {
          type: 'boolean',
          description: 'Follow edges backward in path mode',
          default: false,
        },
        from_file: { type: 'string', description: 'Disambiguate source by file in path mode' },
        to_file: { type: 'string', description: 'Disambiguate target by file in path mode' },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
        ...PAGINATION_PROPS,
      },
      required: ['name'],
    },
  },
  {
    name: 'path',
    description: 'Find shortest path between two symbols in the dependency graph',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source symbol name' },
        to: { type: 'string', description: 'Target symbol name' },
        depth: { type: 'number', description: 'Max traversal depth (default: 10)' },
        edge_kinds: {
          type: 'array',
          items: { type: 'string', enum: EVERY_EDGE_KIND },
          description: 'Edge kinds to follow (default: ["calls"])',
        },
        from_file: { type: 'string', description: 'Disambiguate source by file' },
        to_file: { type: 'string', description: 'Disambiguate target by file' },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
      },
      required: ['from', 'to'],
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
        ...PAGINATION_PROPS,
      },
      required: ['file'],
    },
  },
  {
    name: 'file_exports',
    description:
      'Show exported symbols of a file with per-symbol consumers — who calls each export and from where',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path (partial match supported)' },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
        unused: {
          type: 'boolean',
          description: 'Show only exports with zero consumers',
          default: false,
        },
        ...PAGINATION_PROPS,
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
        ...PAGINATION_PROPS,
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
          enum: EVERY_SYMBOL_KIND,
          description: 'Filter to a specific symbol kind',
        },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
        ...PAGINATION_PROPS,
      },
      required: ['name'],
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
          enum: EVERY_SYMBOL_KIND,
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
        ...PAGINATION_PROPS,
      },
      required: ['name'],
    },
  },
  {
    name: 'symbol_children',
    description:
      'List sub-declaration children of a symbol: parameters, properties, constants. Answers "what fields does this class have?" without reading source.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Function/method/class name (partial match)' },
        file: { type: 'string', description: 'Scope to file (partial match)' },
        kind: { type: 'string', enum: EVERY_SYMBOL_KIND, description: 'Filter by symbol kind' },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
        ...PAGINATION_PROPS,
      },
      required: ['name'],
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
        ...PAGINATION_PROPS,
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
        ...PAGINATION_PROPS,
      },
    },
  },
  {
    name: 'semantic_search',
    description:
      'Search code symbols by meaning using embeddings and/or keyword matching (requires prior `codegraph embed`). Default hybrid mode combines BM25 keyword + semantic search for best results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        limit: { type: 'number', description: 'Max results to return', default: 15 },
        min_score: { type: 'number', description: 'Minimum similarity score (0-1)', default: 0.2 },
        mode: {
          type: 'string',
          enum: ['hybrid', 'semantic', 'keyword'],
          description:
            'Search mode: hybrid (BM25 + semantic, default), semantic (embeddings only), keyword (BM25 only)',
        },
        ...PAGINATION_PROPS,
      },
      required: ['query'],
    },
  },
  {
    name: 'export_graph',
    description:
      'Export the dependency graph in DOT, Mermaid, JSON, GraphML, GraphSON, or Neo4j CSV format',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['dot', 'mermaid', 'json', 'graphml', 'graphson', 'neo4j'],
          description: 'Export format',
        },
        file_level: {
          type: 'boolean',
          description: 'File-level graph (true) or function-level (false)',
          default: true,
        },
        ...PAGINATION_PROPS,
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
        ...PAGINATION_PROPS,
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
        ...PAGINATION_PROPS,
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
        ...PAGINATION_PROPS,
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
        offset: { type: 'number', description: 'Skip this many results (pagination, default: 0)' },
      },
    },
  },
  {
    name: 'execution_flow',
    description:
      'Trace execution flow forward from an entry point through callees to leaves, or list all entry points with list=true',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Entry point or function name (required unless list=true). Supports prefix-stripped matching.',
        },
        list: {
          type: 'boolean',
          description: 'List all entry points grouped by type',
          default: false,
        },
        depth: { type: 'number', description: 'Max forward traversal depth', default: 10 },
        file: {
          type: 'string',
          description: 'Scope search to functions in this file (partial match)',
        },
        kind: {
          type: 'string',
          enum: EVERY_SYMBOL_KIND,
          description: 'Filter to a specific symbol kind',
        },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
        ...PAGINATION_PROPS,
      },
    },
  },
  {
    name: 'sequence',
    description:
      'Generate a Mermaid sequence diagram from call graph edges. Participants are files, messages are function calls between them.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Entry point or function name to trace from (partial match)',
        },
        depth: { type: 'number', description: 'Max forward traversal depth', default: 10 },
        format: {
          type: 'string',
          enum: ['mermaid', 'json'],
          description: 'Output format (default: mermaid)',
        },
        dataflow: {
          type: 'boolean',
          description: 'Annotate with parameter names and return arrows',
          default: false,
        },
        file: {
          type: 'string',
          description: 'Scope search to functions in this file (partial match)',
        },
        kind: {
          type: 'string',
          enum: EVERY_SYMBOL_KIND,
          description: 'Filter to a specific symbol kind',
        },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
        ...PAGINATION_PROPS,
      },
      required: ['name'],
    },
  },
  {
    name: 'complexity',
    description:
      'Show per-function complexity metrics (cognitive, cyclomatic, nesting, Halstead, Maintainability Index). Sorted by most complex first.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Function name filter (partial match)' },
        file: { type: 'string', description: 'Scope to file (partial match)' },
        limit: { type: 'number', description: 'Max results', default: 20 },
        sort: {
          type: 'string',
          enum: ['cognitive', 'cyclomatic', 'nesting', 'mi', 'volume', 'effort', 'bugs', 'loc'],
          description: 'Sort metric',
          default: 'cognitive',
        },
        above_threshold: {
          type: 'boolean',
          description: 'Only functions exceeding warn thresholds',
          default: false,
        },
        health: {
          type: 'boolean',
          description: 'Include Halstead and Maintainability Index metrics',
          default: false,
        },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
        kind: {
          type: 'string',
          description: 'Filter by symbol kind (function, method, class, etc.)',
        },
        offset: { type: 'number', description: 'Skip this many results (pagination, default: 0)' },
      },
    },
  },
  {
    name: 'communities',
    description:
      'Detect natural module boundaries using Louvain community detection. Compares discovered communities against directory structure and surfaces architectural drift.',
    inputSchema: {
      type: 'object',
      properties: {
        functions: {
          type: 'boolean',
          description: 'Function-level instead of file-level',
          default: false,
        },
        resolution: {
          type: 'number',
          description: 'Louvain resolution parameter (higher = more communities)',
          default: 1.0,
        },
        drift: {
          type: 'boolean',
          description: 'Show only drift analysis (omit community member lists)',
          default: false,
        },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
        ...PAGINATION_PROPS,
      },
    },
  },
  {
    name: 'code_owners',
    description:
      'Show CODEOWNERS mapping for files and functions. Shows ownership coverage, per-owner breakdown, and cross-owner boundary edges.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Scope to a specific file (partial match)' },
        owner: { type: 'string', description: 'Filter to a specific owner (e.g. @team-name)' },
        boundary: {
          type: 'boolean',
          description: 'Show cross-owner boundary edges',
          default: false,
        },
        kind: {
          type: 'string',
          description: 'Filter by symbol kind (function, method, class, etc.)',
        },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
      },
    },
  },
  {
    name: 'audit',
    description:
      'Composite report combining explain, fn-impact, and health metrics for a file or function. Returns structure, blast radius, complexity, and threshold breaches in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'File path or function name' },
        quick: {
          type: 'boolean',
          description: 'Structural summary only (skip impact + health)',
          default: false,
        },
        depth: { type: 'number', description: 'Impact analysis depth (default: 3)', default: 3 },
        file: { type: 'string', description: 'Scope to file (partial match)' },
        kind: {
          type: 'string',
          description: 'Filter by symbol kind (function, method, class, etc.)',
        },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
        ...PAGINATION_PROPS,
      },
      required: ['target'],
    },
  },
  {
    name: 'batch_query',
    description:
      'Run a query command against multiple targets in one call. Returns all results in a single JSON payload — ideal for multi-agent dispatch.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: [
            'fn-impact',
            'context',
            'explain',
            'where',
            'query',
            'impact',
            'deps',
            'flow',
            'dataflow',
            'complexity',
          ],
          description: 'The query command to run for each target',
        },
        targets: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of target names (symbol names or file paths depending on command)',
        },
        depth: {
          type: 'number',
          description: 'Traversal depth (for fn-impact, context, fn, flow)',
        },
        file: {
          type: 'string',
          description: 'Scope to file (partial match)',
        },
        kind: {
          type: 'string',
          enum: EVERY_SYMBOL_KIND,
          description: 'Filter symbol kind',
        },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
      },
      required: ['command', 'targets'],
    },
  },
  {
    name: 'triage',
    description:
      'Ranked audit queue by composite risk score. Merges connectivity (fan-in), complexity (cognitive), churn (commit count), role classification, and maintainability index into a single weighted score.',
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['function', 'file', 'directory'],
          description:
            'Granularity: function (default) | file | directory. File/directory shows hotspots',
        },
        sort: {
          type: 'string',
          enum: ['risk', 'complexity', 'churn', 'fan-in', 'mi'],
          description: 'Sort metric (default: risk)',
        },
        min_score: {
          type: 'number',
          description: 'Only return symbols with risk score >= this threshold (0-1)',
        },
        role: {
          type: 'string',
          enum: VALID_ROLES,
          description: 'Filter by role classification',
        },
        file: { type: 'string', description: 'Scope to file (partial match)' },
        kind: {
          type: 'string',
          enum: ['function', 'method', 'class'],
          description: 'Filter by symbol kind',
        },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
        weights: {
          type: 'object',
          description:
            'Custom scoring weights (e.g. {"fanIn":1,"complexity":0,"churn":0,"role":0,"mi":0})',
        },
        ...PAGINATION_PROPS,
      },
    },
  },
  {
    name: 'branch_compare',
    description:
      'Compare code structure between two git refs (branches, tags, commits). Shows added/removed/changed symbols and transitive caller impact using temporary git worktrees.',
    inputSchema: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'Base git ref (branch, tag, or commit SHA)' },
        target: { type: 'string', description: 'Target git ref to compare against base' },
        depth: { type: 'number', description: 'Max transitive caller depth', default: 3 },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
        format: {
          type: 'string',
          enum: ['json', 'mermaid'],
          description: 'Output format (default: json)',
        },
      },
      required: ['base', 'target'],
    },
  },
  {
    name: 'cfg',
    description: 'Show intraprocedural control flow graph for a function.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Function/method name (partial match)' },
        format: {
          type: 'string',
          enum: ['json', 'dot', 'mermaid'],
          description: 'Output format (default: json)',
        },
        file: { type: 'string', description: 'Scope to file (partial match)' },
        kind: { type: 'string', enum: EVERY_SYMBOL_KIND, description: 'Filter by symbol kind' },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
        ...PAGINATION_PROPS,
      },
      required: ['name'],
    },
  },
  {
    name: 'dataflow',
    description: 'Show data flow edges or data-dependent blast radius.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Function/method name (partial match)' },
        mode: {
          type: 'string',
          enum: ['edges', 'impact'],
          description: 'edges (default) or impact',
        },
        depth: { type: 'number', description: 'Max depth for impact mode', default: 5 },
        file: { type: 'string', description: 'Scope to file (partial match)' },
        kind: { type: 'string', enum: EVERY_SYMBOL_KIND, description: 'Filter by symbol kind' },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
        ...PAGINATION_PROPS,
      },
      required: ['name'],
    },
  },
  {
    name: 'check',
    description:
      'CI gate: run manifesto rules (no args), diff predicates (with ref/staged), or both (with rules flag). Returns pass/fail verdicts.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Git ref to diff against (default: HEAD)' },
        staged: { type: 'boolean', description: 'Analyze staged changes instead of unstaged' },
        rules: {
          type: 'boolean',
          description: 'Also run manifesto rules alongside diff predicates',
        },
        cycles: { type: 'boolean', description: 'Enable cycles predicate (default: true)' },
        blast_radius: {
          type: 'number',
          description: 'Max transitive callers threshold (null = disabled)',
        },
        signatures: { type: 'boolean', description: 'Enable signatures predicate (default: true)' },
        boundaries: { type: 'boolean', description: 'Enable boundaries predicate (default: true)' },
        depth: { type: 'number', description: 'Max BFS depth for blast radius (default: 3)' },
        file: { type: 'string', description: 'Scope to file (partial match, manifesto mode)' },
        kind: {
          type: 'string',
          description: 'Filter by symbol kind (manifesto mode)',
        },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
        ...PAGINATION_PROPS,
      },
    },
  },
  {
    name: 'ast_query',
    description:
      'Search stored AST nodes (calls, literals, new, throw, await) by pattern. Requires a prior build.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'GLOB pattern for node name (auto-wrapped in *..* for substring match)',
        },
        kind: {
          type: 'string',
          enum: AST_NODE_KINDS,
          description: 'Filter by AST node kind',
        },
        file: { type: 'string', description: 'Scope to file (partial match)' },
        no_tests: { type: 'boolean', description: 'Exclude test files', default: false },
        ...PAGINATION_PROPS,
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

  // Connect transport FIRST so the server can receive the client's
  // `initialize` request while heavy modules (queries, better-sqlite3)
  // are still loading.  These are lazy-loaded on the first tool call
  // and cached for subsequent calls.
  let _queries;
  let _Database;

  async function getQueries() {
    if (!_queries) {
      _queries = await import('./queries.js');
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
    const {
      impactAnalysisData,
      moduleMapData,
      fileDepsData,
      exportsData,
      fnDepsData,
      fnImpactData,
      pathData,
      contextData,
      childrenData,
      explainData,
      whereData,
      diffImpactData,
      listFunctionsData,
      rolesData,
    } = await getQueries();
    const Database = getDatabase();

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
        case 'query': {
          const qMode = args.mode || 'deps';
          if (qMode === 'path') {
            if (!args.to) {
              result = { error: 'path mode requires a "to" argument' };
              break;
            }
            result = pathData(args.name, args.to, dbPath, {
              maxDepth: args.depth ?? 10,
              edgeKinds: args.edge_kinds,
              reverse: args.reverse,
              fromFile: args.from_file,
              toFile: args.to_file,
              kind: args.kind,
              noTests: args.no_tests,
            });
          } else {
            result = fnDepsData(args.name, dbPath, {
              depth: args.depth,
              file: args.file,
              kind: args.kind,
              noTests: args.no_tests,
              limit: Math.min(args.limit ?? MCP_DEFAULTS.query, MCP_MAX_LIMIT),
              offset: args.offset ?? 0,
            });
          }
          break;
        }
        case 'path':
          result = pathData(args.from, args.to, dbPath, {
            maxDepth: args.depth ?? 10,
            edgeKinds: args.edge_kinds,
            fromFile: args.from_file,
            toFile: args.to_file,
            noTests: args.no_tests,
          });
          break;
        case 'file_deps':
          result = fileDepsData(args.file, dbPath, {
            noTests: args.no_tests,
            limit: Math.min(args.limit ?? MCP_DEFAULTS.file_deps, MCP_MAX_LIMIT),
            offset: args.offset ?? 0,
          });
          break;
        case 'file_exports':
          result = exportsData(args.file, dbPath, {
            noTests: args.no_tests,
            unused: args.unused,
            limit: Math.min(args.limit ?? MCP_DEFAULTS.file_exports, MCP_MAX_LIMIT),
            offset: args.offset ?? 0,
          });
          break;
        case 'impact_analysis':
          result = impactAnalysisData(args.file, dbPath, {
            noTests: args.no_tests,
            limit: Math.min(args.limit ?? MCP_DEFAULTS.impact_analysis, MCP_MAX_LIMIT),
            offset: args.offset ?? 0,
          });
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
        case 'fn_impact':
          result = fnImpactData(args.name, dbPath, {
            depth: args.depth,
            file: args.file,
            kind: args.kind,
            noTests: args.no_tests,
            limit: Math.min(args.limit ?? MCP_DEFAULTS.fn_impact, MCP_MAX_LIMIT),
            offset: args.offset ?? 0,
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
            limit: Math.min(args.limit ?? MCP_DEFAULTS.context, MCP_MAX_LIMIT),
            offset: args.offset ?? 0,
          });
          break;
        case 'symbol_children':
          result = childrenData(args.name, dbPath, {
            file: args.file,
            kind: args.kind,
            noTests: args.no_tests,
            limit: Math.min(args.limit ?? MCP_DEFAULTS.context, MCP_MAX_LIMIT),
            offset: args.offset ?? 0,
          });
          break;
        case 'where':
          result = whereData(args.target, dbPath, {
            file: args.file_mode,
            noTests: args.no_tests,
            limit: Math.min(args.limit ?? MCP_DEFAULTS.where, MCP_MAX_LIMIT),
            offset: args.offset ?? 0,
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
              limit: Math.min(args.limit ?? MCP_DEFAULTS.diff_impact, MCP_MAX_LIMIT),
              offset: args.offset ?? 0,
            });
          }
          break;
        case 'semantic_search': {
          const mode = args.mode || 'hybrid';
          const searchOpts = {
            limit: Math.min(args.limit ?? MCP_DEFAULTS.semantic_search, MCP_MAX_LIMIT),
            offset: args.offset ?? 0,
            minScore: args.min_score,
          };

          if (mode === 'keyword') {
            const { ftsSearchData } = await import('./embedder.js');
            result = ftsSearchData(args.query, dbPath, searchOpts);
            if (result === null) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'No FTS5 index found. Run `codegraph embed` to build the keyword index.',
                  },
                ],
                isError: true,
              };
            }
          } else if (mode === 'semantic') {
            const { searchData } = await import('./embedder.js');
            result = await searchData(args.query, dbPath, searchOpts);
            if (result === null) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Semantic search unavailable. Run `codegraph embed` first.',
                  },
                ],
                isError: true,
              };
            }
          } else {
            // hybrid (default) — falls back to semantic if no FTS5
            const { hybridSearchData, searchData } = await import('./embedder.js');
            result = await hybridSearchData(args.query, dbPath, searchOpts);
            if (result === null) {
              result = await searchData(args.query, dbPath, searchOpts);
              if (result === null) {
                return {
                  content: [
                    {
                      type: 'text',
                      text: 'Semantic search unavailable. Run `codegraph embed` first.',
                    },
                  ],
                  isError: true,
                };
              }
            }
          }
          break;
        }
        case 'export_graph': {
          const {
            exportDOT,
            exportGraphML,
            exportGraphSON,
            exportJSON,
            exportMermaid,
            exportNeo4jCSV,
          } = await import('./export.js');
          const db = new Database(findDbPath(dbPath), { readonly: true });
          const fileLevel = args.file_level !== false;
          const exportLimit = args.limit
            ? Math.min(args.limit, MCP_MAX_LIMIT)
            : MCP_DEFAULTS.export_graph;
          switch (args.format) {
            case 'dot':
              result = exportDOT(db, { fileLevel, limit: exportLimit });
              break;
            case 'mermaid':
              result = exportMermaid(db, { fileLevel, limit: exportLimit });
              break;
            case 'json':
              result = exportJSON(db, {
                limit: exportLimit,
                offset: args.offset ?? 0,
              });
              break;
            case 'graphml':
              result = exportGraphML(db, { fileLevel, limit: exportLimit });
              break;
            case 'graphson':
              result = exportGraphSON(db, {
                fileLevel,
                limit: exportLimit,
                offset: args.offset ?? 0,
              });
              break;
            case 'neo4j':
              result = exportNeo4jCSV(db, { fileLevel, limit: exportLimit });
              break;
            default:
              db.close();
              return {
                content: [
                  {
                    type: 'text',
                    text: `Unknown format: ${args.format}. Use dot, mermaid, json, graphml, graphson, or neo4j.`,
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
            limit: Math.min(args.limit ?? MCP_DEFAULTS.list_functions, MCP_MAX_LIMIT),
            offset: args.offset ?? 0,
          });
          break;
        case 'node_roles':
          result = rolesData(dbPath, {
            role: args.role,
            file: args.file,
            noTests: args.no_tests,
            limit: Math.min(args.limit ?? MCP_DEFAULTS.node_roles, MCP_MAX_LIMIT),
            offset: args.offset ?? 0,
          });
          break;
        case 'structure': {
          const { structureData } = await import('./structure.js');
          result = structureData(dbPath, {
            directory: args.directory,
            depth: args.depth,
            sort: args.sort,
            full: args.full,
            limit: Math.min(args.limit ?? MCP_DEFAULTS.structure, MCP_MAX_LIMIT),
            offset: args.offset ?? 0,
          });
          break;
        }
        case 'co_changes': {
          const { coChangeData, coChangeTopData } = await import('./cochange.js');
          result = args.file
            ? coChangeData(args.file, dbPath, {
                limit: Math.min(args.limit ?? MCP_DEFAULTS.co_changes, MCP_MAX_LIMIT),
                offset: args.offset ?? 0,
                minJaccard: args.min_jaccard,
                noTests: args.no_tests,
              })
            : coChangeTopData(dbPath, {
                limit: Math.min(args.limit ?? MCP_DEFAULTS.co_changes, MCP_MAX_LIMIT),
                offset: args.offset ?? 0,
                minJaccard: args.min_jaccard,
                noTests: args.no_tests,
              });
          break;
        }
        case 'execution_flow': {
          if (args.list) {
            const { listEntryPointsData } = await import('./flow.js');
            result = listEntryPointsData(dbPath, {
              noTests: args.no_tests,
              limit: Math.min(args.limit ?? MCP_DEFAULTS.execution_flow, MCP_MAX_LIMIT),
              offset: args.offset ?? 0,
            });
          } else {
            if (!args.name) {
              result = { error: 'Provide a name or set list=true' };
              break;
            }
            const { flowData } = await import('./flow.js');
            result = flowData(args.name, dbPath, {
              depth: args.depth,
              file: args.file,
              kind: args.kind,
              noTests: args.no_tests,
              limit: Math.min(args.limit ?? MCP_DEFAULTS.execution_flow, MCP_MAX_LIMIT),
              offset: args.offset ?? 0,
            });
          }
          break;
        }
        case 'sequence': {
          const { sequenceData, sequenceToMermaid } = await import('./sequence.js');
          const seqResult = sequenceData(args.name, dbPath, {
            depth: args.depth,
            file: args.file,
            kind: args.kind,
            dataflow: args.dataflow,
            noTests: args.no_tests,
            limit: Math.min(args.limit ?? MCP_DEFAULTS.execution_flow, MCP_MAX_LIMIT),
            offset: args.offset ?? 0,
          });
          result =
            args.format === 'json'
              ? seqResult
              : { text: sequenceToMermaid(seqResult), ...seqResult };
          break;
        }
        case 'complexity': {
          const { complexityData } = await import('./complexity.js');
          result = complexityData(dbPath, {
            target: args.name,
            file: args.file,
            limit: Math.min(args.limit ?? MCP_DEFAULTS.complexity, MCP_MAX_LIMIT),
            offset: args.offset ?? 0,
            sort: args.sort,
            aboveThreshold: args.above_threshold,
            health: args.health,
            noTests: args.no_tests,
            kind: args.kind,
          });
          break;
        }
        case 'communities': {
          const { communitiesData } = await import('./communities.js');
          result = communitiesData(dbPath, {
            functions: args.functions,
            resolution: args.resolution,
            drift: args.drift,
            noTests: args.no_tests,
            limit: Math.min(args.limit ?? MCP_DEFAULTS.communities, MCP_MAX_LIMIT),
            offset: args.offset ?? 0,
          });
          break;
        }
        case 'code_owners': {
          const { ownersData } = await import('./owners.js');
          result = ownersData(dbPath, {
            file: args.file,
            owner: args.owner,
            boundary: args.boundary,
            kind: args.kind,
            noTests: args.no_tests,
          });
          break;
        }
        case 'audit': {
          if (args.quick) {
            result = explainData(args.target, dbPath, {
              noTests: args.no_tests,
              limit: Math.min(args.limit ?? MCP_DEFAULTS.explain, MCP_MAX_LIMIT),
              offset: args.offset ?? 0,
            });
          } else {
            const { auditData } = await import('./audit.js');
            result = auditData(args.target, dbPath, {
              depth: args.depth,
              file: args.file,
              kind: args.kind,
              noTests: args.no_tests,
            });
          }
          break;
        }
        case 'batch_query': {
          const { batchData } = await import('./batch.js');
          result = batchData(args.command, args.targets, dbPath, {
            depth: args.depth,
            file: args.file,
            kind: args.kind,
            noTests: args.no_tests,
          });
          break;
        }
        case 'triage': {
          if (args.level === 'file' || args.level === 'directory') {
            const { hotspotsData } = await import('./structure.js');
            const TRIAGE_TO_HOTSPOT = {
              risk: 'fan-in',
              complexity: 'density',
              churn: 'coupling',
              mi: 'fan-in',
            };
            const metric = TRIAGE_TO_HOTSPOT[args.sort] ?? args.sort;
            result = hotspotsData(dbPath, {
              metric,
              level: args.level,
              limit: Math.min(args.limit ?? MCP_DEFAULTS.hotspots, MCP_MAX_LIMIT),
              offset: args.offset ?? 0,
              noTests: args.no_tests,
            });
          } else {
            const { triageData } = await import('./triage.js');
            result = triageData(dbPath, {
              sort: args.sort,
              minScore: args.min_score,
              role: args.role,
              file: args.file,
              kind: args.kind,
              noTests: args.no_tests,
              weights: args.weights,
              limit: Math.min(args.limit ?? MCP_DEFAULTS.triage, MCP_MAX_LIMIT),
              offset: args.offset ?? 0,
            });
          }
          break;
        }
        case 'branch_compare': {
          const { branchCompareData, branchCompareMermaid } = await import('./branch-compare.js');
          const bcData = await branchCompareData(args.base, args.target, {
            depth: args.depth,
            noTests: args.no_tests,
          });
          result = args.format === 'mermaid' ? branchCompareMermaid(bcData) : bcData;
          break;
        }
        case 'cfg': {
          const { cfgData, cfgToDOT, cfgToMermaid } = await import('./cfg.js');
          const cfgResult = cfgData(args.name, dbPath, {
            file: args.file,
            kind: args.kind,
            noTests: args.no_tests,
            limit: Math.min(args.limit ?? MCP_DEFAULTS.query, MCP_MAX_LIMIT),
            offset: args.offset ?? 0,
          });
          if (args.format === 'dot') {
            result = { text: cfgToDOT(cfgResult) };
          } else if (args.format === 'mermaid') {
            result = { text: cfgToMermaid(cfgResult) };
          } else {
            result = cfgResult;
          }
          break;
        }
        case 'dataflow': {
          const dfMode = args.mode || 'edges';
          if (dfMode === 'impact') {
            const { dataflowImpactData } = await import('./dataflow.js');
            result = dataflowImpactData(args.name, dbPath, {
              depth: args.depth,
              file: args.file,
              kind: args.kind,
              noTests: args.no_tests,
              limit: Math.min(args.limit ?? MCP_DEFAULTS.fn_impact, MCP_MAX_LIMIT),
              offset: args.offset ?? 0,
            });
          } else {
            const { dataflowData } = await import('./dataflow.js');
            result = dataflowData(args.name, dbPath, {
              file: args.file,
              kind: args.kind,
              noTests: args.no_tests,
              limit: Math.min(args.limit ?? MCP_DEFAULTS.query, MCP_MAX_LIMIT),
              offset: args.offset ?? 0,
            });
          }
          break;
        }
        case 'check': {
          const isDiffMode = args.ref || args.staged;

          if (!isDiffMode && !args.rules) {
            // No ref, no staged → run manifesto rules on whole codebase
            const { manifestoData } = await import('./manifesto.js');
            result = manifestoData(dbPath, {
              file: args.file,
              noTests: args.no_tests,
              kind: args.kind,
              limit: Math.min(args.limit ?? MCP_DEFAULTS.manifesto, MCP_MAX_LIMIT),
              offset: args.offset ?? 0,
            });
          } else {
            const { checkData } = await import('./check.js');
            const checkResult = checkData(dbPath, {
              ref: args.ref,
              staged: args.staged,
              cycles: args.cycles,
              blastRadius: args.blast_radius,
              signatures: args.signatures,
              boundaries: args.boundaries,
              depth: args.depth,
              noTests: args.no_tests,
            });

            if (args.rules) {
              const { manifestoData } = await import('./manifesto.js');
              const manifestoResult = manifestoData(dbPath, {
                file: args.file,
                noTests: args.no_tests,
                kind: args.kind,
                limit: Math.min(args.limit ?? MCP_DEFAULTS.manifesto, MCP_MAX_LIMIT),
                offset: args.offset ?? 0,
              });
              result = { check: checkResult, manifesto: manifestoResult };
            } else {
              result = checkResult;
            }
          }
          break;
        }
        case 'ast_query': {
          const { astQueryData } = await import('./ast.js');
          result = astQueryData(args.pattern, dbPath, {
            kind: args.kind,
            file: args.file,
            noTests: args.no_tests,
            limit: Math.min(args.limit ?? MCP_DEFAULTS.ast_query, MCP_MAX_LIMIT),
            offset: args.offset ?? 0,
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
