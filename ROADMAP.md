# Codegraph Roadmap

> **Current version:** 1.4.0 | **Status:** Active development | **Updated:** February 2026

Codegraph is a strong local-first code graph CLI. This roadmap describes planned improvements across eight phases — closing gaps with commercial code intelligence platforms while preserving codegraph's core strengths: fully local, open source, zero cloud dependency by default.

**LLM strategy:** All LLM-powered features are **optional enhancements**. Everything works without an API key. When configured (OpenAI, Anthropic, Ollama, or any OpenAI-compatible endpoint), users unlock richer semantic search and natural language queries.

---

## Overview

| Phase | Theme | Key Deliverables | Status |
|-------|-------|-----------------|--------|
| [**1**](#phase-1--rust-core) | Rust Core | Rust parsing engine via napi-rs, parallel parsing, incremental tree-sitter, JS orchestration layer | **Complete** (v1.3.0) |
| [**2**](#phase-2--foundation-hardening) | Foundation Hardening | Parser registry, complete MCP, test coverage, enhanced config, multi-repo MCP | **Complete** (v1.4.0) |
| [**3**](#phase-3--architectural-refactoring) | Architectural Refactoring | Parser plugin system, repository pattern, pipeline builder, engine strategy, analysis/formatting split, domain errors, CLI commands, composable MCP, curated API | Planned |
| [**4**](#phase-4--intelligent-embeddings) | Intelligent Embeddings | LLM-generated descriptions, hybrid search | Planned |
| [**5**](#phase-5--natural-language-queries) | Natural Language Queries | `ask` command, conversational sessions | Planned |
| [**6**](#phase-6--expanded-language-support) | Expanded Language Support | 8 new languages (12 → 20), parser utilities | Planned |
| [**7**](#phase-7--github-integration--ci) | GitHub Integration & CI | Reusable GitHub Action, PR review, SARIF output | Planned |
| [**8**](#phase-8--interactive-visualization--advanced-features) | Visualization & Advanced | Web UI, dead code detection, monorepo, agentic search | Planned |

### Dependency graph

```
Phase 1 (Rust Core)
  └──→ Phase 2 (Foundation Hardening)
         └──→ Phase 3 (Architectural Refactoring)
                ├──→ Phase 4 (Embeddings)  ──→ Phase 5 (NL Queries)
                ├──→ Phase 6 (Languages)
                └──→ Phase 7 (GitHub/CI)
Phases 1-5 ──→ Phase 8 (Visualization & Advanced)
```

---

## Phase 1 — Rust Core ✅

> **Status:** Complete — shipped in v1.3.0

**Goal:** Move the CPU-intensive parsing and graph engine to Rust, keeping JS for CLI orchestration, MCP, and embeddings. This unlocks parallel parsing, incremental tree-sitter, lower memory usage, and optional standalone binary distribution.

### 1.1 — Rust Workspace & napi-rs Setup ✅

Bootstrap the Rust side of the project.

- Create `crates/codegraph-core/` with a Cargo workspace
- Set up [napi-rs](https://napi.rs/) to compile Rust → `.node` native addon
- Configure CI matrix for prebuilt binaries: `linux-x64`, `darwin-arm64`, `darwin-x64`, `win32-x64`
- Add npm optionalDependencies for platform-specific packages (same pattern as SWC/esbuild)
- Fallback to existing JS/WASM path if native addon is unavailable

**Result:** `npm install` pulls a prebuilt binary; no Rust toolchain required for end users.

### 1.2 — Native tree-sitter Parsing ✅

Replace WASM-based parsing with native tree-sitter in Rust.

- Link tree-sitter grammars natively (no more `.wasm` files)
- Implement file parsing with rayon for multi-core parallelism
- Expose `parseFiles(filePaths)` to JS via napi-rs, returning extracted symbols/imports/calls
- Benchmark: target 10-50x improvement over WASM on large codebases

**Result:** Parsing thousands of files uses all CPU cores. The `grammars/` directory and `build:wasm` step are no longer needed.

**Affected files:** `src/parser.js` (becomes a thin JS wrapper over native addon)

### 1.3 — Incremental Parsing ✅

Leverage native tree-sitter's `edit + re-parse` API.

- Track previous parse trees in memory for open/watched files
- On file change, apply edits to the existing tree and re-parse only the changed regions
- Integrate with `codegraph watch` for near-instant incremental rebuilds

**Result:** Watch mode re-parses only changed lines instead of entire files.

**Affected files:** `src/watcher.js`, `src/parser.js`

### 1.4 — Import Resolution & Graph Algorithms in Rust ✅

Move the hot-path graph logic to Rust.

- Port the 6-level import resolution priority system with confidence scoring
- Port cycle detection (currently `src/cycles.js`) to Rust
- Keep SQLite operations in JS (better-sqlite3 is already fast and synchronous)
- Expose `resolveImports()` and `detectCycles()` to JS via napi-rs

**Result:** Import resolution and cycle detection run in Rust with full type safety. Complex state machines benefit from Rust's type system.

### 1.5 — Graceful Degradation & Migration ✅

Ensure the transition is seamless.

- Keep the existing JS/WASM parser as a fallback when the native addon is unavailable
- Auto-detect at startup: native addon available → use Rust path; otherwise → WASM path
- No breaking changes to CLI, MCP, or programmatic API
- Add `--engine native|wasm` flag for explicit selection
- Migrate existing tests to validate both engines produce identical output

**Result:** Zero breaking changes. Users get faster parsing automatically; nothing else changes.

---

## Phase 2 — Foundation Hardening ✅

> **Status:** Complete — shipped in v1.4.0

**Goal:** Fix structural issues that make subsequent phases harder.

### 2.1 — Language Parser Registry ✅

Replace scattered parser init/selection logic with a single declarative registry.

- ✅ Create a `LANGUAGE_REGISTRY` array mapping each language to `{ id, extensions, grammarFile, extractor, required }`
- ✅ Refactor `createParsers()` to iterate the registry instead of individual try/catch blocks (returns `Map<string, Parser|null>`)
- ✅ Refactor `getParser()` to use registry extension lookup via `_extToLang` Map
- ✅ Refactor `wasmExtractSymbols()` to dispatch extractors via `entry.extractor`
- ✅ Auto-generate `EXTENSIONS` from registry (re-exported from `parser.js` via `SUPPORTED_EXTENSIONS`)

**Result:** Adding a new language becomes a single registry entry + extractor function.

**Affected files:** `src/parser.js`, `src/constants.js`

### 2.2 — Complete MCP Server ✅

Expose all CLI capabilities through MCP, going from 5 → 11 tools.

| New tool | Wraps | Description |
|----------|-------|-------------|
| ✅ `fn_deps` | `fnDepsData` | Function-level dependency chain |
| ✅ `fn_impact` | `fnImpactData` | Function-level blast radius |
| ✅ `diff_impact` | `diffImpactData` | Git diff impact analysis |
| ✅ `semantic_search` | `searchData` | Embedding-powered search |
| ✅ `export_graph` | export functions | DOT/Mermaid/JSON export |
| ✅ `list_functions` | — | List functions in a file or by pattern |

**Affected files:** `src/mcp.js`

### 2.3 — Test Coverage Gaps ✅

Add tests for currently untested modules.

| New test file | Coverage |
|---------------|----------|
| ✅ `tests/unit/mcp.test.js` | All MCP tools (mock stdio transport) |
| ✅ `tests/unit/config.test.js` | Config loading, defaults, env overrides, apiKeyCommand |
| ✅ `tests/integration/cli.test.js` | End-to-end CLI smoke tests |
| ✅ `tests/unit/*.test.js` | Unit tests for 8 core modules (coverage 62% → 75%) |

### 2.4 — Enhanced Configuration ✅

New configuration options in `.codegraphrc.json`:

```json
{
  "embeddings": { "model": "minilm", "llmProvider": null },
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "baseUrl": null,
    "apiKey": null,
    "apiKeyCommand": "op read op://vault/openai/api-key"
  },
  "search": { "defaultMinScore": 0.2, "rrfK": 60, "topK": 15 },
  "ci": { "failOnCycles": false, "impactThreshold": null }
}
```

- ✅ Environment variable fallbacks: `CODEGRAPH_LLM_PROVIDER`, `CODEGRAPH_LLM_API_KEY`, `CODEGRAPH_LLM_MODEL`
- ✅ `apiKeyCommand` — shell out to external secret managers (1Password, Bitwarden, Vault, pass, macOS Keychain) at runtime via `execFileSync` (no shell injection). Priority: command output > env var > file config > defaults. Graceful fallback on failure.

**Affected files:** `src/config.js`

### 2.5 — Multi-Repo MCP ✅

Support querying multiple codebases from a single MCP server instance.

- ✅ Registry file at `~/.codegraph/registry.json` mapping repo names to their `.codegraph/graph.db` paths
- ✅ Add optional `repo` parameter to all 11 MCP tools to target a specific repository
- ✅ New `list_repos` MCP tool (12th tool) to enumerate registered repositories
- ✅ Auto-registration: `codegraph build` adds the current project to the registry
- ✅ New CLI commands: `codegraph registry list|add|remove` for manual management
- ✅ Default behavior: when `repo` is omitted, use the local `.codegraph/graph.db` (backwards compatible)

**New files:** `src/registry.js`
**Affected files:** `src/mcp.js`, `src/cli.js`, `src/builder.js`, `src/index.js`

---

## Phase 3 — Architectural Refactoring

**Goal:** Restructure the codebase for modularity, testability, and long-term maintainability. These are internal improvements — no new user-facing features, but they make every subsequent phase easier to build and maintain.

> Reference: [generated/architecture.md](generated/architecture.md) — full analysis with code examples and rationale.

### 3.1 — Parser Plugin System

Split `parser.js` (2,200+ lines) into a modular directory structure with isolated per-language extractors.

```
src/parser/
  index.js              # Public API: parseFileAuto, parseFilesAuto
  registry.js           # LANGUAGE_REGISTRY + extension mapping
  engine.js             # Native/WASM init, engine resolution, grammar loading
  tree-utils.js         # findChild, findParentClass, walkTree helpers
  base-extractor.js     # Shared walk loop + accumulator framework
  extractors/
    javascript.js       # JS/TS/TSX
    python.js
    go.js
    rust.js
    java.js
    csharp.js
    ruby.js
    php.js
    hcl.js
```

Introduce a `BaseExtractor` that owns the tree walk loop. Each language extractor declares a `nodeType → handler` map instead of reimplementing the traversal. Eliminates repeated walk-and-switch boilerplate across 9+ extractors.

**Affected files:** `src/parser.js` → split into `src/parser/`

### 3.2 — Repository Pattern for Data Access

Consolidate all SQL into a single `Repository` class. Currently SQL is scattered across `builder.js`, `queries.js`, `embedder.js`, `watcher.js`, and `cycles.js`.

```
src/db/
  connection.js         # Open, WAL mode, pragma tuning
  migrations.js         # Schema versions
  repository.js         # ALL data access methods (reads + writes)
```

All prepared statements, index tuning, and schema knowledge live in one place. Consumers never see SQL. Enables an `InMemoryRepository` for fast unit tests.

**Affected files:** `src/db.js` → split into `src/db/`, SQL extracted from `builder.js`, `queries.js`, `embedder.js`, `watcher.js`, `cycles.js`

### 3.3 — Analysis / Formatting Separation

Split `queries.js` (800+ lines) into pure analysis modules and presentation formatters.

```
src/analysis/           # Pure data: take repository, return typed results
  impact.js
  call-chain.js
  diff-impact.js
  module-map.js
  class-hierarchy.js

src/formatters/         # Presentation: take data, produce strings
  cli-formatter.js
  json-formatter.js
  table-formatter.js
```

Analysis modules return pure data. The CLI, MCP server, and programmatic API each pick their own formatter (or none). Eliminates the `*Data()` / `*()` dual-function pattern.

**Affected files:** `src/queries.js` → split into `src/analysis/` + `src/formatters/`

### 3.4 — Builder Pipeline Architecture

Refactor `buildGraph()` from a monolithic mega-function into explicit, independently testable pipeline stages.

```js
const pipeline = [
  collectFiles,      // (rootDir, config) => filePaths[]
  detectChanges,     // (filePaths, db) => { changed, removed, isFullBuild }
  parseFiles,        // (filePaths, engineOpts) => Map<file, symbols>
  insertNodes,       // (symbolMap, db) => nodeIndex
  resolveImports,    // (symbolMap, rootDir, aliases) => importEdges[]
  buildCallEdges,    // (symbolMap, nodeIndex) => callEdges[]
  buildClassEdges,   // (symbolMap, nodeIndex) => classEdges[]
  resolveBarrels,    // (edges, symbolMap) => resolvedEdges[]
  insertEdges,       // (allEdges, db) => stats
]
```

Watch mode reuses the same stages (triggered per-file instead of per-project), eliminating the divergence between `watcher.js` and `builder.js` where bug fixes must be applied separately.

**Affected files:** `src/builder.js`, `src/watcher.js`

### 3.5 — Unified Engine Interface

Replace scattered `engine.name === 'native'` branching with a Strategy pattern. Every consumer receives an engine object with the same API regardless of backend.

```js
const engine = createEngine(opts) // returns same interface for native or WASM
engine.parseFile(path, source)
engine.resolveImports(batch, rootDir, aliases)
engine.detectCycles(db)
```

Consumers never branch on native vs WASM. Adding a third backend (e.g., remote parsing service) requires zero consumer changes.

**Affected files:** `src/parser.js`, `src/resolve.js`, `src/cycles.js`, `src/builder.js`, `src/native.js`

### 3.6 — Qualified Names & Hierarchical Scoping

Enrich the node model with scope information to reduce ambiguity.

```sql
ALTER TABLE nodes ADD COLUMN qualified_name TEXT;  -- 'DateHelper.format'
ALTER TABLE nodes ADD COLUMN scope TEXT;            -- 'DateHelper'
ALTER TABLE nodes ADD COLUMN visibility TEXT;       -- 'public' | 'private' | 'protected'
```

Enables queries like "all methods of class X" without traversing edges. Reduces reliance on heuristic confidence scoring for name collisions.

**Affected files:** `src/db.js`, `src/parser.js` (extractors), `src/queries.js`, `src/builder.js`

### 3.7 — Composable MCP Tool Registry

Replace the monolithic `TOOLS` array + `switch` dispatch in `mcp.js` with self-contained tool modules.

```
src/mcp/
  server.js             # MCP server setup, transport, lifecycle
  tool-registry.js      # Dynamic tool registration + auto-discovery
  tools/
    query-function.js   # { schema, handler } per tool
    file-deps.js
    impact-analysis.js
    ...
```

Adding a new MCP tool = adding a file. No other files change.

**Affected files:** `src/mcp.js` → split into `src/mcp/`

### 3.8 — CLI Command Objects

Move from inline Commander chains in `cli.js` to self-contained command modules.

```
src/cli/
  index.js              # Commander setup, auto-discover commands
  commands/
    build.js            # { name, description, options, validate, execute }
    query.js
    impact.js
    ...
```

Each command is independently testable by calling `execute()` directly. The CLI index auto-discovers and registers them.

**Affected files:** `src/cli.js` → split into `src/cli/`

### 3.9 — Domain Error Hierarchy

Replace ad-hoc error handling (mix of thrown `Error`, returned `null`, `logger.warn()`, `process.exit(1)`) with structured domain errors.

```js
class CodegraphError extends Error { constructor(message, { code, file, cause }) { ... } }
class ParseError extends CodegraphError { code = 'PARSE_FAILED' }
class DbError extends CodegraphError { code = 'DB_ERROR' }
class ConfigError extends CodegraphError { code = 'CONFIG_INVALID' }
class ResolutionError extends CodegraphError { code = 'RESOLUTION_FAILED' }
class EngineError extends CodegraphError { code = 'ENGINE_UNAVAILABLE' }
```

CLI catches domain errors and formats for humans. MCP returns structured error responses. No more `process.exit()` from library code.

**New file:** `src/errors.js`

### 3.10 — Curated Public API Surface

Reduce `index.js` from ~40 re-exports to a curated public API. Use `package.json` `exports` field to enforce module boundaries.

```json
{ "exports": { ".": "./src/index.js", "./cli": "./src/cli.js" } }
```

Internal modules become truly internal. Consumers can only import from documented entry points.

**Affected files:** `src/index.js`, `package.json`

### 3.11 — Embedder Subsystem Extraction

Restructure `embedder.js` (525 lines) into a standalone subsystem with pluggable vector storage.

```
src/embeddings/
  index.js              # Public API
  model-registry.js     # Model definitions, batch sizes, loading
  generator.js          # Source → text preparation → batch embedding
  store.js              # Vector storage (pluggable: SQLite blob, HNSW index)
  search.js             # Similarity search, RRF multi-query fusion
```

Decouples embedding schema from the graph DB. The pluggable store interface enables future O(log n) ANN search (e.g., `hnswlib-node`) when symbol counts reach 50K+.

**Affected files:** `src/embedder.js` → split into `src/embeddings/`

### 3.12 — Testing Pyramid

Add proper unit test layer below the existing integration tests.

- Pure unit tests for extractors (pass AST node, assert symbols — no file I/O)
- Pure unit tests for BFS/Tarjan algorithms (pass adjacency list, assert result)
- Pure unit tests for confidence scoring (pass parameters, assert score)
- Repository mock for query tests (in-memory data, no SQLite)
- E2E tests that invoke the CLI binary and assert exit codes + stdout

The repository pattern (3.2) directly enables this: unit tests use `InMemoryRepository`, integration tests use `SqliteRepository`.

### 3.13 — Event-Driven Pipeline

Add an event/streaming architecture to the build pipeline for progress reporting, cancellation, and large-repo support.

```js
pipeline.on('file:parsed',    (file, symbols) => { /* progress */ })
pipeline.on('file:indexed',   (file, nodeCount) => { /* progress */ })
pipeline.on('build:complete',  (stats) => { /* summary */ })
pipeline.on('error',           (file, err) => { /* continue or abort */ })
await pipeline.run(rootDir)
```

Unifies build and watch code paths. Large builds stream results to the DB incrementally instead of buffering in memory.

**Affected files:** `src/builder.js`, `src/watcher.js`, `src/cli.js`

### 3.14 — Subgraph Export Filtering

Add focus/filter options to the export module so visualizations are usable for real projects.

```bash
codegraph export --format dot --focus src/builder.js --depth 2
codegraph export --format mermaid --filter "src/api/**" --kind function
codegraph export --format json --changed
```

The export module receives a subgraph specification (focus node + depth, file pattern, kind filter) and extracts the relevant subgraph before formatting.

**Affected files:** `src/export.js`, `src/cli.js`

### 3.15 — Transitive Import-Aware Confidence

Before falling back to proximity heuristics, walk the import graph from the caller file. If any import path (even indirect through barrel files) reaches a candidate, score it 0.9. Only fall back to proximity when no import path exists.

**Affected files:** `src/resolve.js`, `src/builder.js`

### 3.16 — Query Result Caching

Add a TTL/LRU cache between the analysis layer and the repository. Particularly valuable for MCP where an agent session may repeatedly query related symbols.

```js
class QueryCache {
  constructor(db, maxAge = 60_000) { ... }
  get(key) { ... }        // key = query name + args hash
  set(key, value) { ... }
  invalidate() { ... }    // called after any DB mutation
}
```

### 3.17 — Configuration Profiles

Support profile-based configuration for monorepos with multiple services.

```json
{
  "profiles": {
    "backend":  { "include": ["services/api/**"], "build": { "dbPath": ".codegraph/api.db" } },
    "frontend": { "include": ["apps/web/**"], "build": { "dbPath": ".codegraph/web.db" } }
  }
}
```

```bash
codegraph build --profile backend
```

**Affected files:** `src/config.js`, `src/cli.js`

---

## Phase 4 — Intelligent Embeddings

**Goal:** Dramatically improve semantic search quality by embedding natural-language descriptions instead of raw code.

### 4.1 — LLM Description Generator

For each function/method/class node, generate a concise natural-language description:

```
"Validates a JWT token against the provided secret and algorithm options.
 Params: token (string), options (object with secret, algorithms).
 Returns: boolean. Throws on expired tokens.
 Called by: authenticateRequest, verifySession.
 Calls: jwt.verify, validateOptions."
```

**How it works:**

1. Read source code from `line` to `end_line`
2. Extract existing JSDoc/docstring/comments if present
3. Query caller/callee relationships from the graph DB
4. Build a prompt combining code + context + relationships
5. Call configured LLM (OpenAI, Anthropic, Ollama, or any OpenAI-compatible API)
6. Batch processing with rate limiting and progress bar
7. Store descriptions in a new `descriptions` column on the `nodes` table

**Fallback when no LLM configured:** Use existing raw-code embedding (current behavior, unchanged).

**Incremental:** Only regenerate descriptions for nodes whose file hash changed.

**New file:** `src/describer.js`

### 4.2 — Enhanced Embedding Pipeline

- When descriptions exist, embed the description text instead of raw code
- Keep raw code as fallback when no description is available
- Add `--use-descriptions` flag to `codegraph embed` (default: true when descriptions exist)
- Store embedding source type in `embedding_meta` (code vs description)

**Expected improvement:** ~12% better semantic similarity for natural-language queries.

**Affected files:** `src/embedder.js`

### 4.3 — Hybrid Search

Combine vector similarity with keyword matching.

- **Vector search:** Cosine similarity against embeddings (existing)
- **Keyword search:** SQLite FTS5 full-text index on `nodes.name` + `descriptions`
- **Fusion:** Weighted RRF — `score = a * vector_rank + (1-a) * keyword_rank`
- Default `a = 0.7` (favor semantic), configurable

**New DB migration:** Add FTS5 virtual table for text search.

**Affected files:** `src/embedder.js`, `src/db.js`

---

## Phase 5 — Natural Language Queries

**Goal:** Allow developers to ask questions about their codebase in plain English.

### 5.1 — Query Engine

```bash
codegraph ask "How does the authentication flow work?"
```

**Pipeline:**

1. Embed the question using the same model as search
2. Retrieve top-K relevant functions/classes via hybrid search
3. For each result, fetch caller/callee context from the graph
4. Build a prompt with the question + retrieved code + graph context
5. Send to configured LLM for answer generation
6. Stream response to stdout

**Context assembly strategy:**

- Full source of top 5 matches
- Signatures of top 15 matches
- 1-hop caller/callee names for each match
- Total context budget: ~8K tokens (configurable)

**Requires:** LLM API key configured (no fallback — this is inherently an LLM feature).

**New file:** `src/nlquery.js`

### 5.2 — Conversational Sessions

Multi-turn conversations with session memory.

```bash
codegraph ask "How does auth work?" --session my-session
codegraph ask "What about the token refresh?" --session my-session
codegraph sessions list
codegraph sessions clear
```

- Store conversation history in SQLite table `sessions`
- Include prior Q&A pairs in subsequent prompts

### 5.3 — MCP Integration

New MCP tool: `ask_codebase` — natural language query via MCP.

Enables AI coding agents (Claude Code, Cursor, etc.) to ask codegraph questions about the codebase.

**Affected files:** `src/mcp.js`

---

## Phase 6 — Expanded Language Support

**Goal:** Go from 12 → 20 supported languages.

### 6.1 — Batch 1: High Demand

| Language | Extensions | Grammar | Effort |
|----------|-----------|---------|--------|
| C | `.c`, `.h` | `tree-sitter-c` | Low |
| C++ | `.cpp`, `.hpp`, `.cc`, `.cxx` | `tree-sitter-cpp` | Medium |
| Kotlin | `.kt`, `.kts` | `tree-sitter-kotlin` | Low |
| Swift | `.swift` | `tree-sitter-swift` | Medium |

### 6.2 — Batch 2: Growing Ecosystems

| Language | Extensions | Grammar | Effort |
|----------|-----------|---------|--------|
| Scala | `.scala`, `.sc` | `tree-sitter-scala` | Medium |
| Dart | `.dart` | `tree-sitter-dart` | Low |
| Lua | `.lua` | `tree-sitter-lua` | Low |
| Zig | `.zig` | `tree-sitter-zig` | Low |

### 6.3 — Parser Abstraction Layer

Extract shared patterns from existing extractors into reusable helpers.

| Helper | Purpose |
|--------|---------|
| `findParentNode(node, typeNames)` | Walk parent chain to find enclosing class/struct |
| `extractBodyMethods(bodyNode, parentName)` | Extract method definitions from a body block |
| `normalizeImportPath(importText)` | Cross-language import path normalization |

**Result:** Reduces boilerplate for each new language from ~200 lines to ~80 lines.

**New file:** `src/parser-utils.js`

---

## Phase 7 — GitHub Integration & CI

**Goal:** Bring codegraph's analysis into pull request workflows.

### 7.1 — Reusable GitHub Action

A reusable GitHub Action that runs on PRs:

1. `codegraph build` on the repository
2. `codegraph diff-impact` against the PR's base branch
3. `codegraph cycles` to detect new circular dependencies
4. Posts a PR comment summarizing:
   - Number of affected functions and files
   - New cycles introduced (if any)
   - Top impacted functions with caller counts

**Configuration via `.codegraphrc.json`:**

```json
{ "ci": { "failOnCycles": true, "impactThreshold": 50 } }
```

**Fail conditions:** Configurable — fail if new cycles or impact exceeds threshold.

**New file:** `.github/actions/codegraph-ci/action.yml`

### 7.2 — PR Review Integration

```bash
codegraph review --pr <number>
```

Requires `gh` CLI. For each changed function:

1. Fetch PR diff via `gh pr diff`
2. Run `diff-impact` on the diff
3. Check: blast radius (caller count), contract changes (signature/return type), test coverage for affected callers
4. Generate review summary (optionally LLM-enhanced)
5. Post as PR comment via `gh pr comment`

**New file:** `src/github.js`

### 7.3 — SARIF Output

Add SARIF output format for cycle detection. SARIF integrates with GitHub Code Scanning, showing issues inline in the PR.

**Affected files:** `src/export.js`

---

## Phase 8 — Interactive Visualization & Advanced Features

### 8.1 — Interactive Web Visualization

```bash
codegraph viz
```

Opens a local web UI at `localhost:3000` with:

- Force-directed graph layout (D3.js, inline — no external dependencies)
- Zoom, pan, click-to-expand
- Node coloring by type (file=blue, function=green, class=purple)
- Edge styling by type (imports=solid, calls=dashed, extends=bold)
- Search bar for finding nodes by name
- Filter panel: toggle node kinds, confidence thresholds, test files
- Code preview on hover (reads from source files)

**Data source:** Export JSON from DB, serve via lightweight HTTP server.

**New file:** `src/visualizer.js`

### 8.2 — Dead Code Detection

```bash
codegraph dead
codegraph dead --exclude-exports --exclude-tests
```

Find functions/methods/classes with zero incoming edges (never called). Filters for exports, test files, and entry points.

**Affected files:** `src/queries.js`

### 8.3 — Cross-Repository Support (Monorepo)

Support multi-package monorepos with cross-package edges.

- Detect workspace root (`package.json` workspaces, `pnpm-workspace.yaml`, `lerna.json`)
- Resolve internal package imports (e.g., `@myorg/utils`) to actual source files
- Add `package` column to nodes table
- `codegraph build --workspace` to scan all packages
- Impact analysis across package boundaries

### 8.4 — Agentic Search

Recursive reference-following search that traces connections.

```bash
codegraph agent-search "payment processing"
```

**Pipeline:**

1. Initial semantic search for the query
2. For top results, fetch 1-hop neighbors from the graph
3. Re-rank neighbors by relevance to the original query
4. Follow the most relevant references (up to configurable depth)
5. Return the full chain of related code

**Use case:** "Find everything related to payment processing" → finds payment functions → follows to validation → follows to database layer → returns complete picture.

**Requires:** LLM for relevance re-ranking (optional — degrades to BFS without LLM).

**New file:** `src/agentic-search.js`

---

## Verification Strategy

Each phase includes targeted verification:

| Phase | Verification |
|-------|-------------|
| **1** | Benchmark native vs WASM parsing on a large repo, verify identical output from both engines |
| **2** | `npm test`, manual MCP client test for all tools, config loading tests |
| **3** | All existing tests pass after refactoring; new unit tests for each extracted module; zero behavior changes |
| **4** | Compare `codegraph search` quality before/after descriptions on a real repo |
| **5** | `codegraph ask "How does import resolution work?"` against codegraph itself |
| **6** | Parse sample files for each new language, verify definitions/calls/imports |
| **7** | Test PR in a fork, verify GitHub Action comment is posted |
| **8** | `codegraph viz` loads, nodes are interactive, search works |

**Full integration test** after all phases:

```bash
codegraph build .
codegraph embed --describe        # LLM-enhanced descriptions
codegraph search "middleware error handling"
codegraph ask "How does routing work?"
codegraph diff-impact HEAD~5
codegraph viz
```

---

## Watch List

Technology changes to monitor that may unlock future improvements.

- **`node:sqlite` (Node.js built-in)** — **primary target.** Zero native dependencies, eliminates C++ addon breakage on Node major releases (`better-sqlite3` already broken on Node 24/25). Currently Stability 1.1 (Active Development) as of Node 25.x. Adopt when it reaches Stability 2, or use as a fallback alongside `better-sqlite3` (dual-engine pattern like native/WASM parsing). Backed by the Node.js project — no startup risk.
- **`libsql` (SQLite fork by Turso)** — monitor only. Drop-in `better-sqlite3` replacement with built-in DiskANN vector search. However, Turso is pivoting engineering focus to Limbo (full Rust SQLite rewrite), leaving libsql as legacy. Pre-1.0 (v0.5.x) with uncertain long-term maintenance. Low switching cost (API-compatible, data is standard SQLite), but not worth adopting until the Turso/Limbo situation clarifies.

---

## Contributing

Want to help? Contributions to any phase are welcome. See [CONTRIBUTING](README.md#-contributing) for setup instructions.

If you're interested in working on a specific phase, open an issue to discuss the approach before starting.
