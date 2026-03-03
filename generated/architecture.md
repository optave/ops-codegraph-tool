# Codegraph Architectural Audit — Revised Analysis

> **Scope:** Unconstrained redesign proposals. No consideration for migration effort or backwards compatibility. What would the ideal architecture look like?
>
> **Revision context:** The original audit (Feb 22, 2026) analyzed v1.4.0 with ~12 source modules totaling ~5K lines. Since then, the codebase grew to v2.6.0 with 35 source modules totaling 17,830 lines — a 3.5x expansion. 18 new modules were added, MCP tools went from 12 to 25, CLI commands from ~20 to 45, and `index.js` exports from ~40 to 120+. This revision re-evaluates every recommendation against the actual codebase as it stands today.

---

## What Changed Since the Original Audit

Before diving into recommendations, here's what happened:

| Metric | Feb 2026 (v1.4.0) | Mar 2026 (v2.6.0) | Growth |
|--------|-------------------|-------------------|--------|
| Source modules | ~12 | 35 | 2.9x |
| Total source lines | ~5,000 | 17,830 | 3.5x |
| `queries.js` | 823 lines | 3,110 lines | 3.8x |
| `mcp.js` | 354 lines | 1,212 lines | 3.4x |
| `cli.js` | -- | 1,285 lines | -- |
| `builder.js` | 554 lines | 1,173 lines | 2.1x |
| `embedder.js` | 525 lines | 1,113 lines | 2.1x |
| `complexity.js` | -- | 2,163 lines | New |
| MCP tools | 12 | 25 | 2.1x |
| CLI commands | ~20 | 45 | 2.3x |
| `index.js` exports | ~40 | 120+ | 3x |
| Test files | ~15 | 59 | 3.9x |

**Key pattern observed:** Every new feature (audit, batch, boundaries, check, cochange, communities, complexity, flow, manifesto, owners, structure, triage) was added as a standalone module following the same internal pattern: raw SQL + BFS/traversal logic + CLI formatting + JSON output + `*Data()` / `*()` dual functions. No shared abstractions were introduced. The original architectural debt wasn't addressed -- it was replicated 15 times.

---

## 1. The Dual-Function Anti-Pattern Is Now the Dominant Architecture Problem

**Original analysis (S3):** `queries.js` mixes data access, graph algorithms, and presentation. The `*Data()` / `*()` dual-function pattern was identified as a workaround for coupling.

**What happened:** Every new module adopted the same pattern. There are now **15+ modules** each implementing both data extraction AND CLI formatting:

```
queries.js      -> queryNameData() / queryName(), impactAnalysisData() / impactAnalysis(), ...
audit.js        -> auditData() / audit()
batch.js        -> batchData() / batch()
check.js        -> checkData() / check()
cochange.js     -> coChangeData() / coChange(), coChangeTopData() / coChangeTop()
communities.js  -> communitiesData() / communities()
complexity.js   -> complexityData() / complexity()
flow.js         -> flowData() / flow()
manifesto.js    -> manifestoData() / manifesto()
owners.js       -> ownersData() / owners()
structure.js    -> structureData() / structure(), hotspotsData() / hotspots()
triage.js       -> triageData() / triage()
branch-compare  -> branchCompareData() / branchCompare()
```

Each of these modules independently handles: DB opening, SQL execution, result shaping, pagination integration, CLI formatting, JSON output, and `--no-tests` filtering. The repetition is massive.

**Ideal architecture -- Command + Query separation with shared infrastructure:**

```
src/
  commands/                    # One file per command
    query.js                   # { execute(args, ctx) -> data, format(data, opts) -> string }
    impact.js
    audit.js
    check.js
    ...

  infrastructure/
    command-runner.js          # Shared lifecycle: open DB -> validate -> execute -> format -> paginate
    result-formatter.js        # Shared formatting: table, JSON, NDJSON, Mermaid
    pagination.js              # Shared pagination with consistent interface
    test-filter.js             # Shared --no-tests / isTestFile logic

  analysis/                    # Pure algorithms -- no I/O, no formatting
    bfs.js                     # Graph traversals (BFS, DFS, shortest path)
    impact.js                  # Blast radius computation
    confidence.js              # Import resolution scoring
    clustering.js              # Community detection, coupling analysis
    risk.js                    # Triage scoring, hotspot detection
```

The key insight: every command follows the same lifecycle -- `(args) -> open DB -> query -> analyze -> format -> output`. A shared `CommandRunner` handles the lifecycle. Each command only implements the unique query + analysis logic. Formatting is always separate and pluggable (CLI text, JSON, NDJSON, Mermaid).

This eliminates the dual-function pattern entirely. `index.js` exports `auditData` (the command's execute function) -- the CLI formatter is internal to the CLI layer and never exported.

---

## 2. The Database Layer Needs a Repository -- Now More Than Ever

**Original analysis (S2):** SQL scattered across `builder.js`, `queries.js`, `embedder.js`, `watcher.js`, `cycles.js`.

**What happened:** SQL is now scattered across **20+ modules**: all of the above plus `audit.js`, `check.js`, `cochange.js`, `communities.js`, `complexity.js`, `flow.js`, `manifesto.js`, `owners.js`, `structure.js`, `triage.js`, `snapshot.js`, `branch-compare.js`. Each module opens the DB independently with `openDb()`, creates its own prepared statements, and writes raw SQL inline.

The schema grew to 9 tables: `nodes`, `edges`, `node_metrics`, `file_hashes`, `co_changes`, `co_change_meta`, `file_commit_counts`, `build_meta`, `function_complexity`. Plus embeddings and FTS5 tables in `embedder.js`.

**Ideal architecture** (unchanged from original, but now higher priority):

```
src/
  db/
    connection.js              # Open, WAL mode, pragma tuning, connection pooling
    migrations.js              # Schema versions (currently 9 migrations)
    repository.js              # ALL read/write operations across all 9+ tables
    types.js                   # JSDoc type definitions for all entities
```

**New addition -- query builders for common patterns:**

Many modules do the same filtered query: "find nodes WHERE kind IN (...) AND file NOT LIKE '%test%' AND name LIKE ? ORDER BY ... LIMIT ? OFFSET ?". A lightweight query builder eliminates this SQL duplication:

```js
repo.nodes()
  .where({ kind: ['function', 'method'], file: { notLike: '%test%' } })
  .matching(name)
  .orderBy('name')
  .paginate(opts)
  .all()
```

Not an ORM -- a thin SQL builder that generates the same prepared statements but eliminates string construction across 20 modules.

---

## 3. queries.js at 3,110 Lines Must Be Decomposed

**Original analysis (S3):** 823 lines mixing data access, algorithms, and presentation.

**Current state:** 3,110 lines -- nearly 4x growth. Contains 15+ data functions, 15+ display functions, constants (`SYMBOL_KINDS`, `ALL_SYMBOL_KINDS`, `VALID_ROLES`, `FALSE_POSITIVE_NAMES`), icon helpers (`kindIcon`), normalization (`normalizeSymbol`), test filtering (`isTestFile`), and generator functions (`iterListFunctions`, `iterRoles`, `iterWhere`).

This is now the second-largest file in the codebase (after `complexity.js` at 2,163 lines) and the most interconnected -- almost every other module imports from it.

**Ideal decomposition:**

```
src/
  analysis/
    symbol-lookup.js           # queryNameData, whereData, listFunctionsData
    impact.js                  # impactAnalysisData, fnImpactData, diffImpactData
    dependencies.js            # fileDepsData, fnDepsData, pathData
    module-map.js              # moduleMapData, statsData
    context.js                 # contextData, explainData
    roles.js                   # rolesData (currently delegates to structure.js)

  shared/
    constants.js               # SYMBOL_KINDS, ALL_SYMBOL_KINDS, VALID_ROLES, FALSE_POSITIVE_NAMES
    filters.js                 # isTestFile, normalizeSymbol, kindIcon
    generators.js              # iterListFunctions, iterRoles, iterWhere
```

Each analysis module is purely data -- no CLI output, no JSON formatting, no `console.log`. The `*Data()` suffix disappears because there's no `*()` counterpart. These are just functions that return data.

---

## 4. MCP at 1,212 Lines with 25 Tools Needs Composability

**Original analysis (S10):** 354 lines, 12 tools, monolithic switch dispatch.

**Current state:** 1,212 lines, 25 tools. The `buildToolList()` function dynamically builds tool definitions, and a large switch/dispatch handles all 25 tools. Adding a tool still requires editing the tool list, the dispatch block, and importing the handler -- three changes in one file.

**Ideal architecture** (unchanged from original, now critical):

```
src/
  mcp/
    server.js                  # MCP server setup, transport, connection lifecycle
    tool-registry.js           # Auto-discovery + dynamic registration
    middleware.js              # Pagination, error handling, repo resolution
    tools/
      query-function.js        # { schema, handler }
      file-deps.js
      impact-analysis.js
      check.js
      audit.js
      complexity.js
      co-changes.js
      structure.js
      ... (25 files, one per tool)
```

Each tool is self-contained:

```js
export const schema = {
  name: 'audit',
  description: '...',
  inputSchema: { ... }
}

export async function handler(args, context) {
  return auditData(args.target, context.resolveDb(args.repo), args)
}
```

The registry auto-discovers tools from the directory. Shared middleware handles pagination (the `MCP_DEFAULTS` logic currently in `paginate.js`), error wrapping, and multi-repo resolution. Adding a tool = adding a file.

---

## 5. CLI at 1,285 Lines with 45 Commands Needs Command Objects

**Original analysis (S12):** CLI was mentioned as a future concern.

**Current state:** 1,285 lines of inline Commander.js chains. 45 commands registered with `.command().description().option().action()` patterns. Each action handler directly calls module functions, handles `--json` output, and manages error display.

**Ideal architecture:**

```
src/
  cli/
    index.js                   # Commander setup, auto-discover commands
    shared/
      output.js                # --json, --ndjson, table, plain text output
      options.js               # Shared options (--no-tests, --json, --db, --engine, --limit, --offset)
      validation.js            # Argument validation, path resolution
    commands/
      build.js                 # { name, description, options, validate, execute }
      query.js
      impact.js
      audit.js
      check.js
      ... (45 files)
```

Each command:

```js
export default {
  name: 'audit',
  description: 'Combined explain + impact + health report',
  arguments: [{ name: 'target', required: true }],
  options: [
    { flags: '-T, --no-tests', description: 'Exclude test files' },
    { flags: '-j, --json', description: 'JSON output' },
    { flags: '--db <path>', description: 'Custom DB path' },
  ],
  async execute(args, opts) {
    const data = await auditData(args.target, opts.db, opts)
    return data  // CommandRunner handles formatting
  },
}
```

The CLI index auto-discovers commands. Shared options (`--no-tests`, `--json`, `--db`, `--engine`, `--limit`, `--offset`) are applied uniformly. The `CommandRunner` handles the open-DB -> execute -> format -> output lifecycle.

---

## 6. complexity.js at 2,163 Lines Is a Hidden Monolith

**Not in original analysis** -- this module didn't exist in Feb 2026.

**Current state:** 2,163 lines containing language-specific AST complexity rules for 8 languages (JS/TS, Python, Go, Rust, Java, C#, PHP, Ruby), plus Halstead metrics computation, maintainability index calculation, LOC/SLOC counting, and CLI formatting. It's the largest file in the codebase.

**Problem:** The file is structured as a giant map of language to rules, but the rules for each language are deeply nested objects with inline AST traversal logic. Adding a new language or modifying a rule requires working inside a 2K-line file.

**Ideal architecture:**

```
src/
  complexity/
    index.js                   # Public API: computeComplexity, complexityData
    metrics.js                 # Halstead, MI, LOC/SLOC computation (language-agnostic)
    engine.js                  # Walk AST + apply rules -> raw metric values
    rules/
      javascript.js            # JS/TS/TSX complexity rules
      python.js
      go.js
      rust.js
      java.js
      csharp.js
      php.js
      ruby.js
```

Each rules file exports a declarative complexity rule set. The engine applies rules to AST nodes. Metrics computation is shared. This mirrors the parser plugin system concept -- same pattern, applied to complexity.

---

## 7. builder.js at 1,173 Lines -- Pipeline Architecture

**Original analysis (S4):** 554 lines, mega-function that's hard to test in parts.

**Current state:** 1,173 lines -- doubled. Now includes change journal integration, structure building, role classification, incremental verification, and more complex edge building. The `buildGraph()` function is even more of a mega-function.

**Ideal architecture** (unchanged, reinforced):

```js
const pipeline = [
  collectFiles,        // (rootDir, config) => filePaths[]
  detectChanges,       // (filePaths, db) => { changed, removed, isFullBuild }
  parseFiles,          // (filePaths, engineOpts) => Map<file, symbols>
  insertNodes,         // (symbolMap, db) => nodeIndex
  resolveImports,      // (symbolMap, rootDir, aliases) => importEdges[]
  buildCallEdges,      // (symbolMap, nodeIndex) => callEdges[]
  buildClassEdges,     // (symbolMap, nodeIndex) => classEdges[]
  resolveBarrels,      // (edges, symbolMap) => resolvedEdges[]
  insertEdges,         // (allEdges, db) => stats
  buildStructure,      // (db, fileSymbols, rootDir) => structureStats
  classifyRoles,       // (db) => roleStats
  computeComplexity,   // (db, rootDir, engine) => complexityStats
  emitChangeJournal,   // (rootDir, changes) => void
]
```

The pipeline grew -- four new stages since the original analysis. This reinforces the need: each stage is independently testable and the pipeline runner handles transactions, logging, progress, and statistics.

**Watch mode** reuses the same stages triggered per-file, eliminating the `watcher.js` divergence. `change-journal.js` and `journal.js` integrate as pipeline hooks rather than separate code paths.

---

## 8. embedder.js at 1,113 Lines -- Now Includes Three Search Engines

**Original analysis (S5):** 525 lines, mini vector database bolted onto the graph DB.

**Current state:** 1,113 lines. Now contains:
- 8 embedding model definitions with batch sizes and dimensions
- 2 embedding strategies (structured, source)
- Vector storage in SQLite blobs
- Cosine similarity search (O(n) linear scan)
- **FTS5 full-text index with BM25 scoring** (new)
- **Hybrid search with RRF fusion** (new)
- Model lifecycle management (lazy loading, caching)

Hybrid search (originally planned as Phase 5.3) is already implemented -- but inside the monolith.

**Ideal architecture** (updated):

```
src/
  embeddings/
    index.js                   # Public API
    models.js                  # Model definitions, batch sizes, loading
    generator.js               # Source -> text preparation -> batch embedding
    stores/
      sqlite-blob.js           # Current O(n) cosine similarity
      fts5.js                  # BM25 keyword search via FTS5
    search/
      semantic.js              # Vector similarity search
      keyword.js               # FTS5 BM25 search
      hybrid.js                # RRF fusion of semantic + keyword
    strategies/
      structured.js            # Structured text preparation
      source.js                # Raw source preparation
```

The three search modes (semantic, keyword, hybrid) become composable search strategies rather than three code paths in one file. The store abstraction enables future pluggable backends (HNSW, DiskANN) without touching search logic.

---

## 9. parser.js Is No Longer a Monolith -- Downgrade Priority

**Original analysis (S1):** 2,215 lines, 9 language extractors in one file. Highest priority.

**Current state:** 404 lines. The native Rust engine now handles the heavy parsing. `parser.js` is a thin WASM fallback with `LANGUAGE_REGISTRY`, engine resolution, and minimal extraction. The extractors still exist but are much smaller per-language.

**Revised recommendation:** This is no longer urgent. The Rust engine already implements the plugin system concept natively. The WASM path in `parser.js` at 404 lines is manageable. If the parser ever grows again (new languages added to WASM fallback), revisit -- but for now, this is fine.

---

## 10. The Native/WASM Abstraction -- Less Critical Now

**Original analysis (S6):** Scattered `engine.name === 'native'` branching across multiple files.

**Current state:** The native engine is the primary path. WASM is a fallback. The branching still exists but is less problematic because most users never hit the WASM path. The unified engine interface is still the right design but it's a polish item, not a structural problem.

**Revised priority:** Low-Medium. Do it when touching these files for other reasons.

---

## 11. Qualified Names + Hierarchical Scoping -- Still Important

**Original analysis (S13):** Flat node model with name collisions resolved by heuristics.

**Current state:** Unchanged. The `nodes` table still has `(name, kind, file, line)` with no scope or qualified name. The `structure.js` module added `role` classification but not scoping. With the codebase now handling more complex analysis (communities, boundaries, flow tracing), the lack of qualified names creates more ambiguity in more places.

**Ideal enhancement** (unchanged):

```sql
ALTER TABLE nodes ADD COLUMN qualified_name TEXT;  -- 'DateHelper.format'
ALTER TABLE nodes ADD COLUMN scope TEXT;            -- 'DateHelper'
ALTER TABLE nodes ADD COLUMN visibility TEXT;       -- 'public' | 'private' | 'protected'
```

---

## 12. Domain Error Hierarchy -- More Urgent with 35 Modules

**Original analysis (S17):** Inconsistent error handling across ~12 modules.

**Current state:** 35 modules with inconsistent error handling. Some throw, some return null, some `logger.warn()` and continue, some `process.exit(1)`. The MCP server wraps everything in generic try-catch. The `check.js` module returns structured pass/fail objects but other modules don't.

**`check.js` already demonstrates the right pattern** -- structured result objects with clear pass/fail semantics. This should be generalized:

```js
// errors.js
export class CodegraphError extends Error {
  constructor(message, { code, file, cause } = {}) {
    super(message)
    this.code = code
    this.file = file
    this.cause = cause
  }
}

export class ParseError extends CodegraphError { code = 'PARSE_FAILED' }
export class DbError extends CodegraphError { code = 'DB_ERROR' }
export class ConfigError extends CodegraphError { code = 'CONFIG_INVALID' }
export class ResolutionError extends CodegraphError { code = 'RESOLUTION_FAILED' }
export class EngineError extends CodegraphError { code = 'ENGINE_UNAVAILABLE' }
export class AnalysisError extends CodegraphError { code = 'ANALYSIS_FAILED' }
export class BoundaryError extends CodegraphError { code = 'BOUNDARY_VIOLATION' }
```

---

## 13. Public API Surface -- 120+ Exports Is Unsustainable

**Original analysis (S18):** ~40 re-exports, no distinction between public and internal.

**Current state:** 120+ exports from `index.js`. Every `*Data()` function, every CLI display function, every constant, every utility is exported. The public API is the entire internal surface.

**The problem is now 3x worse** and directly blocks any refactoring -- every internal rename could break an unnamed consumer.

**Ideal architecture** (reinforced):

```js
// index.js -- curated public API (~30 exports)
// Build
export { buildGraph } from './builder.js'

// Analysis (data functions only -- no CLI formatters)
export { queryNameData, impactAnalysisData, fileDepsData, fnDepsData,
         fnImpactData, diffImpactData, moduleMapData, statsData,
         contextData, explainData, whereData, listFunctionsData,
         rolesData } from './analysis/index.js'

// New analysis modules
export { auditData } from './commands/audit.js'
export { checkData } from './commands/check.js'
export { complexityData } from './commands/complexity.js'
export { manifestoData } from './commands/manifesto.js'
export { triageData } from './commands/triage.js'
export { flowData } from './commands/flow.js'
export { communitiesData } from './commands/communities.js'

// Search
export { searchData, hybridSearchData, embedSymbols } from './embeddings/index.js'

// Infrastructure
export { detectCycles } from './analysis/cycles.js'
export { exportGraph } from './export.js'
export { startMcpServer } from './mcp/server.js'
export { loadConfig } from './config.js'

// Constants
export { SYMBOL_KINDS, ALL_SYMBOL_KINDS } from './shared/constants.js'
```

Lock it with `package.json` exports:

```json
{
  "exports": {
    ".": "./src/index.js",
    "./cli": "./src/cli.js"
  }
}
```

---

## 14. Structure + Cochange + Communities -- Parallel Graph Models Need Unification

**Not in original analysis** -- these modules didn't exist.

**Current state:** Three separate analytical subsystems each build their own graph representation:

- **`structure.js`** (668 lines): Builds directory nodes, computes cohesion/density/coupling metrics, classifies roles (entry, core, utility, adapter, leaf, dead). Has its own BFS and metrics computation.
- **`cochange.js`** (502 lines): Builds temporal coupling graph from git history. Stores in `co_changes` table with Jaccard coefficients. Independent of the dependency graph.
- **`communities.js`** (310 lines): Uses graphology to build an in-memory graph from edges, runs Louvain community detection, computes modularity and drift.

Each constructs its own graph representation independently. There's no shared graph abstraction they all operate on.

**Ideal architecture -- unified graph model:**

```
src/
  graph/
    model.js                   # In-memory graph representation (nodes + edges + metadata)
    builders/
      dependency.js            # Build from SQLite edges (imports, calls, extends)
      structure.js             # Build from file/directory hierarchy
      temporal.js              # Build from git history (co-changes)
    algorithms/
      bfs.js                   # Breadth-first traversal (used by impact, flow, etc.)
      shortest-path.js         # Path finding (used by path command)
      tarjan.js                # Cycle detection (currently in cycles.js)
      louvain.js               # Community detection (currently uses graphology)
      centrality.js            # Fan-in/fan-out, betweenness (used by triage, hotspots)
      clustering.js            # Cohesion, coupling, density metrics
    classifiers/
      roles.js                 # Node role classification
      risk.js                  # Risk scoring (currently in triage.js)
```

The graph model is a shared in-memory structure that multiple builders can populate and multiple algorithms can query. This eliminates the repeated graph construction across modules and makes algorithms composable -- you can run community detection on the dependency graph, the temporal graph, or a merged graph.

---

## 15. Pagination Pattern Needs Standardization

**Not in original analysis** -- paginate.js was just introduced.

**Current state:** `paginate.js` (106 lines) provides `paginate()` and `paginateResult()` helpers plus `MCP_DEFAULTS` with per-command limits. But each module integrates pagination differently -- some pass `opts` to paginate, some manually slice arrays, some use `LIMIT/OFFSET` in SQL, some paginate in memory after fetching all results.

**Ideal architecture:** Pagination belongs in the repository layer (SQL `LIMIT/OFFSET`) for data fetching and in the command runner for result shaping. The current pattern of fetching all data then slicing in memory doesn't scale. The repository should accept pagination parameters directly:

```js
// In repository
findNodes(filters, { limit, offset, orderBy }) {
  // Generates SQL with LIMIT/OFFSET -- never fetches more than needed
}

// In command runner (after execute)
runner.paginate(result, 'functions', opts)  // Consistent shaping for all commands
```

---

## 16. Testing -- Good Coverage, Wrong Distribution

**Original analysis (S11):** Missing proper unit tests.

**Current state:** 59 test files -- major improvement. Tests exist across:
- `tests/unit/` -- 18 files
- `tests/integration/` -- 18 files
- `tests/parsers/` -- 8 files
- `tests/engines/` -- 2 files (parity tests)
- `tests/search/` -- 3 files
- `tests/incremental/` -- 2 files

**What's still missing:**
- Unit tests for pure graph algorithms (BFS, Tarjan) in isolation
- Unit tests for confidence scoring with various inputs
- Unit tests for the triage risk scoring formula
- Mock-based tests (the repository pattern would enable `InMemoryRepository`)
- Many "unit" tests still hit SQLite -- they're integration tests in the unit directory

The test count is adequate. The issue is that without the repository pattern, true unit testing is impossible for most modules -- they all need a real SQLite DB.

---

## 17. Event-Driven Pipeline -- Still Relevant for Scale

**Original analysis (S7):** Batch pipeline with no progress reporting.

**Current state:** Still batch. The `change-journal.js` module adds NDJSON event logging for watch mode, which is a step toward events -- but the build pipeline itself is still synchronous batch. For repos with 10K+ files, users still see no progress during builds.

**Ideal architecture** (unchanged, lower priority than structural issues):

```js
pipeline.on('file:parsed',    (file, symbols) => { /* progress */ })
pipeline.on('file:indexed',   (file, nodeCount) => { /* progress */ })
pipeline.on('build:complete',  (stats) => { /* summary */ })
await pipeline.run(rootDir)
```

---

## 18. Dead Symbol Cleanup -- 27% of Classified Code Is Unused

**Not in original analysis** -- the `roles` classification that surfaces dead symbols didn't exist yet.

**Current state:** Codegraph's own role classification reports 221 dead symbols -- 27% of all classified code. In a project this young (~10 days old at time of measurement), a quarter of the symbols being unused signals systematic overproduction: speculative helpers, leftover refactoring artifacts, and the dual-function pattern generating display functions that nothing calls.

**Root causes:**
- The `*Data()` / `*()` dual-function pattern (Section 1) means every data function has a display counterpart. MCP and programmatic consumers only call `*Data()`, leaving many `*()` functions uncalled
- `index.js` exports 120+ symbols (Section 13) with no consumer tracking -- functions are exported "just in case"
- Rapid feature addition without pruning -- each new module adds helpers that may only be used during development

**Ideal approach -- continuous dead code hygiene:**

1. **Audit pass:** Run `codegraph roles --role dead -T` and categorize results:
   - **Truly dead:** Remove immediately (unused helpers, orphaned formatters)
   - **Entry points:** CLI handlers, MCP tool handlers, test utilities -- mark as `@entry` or add to a known-entries list so the classifier doesn't flag them
   - **Public API:** Exported but uncalled internally -- decide if they're part of the supported API or remove from `index.js`

2. **CI gate:** Add a dead-symbol threshold to `manifesto.js` rules:
   ```json
   {
     "rule": "max-dead-ratio",
     "warn": 0.15,
     "fail": 0.25,
     "message": "Dead symbol ratio exceeds {threshold}"
   }
   ```

3. **Prevention:** The Command/Query separation (Section 1) and curated API surface (Section 13) eliminate the two biggest dead-code factories. Once display functions are internal to the CLI layer and exports are curated, new dead code becomes visible immediately.

**Target:** Reduce dead symbol ratio from 27% to under 10%.

---

## 19. Community Drift -- 40% of Files Are in the Wrong Logical Module

**Not in original analysis** -- `communities.js` didn't exist yet.

**Current state:** Louvain community detection on the dependency graph finds that 40% of files belong to a different logical community than their directory suggests. This means the file organization actively misleads developers about which modules are coupled.

**What drift means concretely:**
- Files in `src/` root that should be grouped (e.g., `triage.js`, `audit.js`, `manifesto.js` form a "code health" community but live alongside unrelated modules)
- Utility functions in domain modules that are actually shared infrastructure
- Tight coupling between files in different conceptual areas (e.g., `structure.js` and `queries.js` are more coupled to each other than to their neighbors)

**Ideal approach -- align directory structure to communities:**

1. **Measure baseline:** `codegraph communities -T` to get current modularity score and drift percentage
2. **Map communities to directories:** The restructuring proposed in Sections 1, 3, 4, 5 would naturally create directories that match logical communities:
   ```
   src/
     analysis/       # Community: query/impact/context/explain/roles
     commands/       # Community: CLI-specific formatting
     health/         # Community: audit/triage/manifesto/check/complexity
     graph/          # Community: structure/communities/cochange/cycles
     infrastructure/ # Community: db/pagination/config/logger
   ```
3. **Track drift as a metric:** Add modularity score and drift percentage to `stats` output. Regressing drift should trigger a warning.
4. **CI gate:** Add a drift threshold to `manifesto.js`:
   ```json
   {
     "rule": "max-community-drift",
     "warn": 0.30,
     "fail": 0.45,
     "message": "Community drift exceeds {threshold}"
   }
   ```

**Target:** Reduce drift from 40% to under 20% through directory restructuring.

---

## 20. Function-Level Cycles -- 9 Circular Dependencies

**Not in original analysis** -- cycle detection existed but function-level cycles weren't measured.

**Current state:** `codegraph cycles` reports 9 function-level circular dependencies. While the codebase has no file-level cycles (imports are acyclic), function call graphs contain mutual recursion and indirect loops.

**Why this matters:**
- Circular call chains make impact analysis unreliable -- a change to any function in a cycle potentially affects all others
- They complicate the proposed decomposition (Sections 1, 3) -- you can't cleanly split modules if their functions are mutually dependent
- They indicate hidden coupling that the module structure doesn't reveal

**Ideal approach:**

1. **Identify and classify:** Run `codegraph cycles` and categorize each cycle:
   - **Intentional recursion:** Mutual recursion in tree walkers, AST visitors -- document with comments, exclude from CI gates
   - **Accidental coupling:** Function A calls B which calls C which calls A -- these need refactoring
   - **Layering violations:** A query function calling a builder function that calls back into queries -- break by introducing an interface boundary

2. **Break accidental cycles:**
   - **Extract shared logic:** If A and B both need the same computation, extract it to a third function that both call
   - **Invert dependencies:** If a low-level function calls a high-level one, pass the needed data as a parameter instead
   - **Event/callback:** For unavoidable bidirectional communication, use callbacks or events instead of direct calls

3. **CI gate:** Add to `check.js` predicates:
   ```json
   {
     "rule": "no-new-cycles",
     "scope": "function",
     "message": "New function-level cycle introduced: {cycle}"
   }
   ```

4. **Prevention:** The layered architecture proposed throughout this document (analysis → infrastructure → db) naturally prevents cycles -- lower layers never import from higher layers.

**Target:** Reduce from 9 cycles to 0 accidental cycles (intentional recursion documented and exempted).

---

## Remaining Items (Unchanged from Original)

- **Config profiles (S8):** Single flat config, no monorepo profiles. Still relevant but not blocking anything.
- **Transitive import-aware confidence (S9):** Walk import graph before falling back to proximity heuristics. Targeted algorithmic improvement.
- **Query result caching (S14):** LRU/TTL cache between analysis and repository. More valuable now with 25 MCP tools.
- **Subgraph export filtering (S16):** Export the full graph or nothing. Still relevant for usability.

---

## Revised Summary -- Priority Ordering by Architectural Impact

| # | Change | Impact | Category | Original # |
|---|--------|--------|----------|------------|
| **1** | **Command/Query separation -- eliminate dual-function pattern across 15 modules** | **Critical** | Separation of concerns | S3 (was High) |
| **2** | **Repository pattern for data access -- SQL in 20+ modules** | **Critical** | Testability, maintainability | S2 (was High) |
| **3** | **Decompose queries.js (3,110 lines) into analysis modules** | **Critical** | Modularity | S3 (was High) |
| **4** | **Composable MCP tool registry (25 tools in 1,212 lines)** | **High** | Extensibility | S10 (was Medium) |
| **5** | **CLI command objects (45 commands in 1,285 lines)** | **High** | Maintainability | S12 (was Medium) |
| **6** | **Curated public API surface (120+ to ~30 exports)** | **High** | API stability | S18 (was Medium) |
| **7** | **Domain error hierarchy (35 modules, inconsistent handling)** | **High** | Reliability | S17 (was Medium) |
| **8** | **Decompose complexity.js (2,163 lines) into rules/engine** | **High** | Modularity | New |
| **9** | **Builder pipeline architecture (1,173 lines)** | **High** | Testability, reuse | S4 (was High) |
| **10** | **Embedder subsystem (1,113 lines, 3 search engines)** | **Medium-High** | Extensibility | S5 (was Medium) |
| **11** | **Unified graph model for structure/cochange/communities** | **Medium-High** | Cohesion | New |
| **12** | **Qualified names + hierarchical scoping** | **Medium** | Data model accuracy | S13 (unchanged) |
| **13** | **Pagination standardization (SQL-level + command runner)** | **Medium** | Consistency | New |
| **14** | **Testing pyramid with InMemoryRepository** | **Medium** | Quality | S11 (unchanged) |
| **15** | **Event-driven pipeline for streaming** | **Medium** | Scalability, UX | S7 (unchanged) |
| **16** | **Query result caching (25 MCP tools)** | **Low-Medium** | Performance | S14 (unchanged) |
| **17** | **Dead symbol cleanup (27% dead code ratio)** | **Medium** | Code hygiene | New |
| **18** | **Reduce community drift (40% misplaced files)** | **Medium** | Cohesion | New |
| **19** | **Break function-level cycles (9 circular deps)** | **Medium** | Correctness | New |
| **20** | **Unified engine interface (Strategy)** | **Low-Medium** | Abstraction | S6 (was Medium-High) |
| **21** | **Subgraph export with filtering** | **Low-Medium** | Usability | S16 (unchanged) |
| **22** | **Transitive import-aware confidence** | **Low** | Accuracy | S9 (unchanged) |
| **23** | **Parser plugin system** | **Low** | Modularity | S1 (was High -- parser.js shrank to 404 lines) |
| **24** | **Config profiles for monorepos** | **Low** | Feature | S8 (unchanged) |

**The structural priority shifted.** In the original analysis, the parser monolith was #1 -- it's now #23 because the native engine solved it. The new #1 is the command/query separation: the dual-function anti-pattern replicated across 15 modules is the single biggest source of code duplication and coupling in the codebase. Items 1-3 are the foundation -- they restructure the core and everything else becomes easier. Items 4-7 are high-impact but can be done in parallel. Items 8-10 are large-file decompositions that follow naturally once the shared infrastructure exists. Items 17-19 (dead symbols, community drift, function cycles) are health metrics that improve naturally as the structural changes land -- but also benefit from explicit CI gates to prevent regression.

---

*Revised 2026-03-02. Cold architectural analysis -- no implementation constraints applied.*
