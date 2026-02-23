# Codegraph Architectural Audit — Cold Analysis

> **Scope:** Unconstrained redesign proposals. No consideration for migration effort or backwards compatibility. What would the ideal architecture look like?

---

## 1. parser.js Is a Monolith — Split Into a Plugin System

**Current state:** `parser.js` is 2,215 lines containing 9 language extractors, the WASM/native engine abstraction, the language registry, tree walking helpers, and the unified parse API — all in one file.

**Problem:** Adding or modifying a language extractor forces you to work inside a 2K-line file alongside unrelated extractors. The extractors share repetitive patterns (walk tree → switch on node type → push to arrays) but each reimplements the loop. Testing a single language requires importing the entire parser surface.

**Ideal architecture:**

```
src/
  parser/
    index.js              # Public API: parseFileAuto, parseFilesAuto, resolveEngine
    registry.js            # LANGUAGE_REGISTRY + extension mapping
    engine.js              # Native/WASM init, engine resolution, grammar loading
    tree-utils.js          # findChild, findParentClass, walkTree helpers
    base-extractor.js      # Shared extraction framework (the walk loop + accumulator)
    extractors/
      javascript.js        # JS/TS/TSX extractor
      python.js
      go.js
      rust.js
      java.js
      csharp.js
      ruby.js
      php.js
      hcl.js
```

**Key design change:** Introduce a `BaseExtractor` that owns the tree walk loop and provides hook methods per node type. Each language extractor declares a node-type → handler map instead of reimplementing the traversal:

```js
// Conceptual — not real API
export default {
  language: 'python',
  handlers: {
    function_definition: (node, ctx) => { ctx.addDefinition(...) },
    call:                (node, ctx) => { ctx.addCall(...) },
    import_statement:    (node, ctx) => { ctx.addImport(...) },
  }
}
```

This eliminates the repeated walk-and-switch boilerplate across 9 extractors while keeping language-specific logic isolated. Each extractor becomes independently testable and the registration is declarative.

---

## 2. The Database Layer Is Too Thin — Introduce a Repository Pattern

**Current state:** `db.js` is 130 lines — it opens SQLite, runs migrations, and that's it. All actual SQL lives scattered across `builder.js`, `queries.js`, `embedder.js`, `watcher.js`, and `cycles.js`. Every consumer writes raw SQL inline.

**Problems:**
- SQL duplication (similar node/edge lookups written multiple times in different modules)
- No single place to understand or optimize the query surface
- Schema knowledge leaks everywhere — if a column changes, you grep the entire codebase
- No abstraction boundary for swapping storage engines (e.g., moving to DuckDB or an in-memory graph for tests)

**Ideal architecture:**

```
src/
  db/
    connection.js         # Open, WAL mode, pragma tuning
    migrations.js         # Schema versions
    repository.js         # ALL data access methods
    types.js              # TS-style JSDoc type defs for Node, Edge, Embedding
```

`repository.js` would expose a complete data access API:

```js
// Writes
insertNode(node)
insertEdge(edge)
insertEmbeddings(batch)
upsertFileHash(file, hash, mtime)
deleteFileNodes(file)
deleteFileEdges(file)

// Reads
findNodesByName(name, opts?)
findNodesByFile(file, opts?)
findEdgesFrom(nodeId, kind?)
findEdgesTo(nodeId, kind?)
getFileHash(file)
getChangedFiles(allFiles)
getAllEmbeddings()
getEmbeddingMeta()

// Graph traversals (currently in queries.js as raw SQL + BFS)
getTransitiveCallers(nodeId, depth)
getTransitiveDependents(file, depth)
getClassHierarchy(classNodeId)
```

All prepared statements live here. All index tuning happens here. Consumers never see SQL.

**Secondary benefit:** This enables an `InMemoryRepository` for tests — no temp file cleanup, instant setup, true unit isolation.

---

## 3. queries.js Mixes Data Access, Graph Algorithms, and Presentation

**Current state:** `queries.js` (823 lines) contains SQL queries, BFS traversal logic, formatting/printing, JSON serialization, and CLI output — all interleaved. Each "query command" exists as both a `*Data()` function (returns object) and a presentation function (prints to stdout).

**Problem:** The presentation layer (stdout formatting, `kindIcon()`, table printing) is coupled to the analysis layer (BFS, impact scoring). You can't reuse the BFS logic in the MCP server without also pulling in the CLI formatting. The `*Data()`/`*()` dual-function pattern is a workaround for this coupling.

**Ideal architecture — three layers:**

```
src/
  analysis/
    impact.js             # impactAnalysis: BFS over edges, returns typed result
    call-chain.js         # fnDeps, fnImpact: transitive caller/callee traversal
    diff-impact.js        # Git diff → affected functions → blast radius
    module-map.js         # Connectivity ranking
    class-hierarchy.js    # Inheritance resolution

  formatters/
    cli-formatter.js      # Human-readable stdout output
    json-formatter.js     # --json flag handling
    table-formatter.js    # Tabular output for module-map, list-functions
```

Analysis modules take a repository and return pure data. Formatters take data and produce strings. The CLI, MCP server, and programmatic API all consume analysis modules directly and pick their own formatter (or none).

---

## 4. builder.js Orchestrates Too Many Concerns — Extract a Pipeline

**Current state:** `builder.js` (554 lines) handles file collection, config loading, alias resolution, incremental change detection, parsing, node insertion, edge building, barrel file resolution, and statistics — all in `buildGraph()`.

**Problem:** `buildGraph()` is a mega-function that's hard to test in parts. You can't test edge building without running the full parse phase. You can't test barrel resolution without a populated database.

**Ideal architecture — explicit pipeline stages:**

```js
// Each stage is a pure-ish function: (input, config) => output
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
]
```

Each stage is independently testable. The pipeline runner handles transactions, logging, and statistics. Stages can be composed differently for watch mode (skip collectFiles, skip detectChanges, run single-file variant).

---

## 5. Embedder Should Be a Standalone Subsystem

**Current state:** `embedder.js` (525 lines) creates its own DB tables (`embeddings`, `embedding_meta`), manages its own model lifecycle, and implements both vector storage and search. It's effectively a mini vector database bolted onto the side of the graph database.

**Problem:** Embedding concerns bleed into the graph DB schema. The cosine similarity search is O(n) full scan — fine for thousands of symbols, will not scale. The model registry, embedding generation, and search are all tangled in one file.

**Ideal architecture:**

```
src/
  embeddings/
    index.js              # Public API
    model-registry.js     # Model definitions, batch sizes, loading
    generator.js          # Source → text preparation → batch embedding
    store.js              # Vector storage (pluggable: SQLite blob, flat file, HNSW index)
    search.js             # Similarity search, RRF multi-query fusion
```

**Key design change:** Make the vector store pluggable. The current SQLite blob approach works but is a linear scan. A future `HNSWStore` (using `hnswlib-node` or similar) would give O(log n) approximate nearest neighbor search — critical when the symbol count reaches 50K+.

The store interface would be:

```js
// Abstract store
insert(nodeId, vector, preview)
search(queryVector, topK, minScore) → results[]
delete(nodeId)
rebuild()
```

This also enables storing embeddings in a separate file from the graph DB, which avoids bloating `graph.db` with large binary blobs.

---

## 6. The Native/WASM Abstraction Leaks

**Current state:** `parser.js` has `resolveEngine()` that returns `{ name, native }`, then every call site branches on `engine.name === 'native'`. `resolve.js` has its own native check. `cycles.js` has its own native check. `builder.js` passes engine options through.

**Problem:** The dual-engine strategy is a great idea but its implementation is scattered. Every consumer needs to know about native vs. WASM and handle both paths.

**Ideal architecture — unified engine interface:**

```js
// engine.js — returns an object with the same API regardless of backend
export function createEngine(opts) {
  const backend = resolveBackend(opts) // 'native' | 'wasm'

  return {
    name: backend,
    parseFile(filePath, source) { ... },
    parseFiles(filePaths, rootDir) { ... },
    resolveImport(from, source, rootDir, aliases) { ... },
    resolveImports(batch, rootDir, aliases) { ... },
    detectCycles(db) { ... },
    computeConfidence(caller, target, imported) { ... },
    createCache() { ... },
  }
}
```

Consumers receive an engine object and call methods on it. They never branch on native vs. WASM. The engine internally dispatches to the right implementation. This is the Strategy pattern properly applied.

**Bonus:** This makes it trivial to add a third engine backend (e.g., a remote parsing service for very large repos) without touching any consumer code.

---

## 7. No Streaming / Event Architecture — Everything Is Batch

**Current state:** The entire build pipeline is synchronous batch processing. Parse all files → insert all nodes → build all edges. The watcher does per-file updates but reimplements the pipeline in a simpler form.

**Problem:** For large repos (10K+ files), the user waits for the entire pipeline to complete before seeing anything. There's no progress reporting during parsing. There's no way to cancel a build mid-flight. The watcher's simplified pipeline diverges from the main build path (different code, different edge cases).

**Ideal architecture — event-driven pipeline:**

```js
const pipeline = createPipeline(config)

pipeline.on('file:parsed',   (file, symbols) => { /* progress */ })
pipeline.on('file:indexed',  (file, nodeCount) => { /* progress */ })
pipeline.on('edge:built',    (edge) => { /* streaming insert */ })
pipeline.on('build:complete', (stats) => { /* summary */ })
pipeline.on('error',         (file, err) => { /* continue or abort */ })

await pipeline.run(rootDir)
// or for watch mode:
await pipeline.watch(rootDir) // reuses same stages, different trigger
```

This unifies the build and watch code paths. Progress is naturally reported via events. Cancellation is a `pipeline.abort()`. Large builds can stream results to the DB incrementally instead of buffering everything in memory.

---

## 8. Configuration Is Fine but Should Support Project Profiles

**Current state:** Single `.codegraphrc.json` file, flat config, env var overrides. Clean and simple.

**What's missing for real-world use:**

**Profile-based configuration.** A monorepo with 3 services needs different settings per service (different `include`/`exclude`, different `ignoreDirs`, different `dbPath`). Currently you'd need 3 separate config files and run from 3 different directories.

```json
{
  "profiles": {
    "backend": {
      "include": ["services/api/**"],
      "build": { "dbPath": ".codegraph/api.db" }
    },
    "frontend": {
      "include": ["apps/web/**"],
      "extensions": [".ts", ".tsx"],
      "build": { "dbPath": ".codegraph/web.db" }
    }
  }
}
```

```bash
codegraph build --profile backend
codegraph build --profile frontend
codegraph build  # default = all
```

This maps cleanly to the multi-repo registry concept already in the codebase, but works within a single repo.

---

## 9. Import Resolution Confidence Scoring Is Heuristic — Add Import-Graph Awareness

**Current state:** `computeConfidence()` uses file proximity (same dir = 0.7, parent dir = 0.5, fallback = 0.3) to disambiguate when multiple functions share a name.

**Problem:** Proximity is a weak signal. If `src/utils/format.js` exports `format()` and `src/api/format.js` also exports `format()`, and the caller is in `src/api/handler.js`, proximity correctly scores `src/api/format.js` higher. But if the caller explicitly imports from `src/utils/format.js`, the import graph already tells us the answer with certainty — and the current code does use imports when available (score 1.0). The gap is in the fallback path where there's no import but there IS an import chain (A imports B which imports C which exports the function).

**Ideal enhancement — transitive import awareness:**

Before falling back to proximity, walk the import graph from the caller file. If there's any import path (even indirect through barrel files) that reaches one of the candidates, that candidate gets a 0.9 score. Only if no import path exists at all do we fall back to proximity heuristics.

This is a targeted algorithmic improvement, not a structural change, but it significantly improves edge accuracy for large codebases with many same-named functions.

---

## 10. The MCP Server Should Be Composable, Not Monolithic

**Current state:** `mcp.js` (354 lines) has a hardcoded `TOOLS` array with 12 tool definitions, each with inline JSON schemas, and a `switch` statement dispatching to handler functions.

**Problem:** Adding a new MCP tool requires editing the TOOLS array (schema), the switch statement (dispatch), and importing the handler — three changes in one file. The tool schemas are verbose JSON objects mixed with implementation logic.

**Ideal architecture:**

```
src/
  mcp/
    server.js             # MCP server setup, transport, connection lifecycle
    tool-registry.js      # Dynamic tool registration
    tools/
      query-function.js   # { schema, handler } per tool
      file-deps.js
      impact-analysis.js
      find-cycles.js
      semantic-search.js
      ...
```

Each tool is a self-contained module:

```js
// tools/query-function.js
export const schema = {
  name: 'query_function',
  description: '...',
  inputSchema: { ... }
}

export async function handler(args, context) {
  const dbPath = context.resolveDb(args.repo)
  return queryNameData(args.name, dbPath)
}
```

The registry auto-discovers tools from the `tools/` directory. Adding a tool = adding a file. No other files change.

---

## 11. Testing Strategy Needs Layers

**Current state:** Tests are a mix of integration tests (full pipeline through SQLite) and pseudo-unit tests that still often hit the filesystem or database. There's no clear boundary between "test the algorithm" and "test the integration."

**Ideal testing pyramid:**

```
                    ╱╲
                   ╱  ╲        E2E (2-3 tests)
                  ╱ E2E╲       Full CLI invocation, real project, assert output
                 ╱──────╲
                ╱        ╲     Integration (current tests, refined)
               ╱Integration╲   Build pipeline, query results, MCP responses
              ╱────────────╲
             ╱              ╲  Unit (new layer)
            ╱     Unit       ╲ Extractors, algorithms, formatters — no I/O
           ╱──────────────────╲
```

**What's missing:**
- **Pure unit tests** for extractors (pass AST node, assert symbols — no file I/O)
- **Pure unit tests** for BFS/Tarjan algorithms (pass adjacency list, assert result)
- **Pure unit tests** for confidence scoring (pass parameters, assert score)
- **Repository mock** for query tests (in-memory data, no SQLite)
- **E2E tests** that invoke the CLI binary on a real (small) project and assert exit codes + stdout

The repository pattern from point #2 directly enables this: unit tests use `InMemoryRepository`, integration tests use `SqliteRepository`.

---

## 12. CLI Architecture — Move to Command Objects

**Current state:** `cli.js` defines all commands inline with Commander.js. Each command is a `.command().description().option().action()` chain that directly calls functions.

**Problem:** The CLI file grows linearly with every new command. Command logic (option parsing, validation, output formatting) is mixed with framework wiring. You can't test a command's behavior without invoking Commander.

**Ideal architecture:**

```
src/
  cli/
    index.js              # Commander setup, command registration
    commands/
      build.js            # { name, description, options, validate, execute }
      query.js
      impact.js
      deps.js
      export.js
      search.js
      watch.js
      registry.js
      ...
```

Each command is a plain object:

```js
export default {
  name: 'impact',
  description: 'Show what depends on a file',
  arguments: [{ name: 'file', required: true }],
  options: [
    { flags: '--depth <n>', description: 'Traversal depth', default: 3 },
    { flags: '--json', description: 'JSON output' },
  ],
  validate(args, opts) { /* pre-flight checks */ },
  async execute(args, opts) { /* the actual work */ },
}
```

The CLI index auto-discovers commands and registers them with Commander. Each command is independently testable by calling `execute()` directly.

---

## 13. Graph Model Is Flat — Consider Hierarchical Scoping

**Current state:** The `nodes` table has `(name, kind, file, line)`. A function named `format` in `src/a.js` and a method named `format` on class `DateHelper` in `src/b.js` are both just nodes with `name=format`. The class membership is encoded as an edge, not as a structural property.

**Problem:** Name collisions are resolved through the confidence scoring heuristic. But the graph has no concept of scope — there's no way to express "this `format` belongs to `DateHelper`" as a structural property of the node. This makes queries ambiguous: `codegraph query format` returns all `format` symbols across the entire graph.

**Ideal enhancement — qualified names:**

```sql
CREATE TABLE nodes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,           -- 'format'
  qualified_name TEXT,          -- 'DateHelper.format' or 'utils/date::format'
  kind TEXT NOT NULL,
  file TEXT NOT NULL,
  scope TEXT,                   -- 'DateHelper' (parent class/module/namespace)
  line INTEGER,
  end_line INTEGER,
  visibility TEXT,              -- 'public' | 'private' | 'protected' | 'internal'
  UNIQUE(qualified_name, kind, file)
);
```

The `qualified_name` gives every symbol a unique identity within its file. The `scope` field enables queries like "all methods of class X" without traversing edges. The `visibility` field enables filtering out private implementation details from impact analysis.

This doesn't change the edge model — it enriches the node model to reduce ambiguity at the source.

---

## 14. No Caching Layer Between DB and Queries

**Current state:** Every query function opens the DB, runs SQL, returns results, and closes. There's no caching of query results, no materialized views, no precomputed aggregates.

**Fine for now.** SQLite is fast and the graph fits in memory. But as graphs grow (50K+ nodes), repeated queries (especially from MCP where an AI agent may query the same function multiple times in a conversation) will redundantly hit disk.

**Ideal enhancement — query result cache:**

```js
class QueryCache {
  constructor(db, maxAge = 60_000) { ... }

  // Cache key = query name + args hash
  // Invalidated on DB write (build, watch update)
  get(key) { ... }
  set(key, value) { ... }
  invalidate() { ... } // Called after any DB mutation
}
```

This is a simple LRU or TTL cache that sits between the analysis layer and the repository. It's transparent to consumers. Particularly valuable for MCP where the same agent session may repeatedly query related symbols.

---

## 15. Watcher and Builder Share Logic But Don't Share Code

**Current state:** `watcher.js` reimplements parts of `builder.js` — node insertion, edge building, prepared statement setup — in a simplified single-file form. The two implementations can drift.

**Problem:** Bug fixes to edge building in `builder.js` must be separately applied to `watcher.js`. The watcher's edge building is simpler (no barrel resolution, simpler confidence) which means watch-mode graphs are subtly different from full-build graphs.

**Ideal fix:** The pipeline architecture from point #4 eliminates this entirely. Watch mode uses the same pipeline stages, just triggered per-file instead of per-project. The `insertNodes` and `buildEdges` stages are literally the same functions.

---

## 16. Export Module Should Support Filtering and Subgraph Extraction

**Current state:** `export.js` exports the entire graph or nothing. DOT/Mermaid/JSON always include all nodes and edges.

**Problem:** For a 5K-node graph, the DOT output is unusable — Graphviz chokes, Mermaid renders an incomprehensible hairball.

**Ideal enhancement:**

```bash
codegraph export --format dot --focus src/builder.js --depth 2
# Exports only builder.js and its 2-hop neighborhood

codegraph export --format mermaid --filter "src/api/**" --kind function
# Only functions in the api directory

codegraph export --format json --changed  # Only files changed since last commit
```

The export module receives a subgraph specification (focus node + depth, file pattern, kind filter) and extracts the relevant subgraph before formatting. This makes visualization actually useful for real projects.

---

## 17. Error Handling Is Ad-Hoc — Introduce Domain Errors

**Current state:** Errors are handled inconsistently:
- Some functions throw generic `Error`
- Some return null/undefined on failure
- Some call `logger.warn()` and continue
- Some call `process.exit(1)`

**Problem:** Callers can't distinguish "file not found" from "parse failed" from "DB corrupt" without inspecting error message strings. The MCP server wraps everything in try-catch and returns generic error text.

**Ideal architecture:**

```js
// errors.js
export class CodegraphError extends Error {
  constructor(message, { code, file, cause } = {}) { ... }
}

export class ParseError extends CodegraphError { code = 'PARSE_FAILED' }
export class DbError extends CodegraphError { code = 'DB_ERROR' }
export class ConfigError extends CodegraphError { code = 'CONFIG_INVALID' }
export class ResolutionError extends CodegraphError { code = 'RESOLUTION_FAILED' }
export class EngineError extends CodegraphError { code = 'ENGINE_UNAVAILABLE' }
```

The CLI catches domain errors and formats them for humans. The MCP server catches them and returns structured error responses. The programmatic API lets them propagate. No more `process.exit()` from library code.

---

## 18. The Programmatic API (index.js) Exposes Too Much

**Current state:** `index.js` re-exports ~40 functions from every module — internal helpers, data functions, presentation functions, DB utilities, everything.

**Problem:** There's no distinction between public API and internal implementation. A consumer importing `buildGraph` also sees `findChild` (a tree-sitter helper) and `openDb` (internal DB function). Any refactoring risks breaking unnamed consumers.

**Ideal architecture — explicit public surface:**

```js
// index.js — curated public API only
export { buildGraph } from './builder.js'
export { queryFunction, impactAnalysis, fileDeps, fnDeps, diffImpact } from './analysis/index.js'
export { search, multiSearch, embedSymbols } from './embeddings/index.js'
export { detectCycles } from './analysis/cycles.js'
export { exportGraph } from './export.js'
export { startMcpServer } from './mcp/server.js'
export { loadConfig } from './config.js'
```

Everything else is internal. Use `package.json` `exports` field to enforce module boundaries:

```json
{
  "exports": {
    ".": "./src/index.js",
    "./cli": "./src/cli.js"
  }
}
```

Consumers can only import from the documented entry points. Internal modules are truly internal.

---

## Summary — Priority Ordering by Architectural Impact

| # | Change | Impact | Category |
|---|--------|--------|----------|
| 1 | Split parser.js into plugin system | High | Modularity |
| 2 | Repository pattern for data access | High | Testability, maintainability |
| 3 | Separate analysis / formatting layers | High | Separation of concerns |
| 4 | Pipeline architecture for builder | High | Testability, reuse |
| 6 | Unified engine interface (Strategy) | Medium-High | Abstraction |
| 5 | Embedder as standalone subsystem | Medium | Extensibility |
| 13 | Qualified names + scoping in graph model | Medium | Data model accuracy |
| 7 | Event-driven pipeline for streaming | Medium | Scalability, UX |
| 10 | Composable MCP tool registry | Medium | Extensibility |
| 12 | CLI command objects | Medium | Maintainability |
| 17 | Domain error hierarchy | Medium | Reliability |
| 18 | Curated public API surface | Medium | API stability |
| 11 | Testing pyramid with proper layers | Medium | Quality |
| 16 | Subgraph export with filtering | Low-Medium | Usability |
| 9 | Transitive import-aware confidence | Low-Medium | Accuracy |
| 14 | Query result caching | Low | Performance |
| 8 | Config profiles for monorepos | Low | Feature |
| 15 | Unify watcher/builder code paths | Low | Falls out of #4 |

Items 1–4 and 6 are foundational — they restructure the core and everything else becomes easier after them. Items 13 and 7 are the most impactful feature-level changes. Items 14–15 are natural consequences of earlier changes.

---

*Generated 2026-02-22. Cold architectural analysis — no implementation constraints applied.*
