/**
 * MCP tool schema registry.
 *
 * Owns BASE_TOOLS, LIST_REPOS_TOOL, buildToolList(), and the backward-compatible TOOLS export.
 */

import { EVERY_EDGE_KIND, EVERY_SYMBOL_KIND, VALID_ROLES } from '../domain/queries.js';
import { AST_NODE_KINDS } from '../features/ast.js';

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
    name: 'brief',
    description:
      'Token-efficient file summary: symbols with roles and transitive caller counts, importer counts, and file risk tier (high/medium/low). Designed for context injection.',
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
      'Show node role classification (entry, core, utility, adapter, dead, test-only, leaf) based on connectivity patterns',
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
export function buildToolList(multiRepo) {
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
export const TOOLS = buildToolList(true);
