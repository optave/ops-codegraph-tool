# Codegraph Roadmap

> **Current version:** 1.4.0 | **Status:** Active development | **Updated:** February 2026

Codegraph is a strong local-first code graph CLI. This roadmap describes planned improvements across seven phases — closing gaps with commercial code intelligence platforms while preserving codegraph's core strengths: fully local, open source, zero cloud dependency by default.

**LLM strategy:** All LLM-powered features are **optional enhancements**. Everything works without an API key. When configured (OpenAI, Anthropic, Ollama, or any OpenAI-compatible endpoint), users unlock richer semantic search and natural language queries.

---

## Overview

| Phase | Theme | Key Deliverables | Status |
|-------|-------|-----------------|--------|
| [**1**](#phase-1--rust-core) | Rust Core | Rust parsing engine via napi-rs, parallel parsing, incremental tree-sitter, JS orchestration layer | **Complete** (v1.3.0) |
| [**2**](#phase-2--foundation-hardening) | Foundation Hardening | Parser registry, complete MCP, test coverage, enhanced config, multi-repo MCP | **Complete** (v1.4.0) |
| [**3**](#phase-3--intelligent-embeddings) | Intelligent Embeddings | LLM-generated descriptions, hybrid search, build-time semantic metadata, module summaries | Planned |
| [**4**](#phase-4--natural-language-queries) | Natural Language Queries | `ask` command, conversational sessions, LLM-narrated graph queries, onboarding tools | Planned |
| [**5**](#phase-5--expanded-language-support) | Expanded Language Support | 8 new languages (12 → 20), parser utilities | Planned |
| [**6**](#phase-6--github-integration--ci) | GitHub Integration & CI | Reusable GitHub Action, LLM-enhanced PR review, visual impact graphs, SARIF output | Planned |
| [**7**](#phase-7--interactive-visualization--advanced-features) | Visualization & Advanced | Web UI, dead code detection, monorepo, agentic search, refactoring analysis | Planned |

### Dependency graph

```
Phase 1 (Rust Core)
  └──→ Phase 2 (Foundation Hardening)
         ├──→ Phase 3 (Embeddings + Metadata)  ──→ Phase 4 (NL Queries + Narration)
         ├──→ Phase 5 (Languages)
         └──→ Phase 6 (GitHub/CI) ←── Phase 3 (risk_score, side_effects)
Phases 1-4 ──→ Phase 7 (Visualization + Refactoring Analysis)
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

## Phase 3 — Intelligent Embeddings

**Goal:** Dramatically improve semantic search quality by embedding natural-language descriptions instead of raw code.

### 3.1 — LLM Description Generator

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

### 3.2 — Enhanced Embedding Pipeline

- When descriptions exist, embed the description text instead of raw code
- Keep raw code as fallback when no description is available
- Add `--use-descriptions` flag to `codegraph embed` (default: true when descriptions exist)
- Store embedding source type in `embedding_meta` (code vs description)

**Expected improvement:** ~12% better semantic similarity for natural-language queries.

**Affected files:** `src/embedder.js`

### 3.3 — Hybrid Search

Combine vector similarity with keyword matching.

- **Vector search:** Cosine similarity against embeddings (existing)
- **Keyword search:** SQLite FTS5 full-text index on `nodes.name` + `descriptions`
- **Fusion:** Weighted RRF — `score = a * vector_rank + (1-a) * keyword_rank`
- Default `a = 0.7` (favor semantic), configurable

**New DB migration:** Add FTS5 virtual table for text search.

**Affected files:** `src/embedder.js`, `src/db.js`

### 3.4 — Build-time Semantic Metadata

Enrich nodes with LLM-generated metadata beyond descriptions. Computed incrementally at build time (only for changed nodes), stored as columns on the `nodes` table.

| Column | Content | Example |
|--------|---------|---------|
| `side_effects` | Mutation/IO tags | `"writes DB"`, `"sends email"`, `"mutates state"` |
| `complexity_notes` | Responsibility count, cohesion rating | `"3 responsibilities, low cohesion — consider splitting"` |
| `risk_score` | Fragility metric from graph centrality + LLM assessment | `0.82` (high fan-in + complex logic) |

- MCP tool: `assess <name>` — returns complexity rating + specific concerns
- Cascade invalidation: when a node changes, mark dependents for re-enrichment

**Depends on:** 3.1 (LLM provider abstraction)

### 3.5 — Module Summaries

Aggregate function descriptions + dependency direction into file-level narratives.

- `module_summaries` table — one entry per file, re-rolled when any contained node changes
- MCP tool: `explain_module <file>` — returns module purpose, key exports, role in the system
- `naming_conventions` metadata per module — detected patterns (camelCase, snake_case, verb-first), flag outliers

**Depends on:** 3.1 (function-level descriptions must exist first)

> **Full spec:** See [llm-integration.md](./llm-integration.md) for detailed architecture, infrastructure table, and prompt design.

---

## Phase 4 — Natural Language Queries

**Goal:** Allow developers to ask questions about their codebase in plain English.

### 4.1 — Query Engine

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

### 4.2 — Conversational Sessions

Multi-turn conversations with session memory.

```bash
codegraph ask "How does auth work?" --session my-session
codegraph ask "What about the token refresh?" --session my-session
codegraph sessions list
codegraph sessions clear
```

- Store conversation history in SQLite table `sessions`
- Include prior Q&A pairs in subsequent prompts

### 4.3 — MCP Integration

New MCP tool: `ask_codebase` — natural language query via MCP.

Enables AI coding agents (Claude Code, Cursor, etc.) to ask codegraph questions about the codebase.

**Affected files:** `src/mcp.js`

### 4.4 — LLM-Narrated Graph Queries

Graph traversal + LLM narration for questions that require both structural data and natural-language explanation. Each query walks the graph first, then sends the structural result to the LLM for narration.

| Query | Graph operation | LLM adds |
|-------|----------------|----------|
| `trace_flow <entry>` | BFS from entry point to leaves | Sequential narrative: "1. handler validates → 2. calls createOrder → 3. writes DB" |
| `trace_upstream <name>` | Recursive caller walk | Ranked suspects: "most likely cause is X because it modifies the same state" |
| `effect_analysis <name>` | Full callee tree walk, aggregate `side_effects` | "Calling X will: write to DB (via Y), send email (via Z)" |
| `dependency_path <A> <B>` | Shortest path(s) between two symbols | Narrates each hop: "A imports X from B because A needs to validate tokens" |

Pre-computed `flow_narratives` table caches results for key entry points at build time, invalidated when any node in the chain changes.

**Depends on:** 3.4 (`side_effects` metadata), 3.1 (descriptions for narration context)

### 4.5 — Onboarding & Navigation Tools

Help new contributors and AI agents orient in an unfamiliar codebase.

- `entry_points` query — graph finds roots (high fan-out, low fan-in) + LLM ranks by importance
- `onboarding_guide` command — generates a reading order based on dependency layers
- MCP tool: `get_started` — returns ordered list: "start here, then read this, then this"
- `change_plan <description>` — LLM reads description, graph identifies relevant modules, returns touch points and test coverage gaps

**Depends on:** 3.5 (module summaries for context), 4.1 (query engine)

---

## Phase 5 — Expanded Language Support

**Goal:** Go from 12 → 20 supported languages.

### 5.1 — Batch 1: High Demand

| Language | Extensions | Grammar | Effort |
|----------|-----------|---------|--------|
| C | `.c`, `.h` | `tree-sitter-c` | Low |
| C++ | `.cpp`, `.hpp`, `.cc`, `.cxx` | `tree-sitter-cpp` | Medium |
| Kotlin | `.kt`, `.kts` | `tree-sitter-kotlin` | Low |
| Swift | `.swift` | `tree-sitter-swift` | Medium |

### 5.2 — Batch 2: Growing Ecosystems

| Language | Extensions | Grammar | Effort |
|----------|-----------|---------|--------|
| Scala | `.scala`, `.sc` | `tree-sitter-scala` | Medium |
| Dart | `.dart` | `tree-sitter-dart` | Low |
| Lua | `.lua` | `tree-sitter-lua` | Low |
| Zig | `.zig` | `tree-sitter-zig` | Low |

### 5.3 — Parser Abstraction Layer

Extract shared patterns from existing extractors into reusable helpers.

| Helper | Purpose |
|--------|---------|
| `findParentNode(node, typeNames)` | Walk parent chain to find enclosing class/struct |
| `extractBodyMethods(bodyNode, parentName)` | Extract method definitions from a body block |
| `normalizeImportPath(importText)` | Cross-language import path normalization |

**Result:** Reduces boilerplate for each new language from ~200 lines to ~80 lines.

**New file:** `src/parser-utils.js`

---

## Phase 6 — GitHub Integration & CI

**Goal:** Bring codegraph's analysis into pull request workflows.

### 6.1 — Reusable GitHub Action

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

### 6.2 — PR Review Integration

```bash
codegraph review --pr <number>
```

Requires `gh` CLI. For each changed function:

1. Fetch PR diff via `gh pr diff`
2. Run `diff-impact` on the diff
3. Check: blast radius (caller count), contract changes (signature/return type), test coverage for affected callers
4. Generate review summary (optionally LLM-enhanced)
5. Post as PR comment via `gh pr comment`

**LLM-enhanced mode** (when LLM provider configured):

- **Risk labels per node**: `low` (cosmetic / internal), `medium` (behavior change), `high` (breaking / public API)
- **Review focus ranking**: rank affected files by risk × blast radius — "review this file first"
- **Critical path highlighting**: shortest path from a changed function to a high-fan-in entry point
- **Test coverage gaps**: cross-reference affected code with test file graph edges

**New file:** `src/github.js`

### 6.3 — Visual Impact Graphs for PRs

Extend the existing `diff-impact --format mermaid` foundation with CI automation and LLM annotations.

**CI automation** (GitHub Action):
1. `codegraph build .` (incremental, fast on CI cache)
2. `codegraph diff-impact $BASE_REF --format mermaid -T` to generate the graph
3. Post as PR comment — GitHub renders Mermaid natively in markdown
4. Update on new pushes (edit the existing comment)

**LLM-enriched annotations** (when provider configured):
- For each changed function: one-line summary of WHAT changed (from diff hunks)
- For each affected caller: WHY it's affected — what behavior might change downstream
- Node colors shift from green → yellow → red based on risk labels
- Overall PR risk score (aggregate of node risks weighted by centrality)

**Historical context overlay:**
- Annotate nodes with churn data: "this function changed 12 times in the last 30 days"
- Highlight fragile nodes: high churn + high fan-in = high breakage risk
- Track blast radius trends: "this PR's blast radius is 2× larger than your average"

**Depends on:** 6.1 (GitHub Action), 3.4 (`risk_score`, `side_effects`)

### 6.4 — SARIF Output

Add SARIF output format for cycle detection. SARIF integrates with GitHub Code Scanning, showing issues inline in the PR.

**Affected files:** `src/export.js`

---

## Phase 7 — Interactive Visualization & Advanced Features

### 7.1 — Interactive Web Visualization

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

### 7.2 — Dead Code Detection

```bash
codegraph dead
codegraph dead --exclude-exports --exclude-tests
```

Find functions/methods/classes with zero incoming edges (never called). Filters for exports, test files, and entry points.

**Affected files:** `src/queries.js`

### 7.3 — Cross-Repository Support (Monorepo)

Support multi-package monorepos with cross-package edges.

- Detect workspace root (`package.json` workspaces, `pnpm-workspace.yaml`, `lerna.json`)
- Resolve internal package imports (e.g., `@myorg/utils`) to actual source files
- Add `package` column to nodes table
- `codegraph build --workspace` to scan all packages
- Impact analysis across package boundaries

### 7.4 — Agentic Search

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

### 7.5 — Refactoring Analysis

LLM-powered structural analysis that identifies refactoring opportunities. The graph provides the structural data; the LLM interprets it.

| Command | Graph operation | LLM adds |
|---------|----------------|----------|
| `split_analysis <file>` | Cluster tightly-coupled functions within a file | Proposed split, cross-boundary edges, circular import risk |
| `extraction_candidates` | Find high fan-in, low internal coupling functions | Rank by utility: "pure helper" vs "has side effects, risky to move" |
| `signature_impact <name>` | All call sites from graph edges | Suggested new signature, adapter pattern if needed, call sites to update |
| `lint-names` | Detect naming patterns per module | Flag outliers against detected conventions (camelCase, snake_case, verb-first) |
| `hotspots` | High fan-in + high fan-out + on many paths | Ranked fragility report with explanations, `risk_score` per node |
| `boundary_analysis` | Graph clustering (tightly-coupled groups spanning modules) | Reorganization suggestions: "these 4 functions in 3 files all deal with auth" |

**Depends on:** 3.4 (`risk_score`, `complexity_notes`), 3.5 (module summaries)

### 7.6 — Auto-generated Docstrings

```bash
codegraph annotate
codegraph annotate --changed-only
```

LLM-generated docstrings aware of callers, callees, and types. Diff-aware: only regenerate for functions whose code or dependencies changed. Stores in `docstrings` column on nodes table — does not modify source files unless explicitly requested.

**Depends on:** 3.1 (LLM provider abstraction), 3.4 (side effects context)

> **Full spec:** See [llm-integration.md](./llm-integration.md) for detailed architecture, infrastructure tables, and prompt design for all LLM-powered features.

---

## Verification Strategy

Each phase includes targeted verification:

| Phase | Verification |
|-------|-------------|
| **1** | Benchmark native vs WASM parsing on a large repo, verify identical output from both engines |
| **2** | `npm test`, manual MCP client test for all tools, config loading tests |
| **3** | Compare `codegraph search` quality before/after descriptions; verify `side_effects` and `risk_score` populated for LLM-enriched builds |
| **4** | `codegraph ask "How does import resolution work?"` against codegraph itself; verify `trace_flow` and `get_started` produce coherent narration |
| **5** | Parse sample files for each new language, verify definitions/calls/imports |
| **6** | Test PR in a fork, verify GitHub Action comment with Mermaid graph and risk labels is posted |
| **7** | `codegraph viz` loads; `hotspots` returns ranked list; `split_analysis` produces actionable output |

**Full integration test** after all phases:

```bash
codegraph build .
codegraph embed --describe        # LLM-enhanced descriptions
codegraph search "middleware error handling"
codegraph ask "How does routing work?"
codegraph trace_flow handleRequest # LLM-narrated execution flow
codegraph hotspots                 # Fragility report with risk scores
codegraph diff-impact HEAD~5
codegraph review --pr 42           # LLM-enhanced PR review
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
