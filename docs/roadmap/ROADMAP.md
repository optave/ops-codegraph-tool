# Codegraph Roadmap

> **Current version:** 3.1.1 | **Status:** Active development | **Updated:** March 2026

Codegraph is a strong local-first code graph CLI. This roadmap describes planned improvements across ten phases -- closing gaps with commercial code intelligence platforms while preserving codegraph's core strengths: fully local, open source, zero cloud dependency by default.

**LLM strategy:** All LLM-powered features are **optional enhancements**. Everything works without an API key. When configured (OpenAI, Anthropic, Ollama, or any OpenAI-compatible endpoint), users unlock richer semantic search and natural language queries.

---

## Overview

| Phase | Theme | Key Deliverables | Status |
|-------|-------|-----------------|--------|
| [**1**](#phase-1--rust-core) | Rust Core | Rust parsing engine via napi-rs, parallel parsing, incremental tree-sitter, JS orchestration layer | **Complete** (v1.3.0) |
| [**2**](#phase-2--foundation-hardening) | Foundation Hardening | Parser registry, complete MCP, test coverage, enhanced config, multi-repo MCP | **Complete** (v1.4.0) |
| [**2.5**](#phase-25--analysis-expansion) | Analysis Expansion | Complexity metrics, community detection, flow tracing, co-change, manifesto, boundary rules, check, triage, audit, batch, hybrid search | **Complete** (v2.6.0) |
| [**2.7**](#phase-27--deep-analysis--graph-enrichment) | Deep Analysis & Graph Enrichment | Dataflow analysis, intraprocedural CFG, AST node storage, expanded node/edge types, extractors refactoring, CLI consolidation, interactive viewer, exports command, normalizeSymbol | **Complete** (v3.0.0) |
| [**3**](#phase-3--architectural-refactoring) | Architectural Refactoring (Vertical Slice) | Unified AST analysis framework, command/query separation, repository pattern, queries.js decomposition, composable MCP, CLI commands, domain errors, presentation layer, domain grouping, curated API, unified graph model | **In Progress** (v3.1.1) |
| [**4**](#phase-4--typescript-migration) | TypeScript Migration | Project setup, core type definitions, leaf -> core -> orchestration module migration, test migration | Planned |
| [**5**](#phase-5--intelligent-embeddings) | Intelligent Embeddings | LLM-generated descriptions, enhanced embeddings, build-time semantic metadata, module summaries | Planned |
| [**6**](#phase-6--natural-language-queries) | Natural Language Queries | `ask` command, conversational sessions, LLM-narrated graph queries, onboarding tools | Planned |
| [**7**](#phase-7--expanded-language-support) | Expanded Language Support | 8 new languages (11 -> 19), parser utilities | Planned |
| [**8**](#phase-8--github-integration--ci) | GitHub Integration & CI | Reusable GitHub Action, LLM-enhanced PR review, visual impact graphs, SARIF output | Planned |
| [**9**](#phase-9--interactive-visualization--advanced-features) | Visualization & Advanced | Web UI, dead code detection, monorepo, agentic search, refactoring analysis | Planned |

### Dependency graph

```
Phase 1 (Rust Core)
  |-->  Phase 2 (Foundation Hardening)
         |-->  Phase 2.5 (Analysis Expansion)
                |-->  Phase 2.7 (Deep Analysis & Graph Enrichment)
                       |-->  Phase 3 (Architectural Refactoring)
                              |-->  Phase 4 (TypeScript Migration)
                                     |-->  Phase 5 (Embeddings + Metadata)  -->  Phase 6 (NL Queries + Narration)
                                     |-->  Phase 7 (Languages)
                                     |-->  Phase 8 (GitHub/CI) <-- Phase 5 (risk_score, side_effects)
Phases 1-6 -->  Phase 9 (Visualization + Refactoring Analysis)
```

---

## Phase 1 -- Rust Core ✅

> **Status:** Complete -- shipped in v1.3.0

**Goal:** Move the CPU-intensive parsing and graph engine to Rust, keeping JS for CLI orchestration, MCP, and embeddings. This unlocks parallel parsing, incremental tree-sitter, lower memory usage, and optional standalone binary distribution.

### 1.1 -- Rust Workspace & napi-rs Setup ✅

Bootstrap the Rust side of the project.

- Create `crates/codegraph-core/` with a Cargo workspace
- Set up [napi-rs](https://napi.rs/) to compile Rust -> `.node` native addon
- Configure CI matrix for prebuilt binaries: `linux-x64`, `darwin-arm64`, `darwin-x64`, `win32-x64`
- Add npm optionalDependencies for platform-specific packages (same pattern as SWC/esbuild)
- Fallback to existing JS/WASM path if native addon is unavailable

**Result:** `npm install` pulls a prebuilt binary; no Rust toolchain required for end users.

### 1.2 -- Native tree-sitter Parsing ✅

Replace WASM-based parsing with native tree-sitter in Rust.

- Link tree-sitter grammars natively (no more `.wasm` files)
- Implement file parsing with rayon for multi-core parallelism
- Expose `parseFiles(filePaths)` to JS via napi-rs, returning extracted symbols/imports/calls
- Benchmark: target 10-50x improvement over WASM on large codebases

**Result:** Parsing thousands of files uses all CPU cores. The `grammars/` directory and `build:wasm` step are no longer needed.

**Affected files:** `src/parser.js` (becomes a thin JS wrapper over native addon)

### 1.3 -- Incremental Parsing ✅

Leverage native tree-sitter's `edit + re-parse` API.

- Track previous parse trees in memory for open/watched files
- On file change, apply edits to the existing tree and re-parse only the changed regions
- Integrate with `codegraph watch` for near-instant incremental rebuilds

**Result:** Watch mode re-parses only changed lines instead of entire files.

**Affected files:** `src/watcher.js`, `src/parser.js`

### 1.4 -- Import Resolution & Graph Algorithms in Rust ✅

Move the hot-path graph logic to Rust.

- Port the 6-level import resolution priority system with confidence scoring
- Port cycle detection (currently `src/cycles.js`) to Rust
- Keep SQLite operations in JS (better-sqlite3 is already fast and synchronous)
- Expose `resolveImports()` and `detectCycles()` to JS via napi-rs

**Result:** Import resolution and cycle detection run in Rust with full type safety. Complex state machines benefit from Rust's type system.

### 1.5 -- Graceful Degradation & Migration ✅

Ensure the transition is seamless.

- Keep the existing JS/WASM parser as a fallback when the native addon is unavailable
- Auto-detect at startup: native addon available -> use Rust path; otherwise -> WASM path
- No breaking changes to CLI, MCP, or programmatic API
- Add `--engine native|wasm` flag for explicit selection
- Migrate existing tests to validate both engines produce identical output

**Result:** Zero breaking changes. Users get faster parsing automatically; nothing else changes.

---

## Phase 2 -- Foundation Hardening ✅

> **Status:** Complete -- shipped in v1.4.0

**Goal:** Fix structural issues that make subsequent phases harder.

### 2.1 -- Language Parser Registry ✅

Replace scattered parser init/selection logic with a single declarative registry.

- ✅ Create a `LANGUAGE_REGISTRY` array mapping each language to `{ id, extensions, grammarFile, extractor, required }`
- ✅ Refactor `createParsers()` to iterate the registry instead of individual try/catch blocks (returns `Map<string, Parser|null>`)
- ✅ Refactor `getParser()` to use registry extension lookup via `_extToLang` Map
- ✅ Refactor `wasmExtractSymbols()` to dispatch extractors via `entry.extractor`
- ✅ Auto-generate `EXTENSIONS` from registry (re-exported from `parser.js` via `SUPPORTED_EXTENSIONS`)

**Result:** Adding a new language becomes a single registry entry + extractor function.

**Affected files:** `src/parser.js`, `src/constants.js`

### 2.2 -- Complete MCP Server ✅

Expose all CLI capabilities through MCP, going from 5 -> 11 tools.

| New tool | Wraps | Description |
|----------|-------|-------------|
| ✅ `fn_deps` | `fnDepsData` | Function-level dependency chain |
| ✅ `fn_impact` | `fnImpactData` | Function-level blast radius |
| ✅ `diff_impact` | `diffImpactData` | Git diff impact analysis |
| ✅ `semantic_search` | `searchData` | Embedding-powered search |
| ✅ `export_graph` | export functions | DOT/Mermaid/JSON export |
| ✅ `list_functions` | -- | List functions in a file or by pattern |

**Affected files:** `src/mcp.js`

### 2.3 -- Test Coverage Gaps ✅

Add tests for currently untested modules.

| New test file | Coverage |
|---------------|----------|
| ✅ `tests/unit/mcp.test.js` | All MCP tools (mock stdio transport) |
| ✅ `tests/unit/config.test.js` | Config loading, defaults, env overrides, apiKeyCommand |
| ✅ `tests/integration/cli.test.js` | End-to-end CLI smoke tests |
| ✅ `tests/unit/*.test.js` | Unit tests for 8 core modules (coverage 62% -> 75%) |

### 2.4 -- Enhanced Configuration ✅

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
- ✅ `apiKeyCommand` -- shell out to external secret managers (1Password, Bitwarden, Vault, pass, macOS Keychain) at runtime via `execFileSync` (no shell injection). Priority: command output > env var > file config > defaults. Graceful fallback on failure.

**Affected files:** `src/config.js`

### 2.5 -- Multi-Repo MCP ✅

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

## Phase 2.5 -- Analysis Expansion ✅

> **Status:** Complete -- shipped across v2.0.0 -> v2.6.0

**Goal:** Build a comprehensive analysis toolkit on top of the graph -- complexity metrics, community detection, risk triage, architecture boundary enforcement, CI validation, and hybrid search. This phase emerged organically as features were needed and wasn't in the original roadmap.

### 2.5.1 -- Complexity Metrics ✅

Per-function complexity analysis using language-specific AST rules.

- ✅ Cognitive complexity, cyclomatic complexity, max nesting depth for 8 languages
- ✅ Halstead metrics (vocabulary, volume, difficulty, effort, bugs)
- ✅ LOC, SLOC, comment lines per function
- ✅ Maintainability Index (MI) computation
- ✅ Native Rust engine support for all complexity metrics
- ✅ CLI: `codegraph complexity [target]` with `--sort`, `--limit`, `--kind` options
- ✅ `function_complexity` DB table for persistent storage

**New file:** `src/complexity.js` (2,163 lines)

### 2.5.2 -- Community Detection & Drift ✅

Louvain community detection at file or function level.

- ✅ Graphology-based Louvain algorithm for community assignment
- ✅ Modularity score computation
- ✅ Drift analysis: identify split/merge candidates between communities
- ✅ CLI: `codegraph communities` with `--level file|function`

**New file:** `src/communities.js` (310 lines)

### 2.5.3 -- Structure & Role Classification ✅

Directory structure graph with node role classification.

- ✅ Directory nodes and edges with cohesion, density, fan-in/fan-out metrics
- ✅ Node role classification: entry, core, utility, adapter, leaf, dead
- ✅ Framework entry point detection (route:, event:, command: prefixes)
- ✅ Hotspot detection: high fan-in x high complexity
- ✅ Module boundary analysis: high-cohesion directories with cross-boundary imports
- ✅ CLI: `codegraph structure`, `codegraph hotspots`, `codegraph roles`

**New file:** `src/structure.js` (668 lines)

### 2.5.4 -- Execution Flow Tracing ✅

Forward BFS from framework entry points through callees to leaves.

- ✅ Entry point enumeration with type classification
- ✅ Forward BFS trace with cycle detection
- ✅ CLI: `codegraph flow [name]` with `--list` and `--depth` options

**New file:** `src/flow.js` (362 lines)

### 2.5.5 -- Temporal Coupling (Co-change Analysis) ✅

Git history analysis for temporal file coupling.

- ✅ Jaccard similarity computation from commit history
- ✅ `co_changes`, `co_change_meta`, `file_commit_counts` DB tables
- ✅ Per-file and global co-change queries
- ✅ CLI: `codegraph co-change [file]`

**New file:** `src/cochange.js` (502 lines)

### 2.5.6 -- Manifesto Rule Engine ✅

Configurable rule engine with warn/fail thresholds for function, file, and graph rules.

- ✅ Function rules: cognitive, cyclomatic, nesting depth
- ✅ File rules: imports, exports, LOC, fan-in, fan-out
- ✅ Graph rules: cycles, boundary violations
- ✅ Configurable via `.codegraphrc.json` `manifesto` section
- ✅ CLI: `codegraph manifesto` with table format

**New file:** `src/manifesto.js` (511 lines)

### 2.5.7 -- Architecture Boundary Rules ✅

Architecture enforcement using glob patterns and presets.

- ✅ Presets: hexagonal, layered, clean, onion
- ✅ Custom boundary definitions with allow/deny rules
- ✅ Violation detection from DB edges
- ✅ Integration with manifesto and check commands

**New file:** `src/boundaries.js` (347 lines)

### 2.5.8 -- CI Validation Predicates (`check`) ✅

Structured pass/fail checks for CI pipelines.

- ✅ `checkNoNewCycles` -- cycle predicate
- ✅ `checkMaxBlastRadius` -- blast radius predicate
- ✅ `checkNoSignatureChanges` -- signature stability predicate
- ✅ `checkNoBoundaryViolations` -- architecture predicate
- ✅ Composable result objects with pass/fail semantics
- ✅ MCP tool: `check`
- ✅ CLI: `codegraph check [ref]` with exit code 0/1

**New file:** `src/check.js` (433 lines)

### 2.5.9 -- Composite Analysis Commands ✅

High-level commands that compose multiple analysis steps.

- ✅ **Audit:** explain + impact + health + manifesto breaches in one call
- ✅ **Batch:** run same query against multiple targets for multi-agent dispatch
- ✅ **Triage:** risk-ranked audit queue using normalized fan-in, complexity, churn, MI signals

**New files:** `src/audit.js` (424 lines), `src/batch.js` (91 lines), `src/triage.js` (274 lines)

### 2.5.10 -- Hybrid Search ✅

BM25 keyword search + semantic vector search with RRF fusion.

- ✅ FTS5 full-text index on node names and source previews
- ✅ BM25 keyword search via `ftsSearchData()`
- ✅ Hybrid search with configurable RRF fusion via `hybridSearchData()`
- ✅ Three search modes: `hybrid` (default), `semantic`, `keyword`
- ✅ 8 embedding model options (minilm, jina-small/base/code, nomic/v1.5, bge-large)

**Affected file:** `src/embedder.js` (grew from 525 -> 1,113 lines)

### 2.5.11 -- Supporting Infrastructure ✅

Cross-cutting utilities added during the expansion.

- ✅ **Pagination:** offset/limit with MCP defaults per command (`src/paginate.js`, 106 lines)
- ✅ **Snapshot:** SQLite DB backup/restore via VACUUM INTO (`src/snapshot.js`, 150 lines)
- ✅ **CODEOWNERS:** ownership integration for boundary analysis (`src/owners.js`, 360 lines)
- ✅ **Branch Compare:** structural diff between git refs (`src/branch-compare.js`, 569 lines)
- ✅ **Change Journal:** NDJSON event log for watch mode (`src/change-journal.js`, 131 lines)
- ✅ **Journal:** change journal validation/management (`src/journal.js`, 110 lines)
- ✅ **Update Check:** npm registry polling with 24h cache (`src/update-check.js`, 161 lines)

### 2.5.12 -- MCP Tool Expansion ✅

MCP grew from 12 -> 25 tools, covering all new analysis capabilities.

| New tool | Wraps |
|----------|-------|
| ✅ `structure` | `structureData` |
| ✅ `node_roles` | `rolesData` |
| ✅ `hotspots` | `hotspotsData` |
| ✅ `co_changes` | `coChangeData` |
| ✅ `execution_flow` | `flowData` |
| ✅ `list_entry_points` | `listEntryPointsData` |
| ✅ `complexity` | `complexityData` |
| ✅ `manifesto` | `manifestoData` |
| ✅ `communities` | `communitiesData` |
| ✅ `code_owners` | `ownersData` |
| ✅ `audit` | `auditData` |
| ✅ `batch_query` | `batchData` |
| ✅ `triage` | `triageData` |
| ✅ `branch_compare` | `branchCompareData` |
| ✅ `check` | `checkData` |

**Affected file:** `src/mcp.js` (grew from 354 -> 1,212 lines)

---

## Phase 2.7 -- Deep Analysis & Graph Enrichment ✅

> **Status:** Complete -- shipped as v3.0.0 across PRs #254-#285

**Goal:** Add deeper static analysis capabilities (dataflow, control flow graphs, AST querying), enrich the graph model with sub-declaration node types and structural edges, refactor extractors into per-language modules, consolidate the CLI surface area, and introduce interactive visualization. This phase emerged from competitive analysis against Joern and Narsil-MCP.

### 2.7.1 -- Dataflow Analysis ✅

Define-use chain extraction tracking how data flows between functions.

- ✅ Three edge types: `flows_to` (parameter flow), `returns` (call return assignment), `mutates` (parameter-derived mutations)
- ✅ Confidence scoring (1.0 param, 0.9 call return, 0.8 destructured)
- ✅ Scope-stack AST walk with function-level tracking
- ✅ Forward BFS impact analysis via return value consumers
- ✅ Path finding through dataflow edges
- ✅ Opt-in via `build --dataflow` (dynamic import, only loaded when flag passed)
- ✅ DB migration v10: `dataflow` table with source, target, kind, param_index, expression, confidence
- ✅ JS/TS/TSX only (MVP -- language-specific scope analysis)
- ✅ CLI: `codegraph dataflow <name>` with `--impact` mode for transitive data-dependent blast radius
- ✅ MCP tool: `dataflow` with `edges` and `impact` modes (path mode removed during CLI consolidation PR #263)

**New file:** `src/dataflow.js` (1,187 lines)

### 2.7.2 -- Expanded Node Types (Phase 1) ✅

Extend the graph model with sub-declaration node kinds.

- ✅ 3 new node kinds: `parameter`, `property`, `constant`
- ✅ Tiered constants: `CORE_SYMBOL_KINDS` (10), `EXTENDED_SYMBOL_KINDS` (3), `EVERY_SYMBOL_KIND` (13)
- ✅ Backward-compatible alias: `ALL_SYMBOL_KINDS = CORE_SYMBOL_KINDS`
- ✅ `parent_id` column on `nodes` table (DB migration v11) linking children to parent definitions
- ✅ All 9 WASM extractors updated to emit `children` arrays
- ✅ CLI: `codegraph children <name>`
- ✅ MCP tool: `symbol_children` with extended kind enum

**Affected files:** All extractors, `src/builder.js`, `src/queries.js`, `src/db.js`

### 2.7.3 -- Expanded Edge Types (Phase 2) ✅

Structural edges for richer graph relationships.

- ✅ 3 new edge kinds: `contains` (parent→child), `parameter_of` (param→function), `receiver` (method call receiver)
- ✅ Tiered constants: `CORE_EDGE_KINDS` (6), `STRUCTURAL_EDGE_KINDS` (3), `EVERY_EDGE_KIND` (9)
- ✅ Structural edges excluded from `moduleMapData()` coupling counts
- ✅ MCP tool enums updated to include new edge kinds

**Affected files:** `src/builder.js`, `src/queries.js`

### 2.7.4 -- Intraprocedural Control Flow Graph (CFG) ✅

Basic-block control flow graph construction from function ASTs.

- ✅ `makeCfgRules(overrides)` factory with per-language defaults and validation
- ✅ `CFG_RULES` Map covering all 9 languages (JS/TS, Python, Go, Rust, Java, C#, PHP, Ruby)
- ✅ Handles: if/else, for/while/do-while, switch, try/catch/finally, break/continue (with labels), return/throw
- ✅ Opt-in via `build --cfg` (dynamic import)
- ✅ DB migration v12: `cfg_blocks` and `cfg_edges` tables
- ✅ DOT and Mermaid export: `cfgToDOT()`, `cfgToMermaid()`
- ✅ CLI: `codegraph cfg <name>` with `--format text|dot|mermaid`
- ✅ MCP tool: `cfg`

**New file:** `src/cfg.js` (1,451 lines)

### 2.7.5 -- Stored Queryable AST Nodes ✅

Persist and query selected AST node types for pattern-based codebase exploration.

- ✅ 6 AST node kinds: `call`, `new`, `string`, `regex`, `throw`, `await`
- ✅ `AST_NODE_KINDS` constant
- ✅ Pattern matching via SQL GLOB with auto-wrapping for substring search
- ✅ Parent resolution via narrowest enclosing definition
- ✅ Always-on extraction during build (post-parse, before complexity to preserve `_tree`)
- ✅ DB migration v13: `ast_nodes` table with indexes on kind, name, file, parent
- ✅ CLI: `codegraph ast [pattern]` with `-k`, `-f`, `-T`, `-j`
- ✅ MCP tool: `ast_query`

**New file:** `src/ast.js` (392 lines)

### 2.7.6 -- Extractors Refactoring ✅

Split per-language extractors from monolithic `parser.js` into dedicated modules.

- ✅ New `src/extractors/` directory with 11 files (3,023 lines total)
- ✅ One file per language: `javascript.js` (892), `csharp.js` (311), `php.js` (322), `java.js` (290), `rust.js` (295), `ruby.js` (277), `go.js` (237), `python.js` (284), `hcl.js` (95)
- ✅ Shared utilities in `helpers.js` (`nodeEndLine()`, `findChild()`)
- ✅ Barrel export via `index.js`
- ✅ Consistent return schema: `{ definitions, calls, imports, classes, exports }`
- ✅ All extractors support extended node kinds (parameter, property, constant)
- ✅ `parser.js` reduced to thin WASM fallback with `LANGUAGE_REGISTRY` (404 lines)

**New directory:** `src/extractors/`

### 2.7.7 -- normalizeSymbol Utility ✅

Stable JSON schema for symbol output across all query functions.

- ✅ `normalizeSymbol(row, db, hashCache)` returns 7-field shape: `{ name, kind, file, line, endLine, role, fileHash }`
- ✅ File hash caching for efficient batch operations
- ✅ Adopted by dataflow, context, where, query, and other functions

**Affected file:** `src/queries.js`

### 2.7.8 -- Interactive Graph Viewer ✅

Self-contained HTML visualization with vis-network.

- ✅ File-level and function-level graph modes
- ✅ Layout switching (hierarchical, force, radial), physics toggle, search
- ✅ Color by kind/role/community/complexity (configurable)
- ✅ Size by uniform/fan-in/complexity
- ✅ Clustering by community or directory
- ✅ Drill-down with seed strategies (all, top-fanin, entry)
- ✅ Detail panel with metrics, callers, callees on node click
- ✅ Risk overlays (dead-code, high-blast-radius, low-MI)
- ✅ Configuration via `.plotDotCfg` / `.plotDotCfg.json` with deep merge defaults
- ✅ CLI: `codegraph plot` with `--functions`, `--config`, `--color-by`, `--size-by`, `--cluster-by`, `--overlay`

**New file:** `src/viewer.js` (948 lines)

### 2.7.9 -- Exports Command ✅

Per-symbol consumer analysis for file exports.

- ✅ `exportsData(file)` returns each exported symbol with its consumers (who calls it and from where)
- ✅ CLI: `codegraph exports <file>`
- ✅ MCP tool: `file_exports`
- ✅ Integrated into batch command system

**Affected file:** `src/queries.js`

### 2.7.10 -- Export Format Expansion ✅

Three new graph export formats for external tooling integration.

- ✅ GraphML (XML format for graph tools like yEd, Gephi)
- ✅ GraphSON (Gremlin/TinkerPop server format)
- ✅ Neo4j CSV (bulk loader format for Neo4j import)

**Affected file:** `src/export.js` (681 lines)

### 2.7.11 -- CLI Consolidation ✅

First CLI surface area reduction -- 5 commands merged into existing ones.

- ✅ `hotspots` → folded into `triage --level file|directory`
- ✅ `manifesto` → merged into `check` (no args = manifesto, `--rules` for both)
- ✅ `explain` → replaced by `audit --quick`
- ✅ `batch-query` → use `batch where` instead
- ✅ `query --path` → standalone `path <from> <to>` command (deprecation notice on old syntax)
- ✅ MCP tools unchanged for backward compatibility

**Affected file:** `src/cli.js`

### 2.7.12 -- MCP Tool Consolidation & Expansion ✅

MCP tools were both consolidated and expanded, resulting in a net change from 25 → 30 tools (31 in multi-repo mode).

**Added:**

| New tool | Wraps |
|----------|-------|
| ✅ `cfg` | `cfgData` |
| ✅ `ast_query` | `astQueryData` |
| ✅ `dataflow` | `dataflowData` (edges + impact modes) |
| ✅ `file_exports` | `exportsData` |
| ✅ `symbol_children` | `childrenData` |

**Removed (PR #263 consolidation):**

| Removed tool | Replacement |
|----------|-------|
| `fn_deps` | `query` with `deps` mode |
| `symbol_path` | `query` with `path` mode |
| `list_entry_points` | `execution_flow` with `list` mode |

Plus updated enums on existing tools (edge_kinds, symbol kinds).

**Affected file:** `src/mcp.js` (grew from 1,212 -> 1,370 lines)

### 2.7 Summary

| Metric | Before (v2.6.0) | After (v3.0.0) | Delta |
|--------|-----------------|-----------------|-------|
| Source modules | 35 | 50 | +15 |
| Total source lines | 17,830 | 26,277 | +47% |
| DB tables | 9 | 13 | +4 |
| DB migrations | v9 | v13 | +4 |
| MCP tools | 25 | 30 | +5 (net: +8 added, -3 consolidated) |
| CLI commands | 45 | 39 | -6 (net: +7 added, -5 consolidated, -8 merged) |
| Node kinds | 10 | 13 | +3 |
| Edge kinds | 6 | 9 | +3 |
| Test files | 59 | 70 | +11 |

---

## Phase 3 -- Architectural Refactoring 🔄

> **Status:** In Progress -- started in v3.1.1

**Goal:** Restructure the codebase for modularity, testability, and long-term maintainability. These are internal improvements -- no new user-facing features, but they make every subsequent phase easier to build and maintain.

> Reference: [generated/architecture.md](../../generated/architecture.md) -- full analysis with code examples and rationale.

**Architecture pattern: Vertical Slice Architecture.** Each CLI command is a natural vertical slice — thin command entry point → domain logic → data access → formatted output. This avoids the overhead of layered patterns (Hexagonal, Clean Architecture) that would create abstractions with only one implementation, while giving clear boundaries and independent testability per feature. The target end-state directory structure:

```
src/
  commands/              # Thin CLI entry points (one per command)
  domain/                # Core logic grouped by feature
    graph/               # builder, resolve, cycles, watcher
    analysis/            # symbol-lookup, impact, dependencies, module-map, context, exports, roles
    search/              # embedder, semantic search, hybrid
  ast-analysis/          # Unified visitor framework (already in place)
  db/                    # Repository, migrations, query-builder, connection
  extractors/            # Per-language tree-sitter extractors (already in place)
  mcp/                   # MCP server, tool registry, per-tool handlers
  presentation/          # Output formatting: viewer, export (DOT/Mermaid/JSON), result-formatter, table, sequence-renderer
  infrastructure/        # Config, logger, native loader, pagination, test-filter, errors
  shared/                # Constants, normalize, generators
```

Key principles:
- **Commands are thin** — parse args, call domain, format output. No business logic in CLI layer
- **Domain modules don't import presentation** — they return data, callers decide format
- **Shared kernel stays flat** — `db/`, `infrastructure/`, `shared/` are cross-cutting
- **No premature abstractions** — no interfaces/ports for single implementations

**Context:** Phases 2.5 and 2.7 added 38 modules and grew the codebase from 5K to 26,277 lines without introducing shared abstractions. The dual-function anti-pattern was replicated across 19 modules. Three independent AST analysis engines (complexity, CFG, dataflow) totaling 4,801 lines share the same fundamental pattern but no infrastructure. Raw SQL is scattered across 25+ modules touching 13 tables. The priority ordering has been revised based on actual growth patterns -- the new #1 priority is the unified AST analysis framework.

### 3.1 -- Unified AST Analysis Framework ★ Critical ✅

Unify the independent AST analysis engines (complexity, CFG, dataflow) plus AST node storage into a shared visitor framework. These four modules independently implement the same pattern: per-language rules map → AST walk → collect data → write to DB → query → format.

**Completed:** All 4 analyses (complexity, CFG, dataflow, AST-store) now run in a single DFS walk via `walkWithVisitors`. The CFG visitor rewrite ([#392](https://github.com/optave/codegraph/pull/392)) eliminated the Mode A/B split, replaced the 813-line `buildFunctionCFG` with a node-level visitor, and derives cyclomatic complexity directly from CFG structure (`E - N + 2`). `cfg.js` reduced from 1,242 → 518 lines.

```
src/
  ast-analysis/
    visitor.js                 # Shared DFS walker with pluggable visitor hooks
    engine.js                  # Orchestrates all analyses in one coordinated pass
    metrics.js                 # Halstead, MI, LOC/SLOC (extracted from complexity.js)
    visitor-utils.js           # Shared helpers (functionName, extractParams, etc.)
    visitors/
      complexity-visitor.js    # Cognitive/cyclomatic/nesting + Halstead
      cfg-visitor.js           # Basic-block + edge construction via DFS hooks
      ast-store-visitor.js     # new/throw/await/string/regex extraction
      dataflow-visitor.js      # Scope stack + define-use chains
    shared.js                  # findFunctionNode, rule factories, ext mapping
    rules/                     # Per-language rule files (unchanged)
```

- ✅ Shared DFS walker with `enterNode`/`exitNode`/`enterFunction`/`exitFunction` hooks, `skipChildren` per-visitor, nesting/scope tracking
- ✅ Complexity visitor (cognitive, cyclomatic, max nesting, Halstead) — file-level and function-level modes
- ✅ AST-store visitor (new/throw/await/string/regex extraction)
- ✅ Dataflow visitor (define-use chains, arg flows, mutations, scope stack)
- ✅ Engine orchestrator: unified pre-walk stores results as pre-computed data on `symbols`, then delegates to existing `buildXxx` for DB writes
- ✅ `builder.js` → single `runAnalyses` call replaces 4 sequential blocks + WASM pre-parse
- ✅ Extracted pure computations to `metrics.js` (Halstead derived math, LOC, MI)
- ✅ Extracted shared helpers to `visitor-utils.js` (from dataflow.js)
- ✅ CFG visitor rewrite — node-level DFS visitor replaces statement-level `buildFunctionCFG`, Mode A/B split eliminated ([#392](https://github.com/optave/codegraph/pull/392))
- ✅ Cyclomatic complexity derived from CFG (`E - N + 2`) — single source of truth for control flow metrics ([#392](https://github.com/optave/codegraph/pull/392))

**Affected files:** `src/complexity.js`, `src/cfg.js`, `src/dataflow.js`, `src/ast.js` → split into `src/ast-analysis/`

### 3.2 -- Command/Query Separation ★ Critical ✅

CLI display wrappers extracted from all 19 analysis modules into dedicated `src/commands/` files. Shared infrastructure (`result-formatter.js`, `test-filter.js`) moved to `src/infrastructure/`. `*Data()` functions remain in original modules — MCP dynamic imports unchanged. ~1,059 lines of CLI formatting code separated from analysis logic ([#373](https://github.com/optave/codegraph/pull/373), [#393](https://github.com/optave/codegraph/pull/393)).

```
src/
  commands/                    # One file per command (16 files)
    audit.js, batch.js, cfg.js, check.js, cochange.js, communities.js,
    complexity.js, dataflow.js, flow.js, branch-compare.js, manifesto.js,
    owners.js, sequence.js, structure.js, triage.js, query.js (barrel re-export)

  infrastructure/
    result-formatter.js         # Shared formatting: JSON, NDJSON dispatch
    test-filter.js              # Shared --no-tests / isTestFile logic
```

- ✅ `queries.js` CLI wrappers → `queries-cli.js` (15 functions)
- ✅ Shared `result-formatter.js` (`outputResult` for JSON/NDJSON dispatch)
- ✅ Shared `test-filter.js` (`isTestFile` predicate)
- ✅ CLI wrappers extracted from remaining 15 modules into `src/commands/` ([#393](https://github.com/optave/codegraph/pull/393))
- ✅ Per-command `src/commands/` directory structure ([#393](https://github.com/optave/codegraph/pull/393))
- ✅ `src/infrastructure/` directory for shared utilities ([#393](https://github.com/optave/codegraph/pull/393))
- ⏭️ `CommandRunner` shared lifecycle — deferred (command files vary too much for a single pattern today)

**Affected files:** All 19 modules with dual-function pattern, `src/cli.js`, `src/mcp.js`

### 3.3 -- Repository Pattern for Data Access ★ Critical ✅

> **v3.1.1 progress:** `src/db/` directory created with `repository.js` (134 lines), `query-builder.js` (280 lines), and `migrations.js` (312 lines). All db usage across the codebase wrapped in try/finally for reliable `db.close()` ([#371](https://github.com/optave/codegraph/pull/371), [#384](https://github.com/optave/codegraph/pull/384), [#383](https://github.com/optave/codegraph/pull/383)).
>
> **v3.1.2 progress:** `repository.js` split into `src/db/repository/` directory with 10 domain files (nodes, edges, build-stmts, complexity, cfg, dataflow, cochange, embeddings, graph-read, barrel). Raw SQL migrated from 14 src/ modules into repository layer. `connection.js` already complete (89 lines handling open/close/WAL/pragma/locks/readonly).

- ✅ `src/db/` directory structure created
- ✅ `repository/` — domain-split repository (nodes, edges, build-stmts, complexity, cfg, dataflow, cochange, embeddings, graph-read)
- ✅ `query-builder.js` — lightweight SQL builder (280 lines)
- ✅ `migrations.js` — schema migrations extracted (312 lines)
- ✅ `connection.js` — connection setup (open, WAL mode, pragma tuning, readonly, locks)
- ✅ All db usage wrapped in try/finally for reliable `db.close()`
- ✅ Migrate remaining raw SQL from 14 modules into Repository

```
src/
  db/
    connection.js              # Open, WAL mode, pragma tuning
    migrations.js              # Schema versions (currently 13 migrations)
    query-builder.js           # Lightweight SQL builder for common filtered queries
    repository/
      index.js                 # Barrel re-export
      nodes.js                 # Node lookups: getNodeId, findFileNodes, bulkNodeIdsByFile, etc.
      edges.js                 # Edge queries: findCallees, findCallers, import/hierarchy edges
      build-stmts.js           # Cascade purge: purgeFileData, purgeFilesData
      complexity.js            # function_complexity table reads
      cfg.js                   # cfg_blocks/cfg_edges reads + deletes
      dataflow.js              # dataflow table checks
      cochange.js              # co_changes/co_change_meta reads
      embeddings.js            # embeddings/embedding_meta reads
      graph-read.js            # Cross-table reads for export/communities
```

**Affected files:** `src/db.js` barrel updated, raw SQL extracted from `queries.js`, `builder.js`, `watcher.js`, `structure.js`, `complexity.js`, `cfg.js`, `dataflow.js`, `ast.js`, `ast-analysis/engine.js`, `embedder.js`, `sequence.js`, `communities.js`

### 3.4 -- Decompose queries.js (3,395 Lines) 🔄

> **v3.1.1 progress:** `queries.js` reduced from 3,395 → 2,490 lines by extracting all CLI formatting to `queries-cli.js` (3.2). Symbol kind constants extracted to `kinds.js` (49 lines) ([#378](https://github.com/optave/codegraph/pull/378)).

- ✅ CLI formatting separated → `queries-cli.js` (via 3.2)
- ✅ `kinds.js` — symbol kind constants extracted
- 🔲 Split remaining `queries.js` data functions into `src/analysis/` modules
- 🔲 Extract `shared/normalize.js`, `shared/generators.js`

Split into pure analysis modules that return data and share no formatting concerns.

```
src/
  analysis/
    symbol-lookup.js           # queryNameData, whereData, listFunctionsData, childrenData
    impact.js                  # impactAnalysisData, fnImpactData, diffImpactData
    dependencies.js            # fileDepsData, fnDepsData, pathData
    module-map.js              # moduleMapData, statsData
    context.js                 # contextData, explainData
    exports.js                 # exportsData
    roles.js                   # rolesData

  shared/
    constants.js               # CORE_SYMBOL_KINDS, EXTENDED_SYMBOL_KINDS, EVERY_SYMBOL_KIND,
                               # CORE_EDGE_KINDS, STRUCTURAL_EDGE_KINDS, EVERY_EDGE_KIND,
                               # VALID_ROLES, FALSE_POSITIVE_NAMES, AST_NODE_KINDS
    normalize.js               # normalizeSymbol, isTestFile, kindIcon
    generators.js              # iterListFunctions, iterRoles, iterWhere
```

> **Note:** Phase 2.7 introduced tiered constants (`CORE_`/`EXTENDED_`/`EVERY_`) and `normalizeSymbol()` — the right abstractions, just in the wrong file. Moving them to `shared/` is the first step.

**Affected files:** `src/queries.js` -> split into `src/analysis/` + `src/shared/`

### 3.5 -- Composable MCP Tool Registry

Replace the monolithic 1,370-line `mcp.js` (30 tools in one switch dispatch) with self-contained tool modules.

```
src/
  mcp/
    server.js                  # MCP server setup, transport, lifecycle
    tool-registry.js           # Auto-discovery + dynamic registration
    middleware.js              # Pagination, error handling, repo resolution
    tools/
      query-function.js        # { schema, handler } -- one per tool (30 files)
      ...
```

Adding a new MCP tool = adding a file. No other files change.

**Affected files:** `src/mcp.js` -> split into `src/mcp/`

### 3.6 -- CLI Command Objects

Move from 1,557 lines of inline Commander chains to self-contained command modules.

> **Note:** Phase 2.7.11 consolidated 5 commands — the first CLI surface area reduction. This item continues that direction by making each of the 39 remaining commands independently testable.

```
src/
  cli/
    index.js                   # Commander setup, auto-discover commands
    shared/
      output.js                # --json, --ndjson, table, plain text
      options.js               # Shared options (--no-tests, --json, --db, etc.)
    commands/                  # 39 files, one per command
      build.js                 # { name, description, options, validate, execute }
      ...
```

Each command is independently testable by calling `execute()` directly.

**Affected files:** `src/cli.js` -> split into `src/cli/`

### 3.7 -- Curated Public API Surface

Reduce `index.js` from 140+ exports to ~35 curated exports. Use `package.json` `exports` field to enforce module boundaries.

```json
{ "exports": { ".": "./src/index.js", "./cli": "./src/cli.js" } }
```

Export only `*Data()` functions (the command execute functions). Never export CLI formatters. Group by domain.

**Affected files:** `src/index.js`, `package.json`

> **Removed: Decompose complexity.js** — Subsumed by 3.1. The standalone complexity decomposition from the previous revision is now part of the unified AST analysis framework (3.1). The `complexity.js` per-language rules become `ast-analysis/rules/complexity/{lang}.js` alongside CFG and dataflow rules.

### 3.8 -- Domain Error Hierarchy

Replace ad-hoc error handling (mix of thrown `Error`, returned `null`, `logger.warn()`, `process.exit(1)`) across 50 modules with structured domain errors.

```js
class CodegraphError extends Error { constructor(message, { code, file, cause }) { ... } }
class ParseError extends CodegraphError { code = 'PARSE_FAILED' }
class DbError extends CodegraphError { code = 'DB_ERROR' }
class ConfigError extends CodegraphError { code = 'CONFIG_INVALID' }
class ResolutionError extends CodegraphError { code = 'RESOLUTION_FAILED' }
class EngineError extends CodegraphError { code = 'ENGINE_UNAVAILABLE' }
class AnalysisError extends CodegraphError { code = 'ANALYSIS_FAILED' }
class BoundaryError extends CodegraphError { code = 'BOUNDARY_VIOLATION' }
```

The CLI catches domain errors and formats for humans. MCP returns structured error responses. No more `process.exit()` from library code.

**New file:** `src/errors.js`

### 3.9 -- Builder Pipeline Architecture

Refactor `buildGraph()` (1,355 lines) from a mega-function into explicit, independently testable pipeline stages. Phase 2.7 added 4 opt-in stages, bringing the total to 11 core + 4 optional.

```js
const pipeline = [
  // Core (always)
  collectFiles,        // (rootDir, config) => filePaths[]
  detectChanges,       // (filePaths, db) => { changed, removed, isFullBuild }
  parseFiles,          // (filePaths, engineOpts) => Map<file, symbols>
  insertNodes,         // (symbolMap, db) => nodeIndex
  resolveImports,      // (symbolMap, rootDir, aliases) => importEdges[]
  buildCallEdges,      // (symbolMap, nodeIndex) => callEdges[]
  buildClassEdges,     // (symbolMap, nodeIndex) => classEdges[]
  resolveBarrels,      // (edges, symbolMap) => resolvedEdges[]
  insertEdges,         // (allEdges, db) => stats
  extractASTNodes,     // (fileSymbols, db) => astStats (always, post-parse)
  buildStructure,      // (db, fileSymbols, rootDir) => structureStats
  classifyRoles,       // (db) => roleStats
  emitChangeJournal,   // (rootDir, changes) => void

  // Opt-in (dynamic imports)
  computeComplexity,   // --complexity: (db, rootDir, engine) => complexityStats
  buildDataflowEdges,  // --dataflow:   (db, fileSymbols, rootDir) => dataflowStats
  buildCFGData,        // --cfg:        (db, fileSymbols, rootDir) => cfgStats
]
```

Watch mode reuses the same stages triggered per-file, eliminating the `watcher.js` divergence.

**Affected files:** `src/builder.js`, `src/watcher.js`

### 3.10 -- Embedder Subsystem Extraction

Restructure `embedder.js` (1,113 lines) -- which now contains 3 search engines -- into a standalone subsystem.

```
src/
  embeddings/
    index.js                   # Public API
    models.js                  # 8 model definitions, batch sizes, loading
    generator.js               # Source -> text preparation -> batch embedding
    stores/
      sqlite-blob.js           # Current O(n) cosine similarity
      fts5.js                  # BM25 keyword search
    search/
      semantic.js              # Vector similarity
      keyword.js               # FTS5 BM25
      hybrid.js                # RRF fusion
    strategies/
      structured.js            # Structured text preparation
      source.js                # Raw source preparation
```

The pluggable store interface enables future O(log n) ANN search (e.g., `hnswlib-node`) when symbol counts reach 50K+.

**Affected files:** `src/embedder.js` -> split into `src/embeddings/`

### 3.11 -- Unified Graph Model

Unify the four parallel graph representations (structure.js, cochange.js, communities.js, viewer.js) into a shared in-memory graph model.

```
src/
  graph/
    model.js                   # Shared in-memory graph (nodes + edges + metadata)
    builders/
      dependency.js            # Build from SQLite edges
      structure.js             # Build from file/directory hierarchy
      temporal.js              # Build from git history (co-changes)
    algorithms/
      bfs.js                   # Breadth-first traversal
      shortest-path.js         # Path finding
      tarjan.js                # Cycle detection
      louvain.js               # Community detection
      centrality.js            # Fan-in/fan-out, betweenness
      clustering.js            # Cohesion, coupling, density
    classifiers/
      roles.js                 # Node role classification
      risk.js                  # Risk scoring
```

Algorithms become composable -- run community detection on the dependency graph, the temporal graph, or a merged graph.

**Affected files:** `src/structure.js`, `src/cochange.js`, `src/communities.js`, `src/cycles.js`, `src/triage.js`, `src/viewer.js`

### 3.12 -- Qualified Names & Hierarchical Scoping (Partially Addressed)

> **Phase 2.7 progress:** `parent_id` column, `contains` edges, `parameter_of` edges, and `childrenData()` query now model one-level parent-child relationships. This addresses ~80% of the use case.

Remaining work -- enrich the node model with deeper scope information:

```sql
ALTER TABLE nodes ADD COLUMN qualified_name TEXT;  -- 'DateHelper.format'
ALTER TABLE nodes ADD COLUMN scope TEXT;            -- 'DateHelper'
ALTER TABLE nodes ADD COLUMN visibility TEXT;       -- 'public' | 'private' | 'protected'
```

Enables queries like "all methods of class X" without traversing edges. The `parent_id` FK only goes one level -- deeply nested scopes (namespace > class > method > closure) aren't fully represented. `qualified_name` would allow direct lookup.

**Affected files:** `src/db.js`, `src/extractors/`, `src/queries.js`, `src/builder.js`

### 3.13 -- Testing Pyramid with InMemoryRepository

The repository pattern (3.3) enables true unit testing:

- Pure unit tests for graph algorithms (pass adjacency list, assert result)
- Pure unit tests for risk/confidence scoring (pass parameters, assert score)
- `InMemoryRepository` for query tests (no SQLite, instant setup)
- Existing 70 test files continue as integration tests

**Current gap:** Many "unit" tests still hit SQLite because there's no repository abstraction.

### 3.14 -- Presentation Layer Extraction

Separate all output formatting from domain logic into a dedicated `src/presentation/` directory. Currently `viewer.js` (948 lines) and `export.js` (681 lines) mix graph traversal with rendering. `result-formatter.js` already exists in `infrastructure/` as a first step.

```
src/
  presentation/
    viewer.js              # Interactive terminal viewer (tree rendering, color, layout)
    export.js              # DOT, Mermaid, JSON, SVG graph serialization
    table.js               # Tabular CLI output (used by complexity, stats, etc.)
    sequence-renderer.js   # Mermaid sequence diagram formatting (from sequence.js)
    result-formatter.js    # Structured result formatting (moved from infrastructure/)
```

- 🔲 Extract rendering logic from `viewer.js` — keep graph data loading in domain, move formatting to presentation
- 🔲 Extract serialization from `export.js` — DOT/Mermaid/JSON writers become pure data → string transforms
- 🔲 Extract table formatting helpers used across `queries-cli.js`, `complexity`, `stats`
- 🔲 Move `result-formatter.js` from `infrastructure/` to `presentation/` (it's output formatting, not infrastructure)
- 🔲 Extract Mermaid rendering from `sequence.js` into `sequence-renderer.js`

**Principle:** Domain functions return plain data objects. Presentation functions are pure transforms: `data → formatted string`. Commands wire the two together.

**Affected files:** `src/viewer.js`, `src/export.js`, `src/sequence.js`, `src/infrastructure/result-formatter.js`

### 3.15 -- Domain Directory Grouping

Once 3.2-3.4 are complete and analysis modules are standalone, group them under `src/domain/` by feature area. This is a move-only refactor — no logic changes, just directory organization to match the vertical slice target structure.

```
src/domain/
  graph/                 # builder.js, resolve.js, cycles.js, watcher.js
  analysis/              # symbol-lookup.js, impact.js, dependencies.js, module-map.js,
                         # context.js, exports.js, roles.js (from 3.4 decomposition)
  search/                # embedder.js subsystem (from 3.10)
```

- 🔲 Move builder pipeline modules to `domain/graph/`
- 🔲 Move decomposed query modules (from 3.4) to `domain/analysis/`
- 🔲 Move embedder subsystem (from 3.10) to `domain/search/`
- 🔲 Update all import paths across codebase
- 🔲 Update `package.json` exports map (from 3.7)

**Prerequisite:** 3.2, 3.4, 3.9, 3.10 should be complete before this step — it organizes the results of those decompositions.

### 3.16 -- Remaining Items (Lower Priority)

These items from the original Phase 3 are still valid but less urgent:

- **Event-driven pipeline:** Add event/streaming architecture for progress reporting, cancellation, and large-repo support.
- **Unified engine interface (Strategy):** Replace scattered `engine.name === 'native'` branching. Less critical now that native is the primary path.
- **Subgraph export filtering:** `codegraph export --focus src/builder.js --depth 2` for usable visualizations.
- **Transitive import-aware confidence:** Walk import graph before falling back to proximity heuristics.
- **Query result caching:** LRU/TTL cache between analysis layer and repository. More valuable now with 34 MCP tools.
- **Configuration profiles:** `--profile backend` for monorepos with multiple services.
- **Pagination standardization:** SQL-level LIMIT/OFFSET in repository + command runner shaping.

---

## Phase 4 -- TypeScript Migration

**Goal:** Migrate the codebase from plain JavaScript to TypeScript, leveraging the clean module boundaries established in Phase 3. Incremental module-by-module migration starting from leaf modules inward.

**Why after Phase 3:** The architectural refactoring creates small, well-bounded modules with explicit interfaces (Repository, Engine, BaseExtractor, Pipeline stages, Command objects). These are natural type boundaries -- typing monolithic 2,000-line files that are about to be split would be double work.

### 4.1 -- Project Setup

- Add `typescript` as a devDependency
- Create `tsconfig.json` with strict mode, ES module output, path aliases matching the Phase 3 module structure
- Update Biome config to lint `.ts` files
- Configure build step: `tsc` emits to `dist/`, `package.json` `exports` point to compiled output
- Add `tsc --noEmit` to CI as a type-checking gate
- Enable incremental compilation for fast rebuilds

**Affected files:** `package.json`, `biome.json`, new `tsconfig.json`

### 4.2 -- Core Type Definitions

Define TypeScript interfaces for all abstractions introduced in Phase 3:

```ts
// Types for the core domain model
interface SymbolNode { id: number; name: string; qualifiedName?: string; kind: SymbolKind; file: string; line: number; endLine: number; parentId?: number; }
interface Edge { source: number; target: number; kind: EdgeKind; confidence: number; }
type CoreSymbolKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'struct' | 'enum' | 'trait' | 'record' | 'module'
type ExtendedSymbolKind = 'parameter' | 'property' | 'constant'
type SymbolKind = CoreSymbolKind | ExtendedSymbolKind
type CoreEdgeKind = 'imports' | 'imports-type' | 'reexports' | 'calls' | 'extends' | 'implements'
type StructuralEdgeKind = 'contains' | 'parameter_of' | 'receiver'
type EdgeKind = CoreEdgeKind | StructuralEdgeKind
type ASTNodeKind = 'call' | 'new' | 'string' | 'regex' | 'throw' | 'await'

// Interfaces for Phase 3 abstractions
interface Repository { insertNode(node: SymbolNode): void; findNodesByName(name: string, opts?: QueryOpts): SymbolNode[]; }
interface Engine { parseFile(path: string, source: string): ParseResult; resolveImports(batch: ImportBatch): ResolvedImport[]; }
interface ASTVisitor { name: string; visit(node: TreeSitterNode, context: VisitorContext): void; } // Phase 3.1
interface Extractor { language: string; handlers: Record<string, NodeHandler>; }
interface Command { name: string; options: OptionDef[]; validate(args: unknown, opts: unknown): void; execute(args: unknown, opts: unknown): Promise<void>; }
```

These interfaces serve as the migration contract -- each module is migrated to satisfy its interface.

**New file:** `src/types.ts`

### 4.3 -- Leaf Module Migration

Migrate modules with no internal dependencies first:

| Module | Notes |
|--------|-------|
| `src/errors.ts` | Domain error hierarchy (Phase 3.7) |
| `src/logger.ts` | Minimal, no internal deps |
| `src/constants.ts` | Pure data |
| `src/config.ts` | Config types derived from `.codegraphrc.json` schema |
| `src/db/connection.ts` | SQLite connection wrapper |
| `src/db/migrations.ts` | Schema version management |
| `src/formatters/*.ts` | Pure input->string transforms |
| `src/paginate.ts` | Generic pagination helpers |

Allow `.js` and `.ts` to coexist during migration (`allowJs: true` in tsconfig).

### 4.4 -- Core Module Migration

Migrate modules that implement Phase 3 interfaces:

| Module | Key types |
|--------|-----------|
| `src/db/repository.ts` | `Repository` interface, all prepared statements typed |
| `src/parser/engine.ts` | `Engine` interface, native/WASM dispatch |
| `src/parser/registry.ts` | `LanguageEntry` type, extension mapping |
| `src/parser/tree-utils.ts` | Tree-sitter node helpers |
| `src/parser/base-extractor.ts` | `Extractor` interface, handler map |
| `src/parser/extractors/*.ts` | Per-language extractors |
| `src/analysis/*.ts` | Typed analysis results (impact scores, call chains) |
| `src/resolve.ts` | Import resolution with confidence types |

### 4.5 -- Orchestration & Public API Migration

Migrate top-level orchestration and entry points:

| Module | Notes |
|--------|-------|
| `src/builder.ts` | Pipeline stages with typed `PipelineStage` |
| `src/watcher.ts` | File system events + pipeline |
| `src/embeddings/*.ts` | Vector store interface, model registry |
| `src/mcp/*.ts` | Tool schemas, typed handlers |
| `src/cli/*.ts` | Command objects with typed options |
| `src/index.ts` | Curated public API with proper export types |

### 4.6 -- Test Migration

- Migrate test files from `.js` to `.ts`
- Add type-safe test utilities and fixture builders
- Verify vitest TypeScript integration with path aliases
- Maintain `InMemoryRepository` (from Phase 3.2) as a typed test double

**Verification:** All existing tests pass. `tsc --noEmit` succeeds with zero errors. No `any` escape hatches except at FFI boundaries (napi-rs addon, tree-sitter WASM).

**Affected files:** All `src/**/*.js` -> `src/**/*.ts`, all `tests/**/*.js` -> `tests/**/*.ts`, `package.json`, `biome.json`

---

## Phase 5 -- Intelligent Embeddings

**Goal:** Dramatically improve semantic search quality by embedding natural-language descriptions instead of raw code.

> **Phase 5.3 (Hybrid Search) was completed early** during Phase 2.5 -- FTS5 BM25 + semantic search with RRF fusion is already shipped in v2.6.0.

### 5.1 -- LLM Description Generator

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

### 5.2 -- Enhanced Embedding Pipeline

- When descriptions exist, embed the description text instead of raw code
- Keep raw code as fallback when no description is available
- Add `--use-descriptions` flag to `codegraph embed` (default: true when descriptions exist)
- Store embedding source type in `embedding_meta` (code vs description)

**Expected improvement:** ~12% better semantic similarity for natural-language queries.

**Affected files:** `src/embedder.js`

### ~~5.3 -- Hybrid Search~~ ✅ Completed in Phase 2.5

Shipped in v2.6.0. FTS5 BM25 keyword search + semantic vector search with RRF fusion. Three search modes: `hybrid` (default), `semantic`, `keyword`.

### 5.4 -- Build-time Semantic Metadata

Enrich nodes with LLM-generated metadata beyond descriptions. Computed incrementally at build time (only for changed nodes), stored as columns on the `nodes` table.

| Column | Content | Example |
|--------|---------|---------|
| `side_effects` | Mutation/IO tags | `"writes DB"`, `"sends email"`, `"mutates state"` |
| `complexity_notes` | Responsibility count, cohesion rating | `"3 responsibilities, low cohesion -- consider splitting"` |
| `risk_score` | Fragility metric from graph centrality + LLM assessment | `0.82` (high fan-in + complex logic) |

- MCP tool: `assess <name>` -- returns complexity rating + specific concerns
- Cascade invalidation: when a node changes, mark dependents for re-enrichment

**Depends on:** 5.1 (LLM provider abstraction)

### 5.5 -- Module Summaries

Aggregate function descriptions + dependency direction into file-level narratives.

- `module_summaries` table -- one entry per file, re-rolled when any contained node changes
- MCP tool: `explain_module <file>` -- returns module purpose, key exports, role in the system
- `naming_conventions` metadata per module -- detected patterns (camelCase, snake_case, verb-first), flag outliers

**Depends on:** 5.1 (function-level descriptions must exist first)

> **Full spec:** See [llm-integration.md](./llm-integration.md) for detailed architecture, infrastructure table, and prompt design.

---

## Phase 6 -- Natural Language Queries

**Goal:** Allow developers to ask questions about their codebase in plain English.

### 6.1 -- Query Engine

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

**Requires:** LLM API key configured (no fallback -- this is inherently an LLM feature).

**New file:** `src/nlquery.js`

### 6.2 -- Conversational Sessions

Multi-turn conversations with session memory.

```bash
codegraph ask "How does auth work?" --session my-session
codegraph ask "What about the token refresh?" --session my-session
codegraph sessions list
codegraph sessions clear
```

- Store conversation history in SQLite table `sessions`
- Include prior Q&A pairs in subsequent prompts

### 6.3 -- MCP Integration

New MCP tool: `ask_codebase` -- natural language query via MCP.

Enables AI coding agents (Claude Code, Cursor, etc.) to ask codegraph questions about the codebase.

**Affected files:** `src/mcp.js`

### 6.4 -- LLM-Narrated Graph Queries

Graph traversal + LLM narration for questions that require both structural data and natural-language explanation. Each query walks the graph first, then sends the structural result to the LLM for narration.

| Query | Graph operation | LLM adds |
|-------|----------------|----------|
| `trace_flow <entry>` | BFS from entry point to leaves | Sequential narrative: "1. handler validates -> 2. calls createOrder -> 3. writes DB" |
| `trace_upstream <name>` | Recursive caller walk | Ranked suspects: "most likely cause is X because it modifies the same state" |
| `effect_analysis <name>` | Full callee tree walk, aggregate `side_effects` | "Calling X will: write to DB (via Y), send email (via Z)" |
| `dependency_path <A> <B>` | Shortest path(s) between two symbols | Narrates each hop: "A imports X from B because A needs to validate tokens" |

Pre-computed `flow_narratives` table caches results for key entry points at build time, invalidated when any node in the chain changes.

**Depends on:** 5.4 (`side_effects` metadata), 5.1 (descriptions for narration context)

### 6.5 -- Onboarding & Navigation Tools

Help new contributors and AI agents orient in an unfamiliar codebase.

- `entry_points` query -- graph finds roots (high fan-out, low fan-in) + LLM ranks by importance
- `onboarding_guide` command -- generates a reading order based on dependency layers
- MCP tool: `get_started` -- returns ordered list: "start here, then read this, then this"
- `change_plan <description>` -- LLM reads description, graph identifies relevant modules, returns touch points and test coverage gaps

**Depends on:** 5.5 (module summaries for context), 6.1 (query engine)

---

## Phase 7 -- Expanded Language Support

**Goal:** Go from 11 -> 19 supported languages.

### 7.1 -- Batch 1: High Demand

| Language | Extensions | Grammar | Effort |
|----------|-----------|---------|--------|
| C | `.c`, `.h` | `tree-sitter-c` | Low |
| C++ | `.cpp`, `.hpp`, `.cc`, `.cxx` | `tree-sitter-cpp` | Medium |
| Kotlin | `.kt`, `.kts` | `tree-sitter-kotlin` | Low |
| Swift | `.swift` | `tree-sitter-swift` | Medium |

### 7.2 -- Batch 2: Growing Ecosystems

| Language | Extensions | Grammar | Effort |
|----------|-----------|---------|--------|
| Scala | `.scala`, `.sc` | `tree-sitter-scala` | Medium |
| Dart | `.dart` | `tree-sitter-dart` | Low |
| Lua | `.lua` | `tree-sitter-lua` | Low |
| Zig | `.zig` | `tree-sitter-zig` | Low |

### 7.3 -- Parser Abstraction Layer

Extract shared patterns from existing extractors into reusable helpers.

| Helper | Purpose |
|--------|---------|
| `findParentNode(node, typeNames)` | Walk parent chain to find enclosing class/struct |
| `extractBodyMethods(bodyNode, parentName)` | Extract method definitions from a body block |
| `normalizeImportPath(importText)` | Cross-language import path normalization |

**Result:** Reduces boilerplate for each new language from ~200 lines to ~80 lines.

**New file:** `src/parser-utils.js`

---

## Phase 8 -- GitHub Integration & CI

**Goal:** Bring codegraph's analysis into pull request workflows.

> **Note:** Phase 2.5 delivered `codegraph check` (CI validation predicates with exit code 0/1), which provides the foundation for GitHub Action integration. The boundary violation, blast radius, and cycle detection predicates are already available.

### 8.1 -- Reusable GitHub Action

A reusable GitHub Action that runs on PRs:

1. `codegraph build` on the repository
2. `codegraph diff-impact` against the PR's base branch
3. `codegraph check --staged` to run CI predicates (cycles, blast radius, signatures, boundaries)
4. Posts a PR comment summarizing:
   - Number of affected functions and files
   - New cycles introduced (if any)
   - Boundary violations
   - Top impacted functions with caller counts

**Configuration via `.codegraphrc.json`:**

```json
{ "ci": { "failOnCycles": true, "impactThreshold": 50 } }
```

**Fail conditions:** Configurable -- fail if new cycles or impact exceeds threshold.

**New file:** `.github/actions/codegraph-ci/action.yml`

### 8.2 -- PR Review Integration

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
- **Review focus ranking**: rank affected files by risk x blast radius -- "review this file first"
- **Critical path highlighting**: shortest path from a changed function to a high-fan-in entry point
- **Test coverage gaps**: cross-reference affected code with test file graph edges

**New file:** `src/github.js`

### 8.3 -- Visual Impact Graphs for PRs

Extend the existing `diff-impact --format mermaid` foundation with CI automation and LLM annotations.

**CI automation** (GitHub Action):
1. `codegraph build .` (incremental, fast on CI cache)
2. `codegraph diff-impact $BASE_REF --format mermaid -T` to generate the graph
3. Post as PR comment -- GitHub renders Mermaid natively in markdown
4. Update on new pushes (edit the existing comment)

**LLM-enriched annotations** (when provider configured):
- For each changed function: one-line summary of WHAT changed (from diff hunks)
- For each affected caller: WHY it's affected -- what behavior might change downstream
- Node colors shift from green -> yellow -> red based on risk labels
- Overall PR risk score (aggregate of node risks weighted by centrality)

**Historical context overlay:**
- Annotate nodes with churn data: "this function changed 12 times in the last 30 days"
- Highlight fragile nodes: high churn + high fan-in = high breakage risk
- Track blast radius trends: "this PR's blast radius is 2x larger than your average"

**Depends on:** 8.1 (GitHub Action), 5.4 (`risk_score`, `side_effects`)

### 8.4 -- SARIF Output

Add SARIF output format for cycle detection. SARIF integrates with GitHub Code Scanning, showing issues inline in the PR.

**Affected files:** `src/export.js`

---

## Phase 9 -- Interactive Visualization & Advanced Features

### 9.1 -- Interactive Web Visualization (Partially Complete)

> **Phase 2.7 progress:** `codegraph plot` (Phase 2.7.8) ships a self-contained HTML viewer with vis-network. It supports layout switching, color/size/cluster overlays, drill-down, community detection, and a detail panel. The remaining work is the server-based experience below.

```bash
codegraph viz
```

Opens a local web UI at `localhost:3000` extending the static HTML viewer with:

- Server-side filtering for large graphs (the current `plot` command embeds all data as JSON, scaling poorly past ~1K nodes)
- Lazy edge loading and progressive disclosure
- Code preview on hover (reads from source files via local server)
- Filter panel: toggle node kinds, confidence thresholds, test files
- Edge styling by type (imports=solid, calls=dashed, extends=bold)
- Persistent view state (zoom, pan, expanded nodes saved across sessions)

**Data source:** Serve from DB via lightweight HTTP server, lazy-load on interaction.

**New file:** `src/visualizer.js`

### 9.2 -- Dead Code Detection

```bash
codegraph dead
codegraph dead --exclude-exports --exclude-tests
```

Find functions/methods/classes with zero incoming edges (never called). Filters for exports, test files, and entry points.

> **Note:** Phase 2.5 added role classification (`dead` role in structure.js) and Phase 2.7 added AST node storage (`ast_query` can find unreferenced exports). This extends those foundations with a dedicated command, smarter filtering, and cross-reference with `exports` command data.

**Affected files:** `src/queries.js`

### 9.3 -- Cross-Repository Support (Monorepo)

Support multi-package monorepos with cross-package edges.

- Detect workspace root (`package.json` workspaces, `pnpm-workspace.yaml`, `lerna.json`)
- Resolve internal package imports (e.g., `@myorg/utils`) to actual source files
- Add `package` column to nodes table
- `codegraph build --workspace` to scan all packages
- Impact analysis across package boundaries

### 9.4 -- Agentic Search

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

**Use case:** "Find everything related to payment processing" -> finds payment functions -> follows to validation -> follows to database layer -> returns complete picture.

**Requires:** LLM for relevance re-ranking (optional -- degrades to BFS without LLM).

**New file:** `src/agentic-search.js`

### 9.5 -- Refactoring Analysis

LLM-powered structural analysis that identifies refactoring opportunities. The graph provides the structural data; the LLM interprets it.

| Command | Graph operation | LLM adds |
|---------|----------------|----------|
| `split_analysis <file>` | Cluster tightly-coupled functions within a file | Proposed split, cross-boundary edges, circular import risk |
| `extraction_candidates` | Find high fan-in, low internal coupling functions | Rank by utility: "pure helper" vs "has side effects, risky to move" |
| `signature_impact <name>` | All call sites from graph edges | Suggested new signature, adapter pattern if needed, call sites to update |
| `lint-names` | Detect naming patterns per module | Flag outliers against detected conventions (camelCase, snake_case, verb-first) |
| `hotspots` | High fan-in + high fan-out + on many paths | Ranked fragility report with explanations, `risk_score` per node |
| `boundary_analysis` | Graph clustering (tightly-coupled groups spanning modules) | Reorganization suggestions: "these 4 functions in 3 files all deal with auth" |

> **Note:** `hotspots` and `boundary_analysis` already have data foundations from Phase 2.5 (structure.js hotspots, boundaries.js evaluation). This phase adds LLM interpretation on top.

**Depends on:** 5.4 (`risk_score`, `complexity_notes`), 5.5 (module summaries)

### 9.6 -- Auto-generated Docstrings

```bash
codegraph annotate
codegraph annotate --changed-only
```

LLM-generated docstrings aware of callers, callees, and types. Diff-aware: only regenerate for functions whose code or dependencies changed. Stores in `docstrings` column on nodes table -- does not modify source files unless explicitly requested.

**Depends on:** 5.1 (LLM provider abstraction), 5.4 (side effects context)

> **Full spec:** See [llm-integration.md](./llm-integration.md) for detailed architecture, infrastructure tables, and prompt design for all LLM-powered features.

---

## Verification Strategy

Each phase includes targeted verification:

| Phase | Verification |
|-------|-------------|
| **1** | Benchmark native vs WASM parsing on a large repo, verify identical output from both engines |
| **2** | `npm test`, manual MCP client test for all tools, config loading tests |
| **2.5** | All 59 test files pass; integration tests for every new command; engine parity tests |
| **2.7** | All 70 test files pass; CFG + AST + dataflow integration tests; extractors produce identical output to pre-refactoring inline extractors (shipped as v3.0.0) |
| **3** | All existing tests pass; each refactored module produces identical output to the pre-refactoring version; unit tests for pure analysis modules; InMemoryRepository tests |
| **4** | `tsc --noEmit` passes with zero errors; all existing tests pass after migration; no runtime behavior changes |
| **5** | Compare `codegraph search` quality before/after descriptions; verify `side_effects` and `risk_score` populated for LLM-enriched builds |
| **6** | `codegraph ask "How does import resolution work?"` against codegraph itself; verify `trace_flow` and `get_started` produce coherent narration |
| **7** | Parse sample files for each new language, verify definitions/calls/imports |
| **8** | Test PR in a fork, verify GitHub Action comment with Mermaid graph and risk labels is posted |
| **9** | `codegraph viz` loads; `hotspots` returns ranked list with LLM commentary; `split_analysis` produces actionable output |

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

- **`node:sqlite` (Node.js built-in)** -- **primary target.** Zero native dependencies, eliminates C++ addon breakage on Node major releases (`better-sqlite3` already broken on Node 24/25). Currently Stability 1.1 (Active Development) as of Node 25.x. Adopt when it reaches Stability 2, or use as a fallback alongside `better-sqlite3` (dual-engine pattern like native/WASM parsing). Backed by the Node.js project -- no startup risk.
- **`libsql` (SQLite fork by Turso)** -- monitor only. Drop-in `better-sqlite3` replacement with built-in DiskANN vector search. However, Turso is pivoting engineering focus to Limbo (full Rust SQLite rewrite), leaving libsql as legacy. Pre-1.0 (v0.5.x) with uncertain long-term maintenance. Low switching cost (API-compatible, data is standard SQLite), but not worth adopting until the Turso/Limbo situation clarifies.

---

## Contributing

Want to help? Contributions to any phase are welcome. See [CONTRIBUTING](README.md#-contributing) for setup instructions.

If you're interested in working on a specific phase, open an issue to discuss the approach before starting.
