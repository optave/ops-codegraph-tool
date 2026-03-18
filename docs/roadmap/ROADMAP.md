# Codegraph Roadmap

> **Current version:** 3.2.0 | **Status:** Active development | **Updated:** March 2026

Codegraph is a strong local-first code graph CLI. This roadmap describes planned improvements across twelve phases -- closing gaps with commercial code intelligence platforms while preserving codegraph's core strengths: fully local, open source, zero cloud dependency by default.

**LLM strategy:** All LLM-powered features are **optional enhancements**. Everything works without an API key. When configured (OpenAI, Anthropic, Ollama, or any OpenAI-compatible endpoint), users unlock richer semantic search and natural language queries.

---

## Overview

| Phase | Theme | Key Deliverables | Status |
|-------|-------|-----------------|--------|
| [**1**](#phase-1--rust-core) | Rust Core | Rust parsing engine via napi-rs, parallel parsing, incremental tree-sitter, JS orchestration layer | **Complete** (v1.3.0) |
| [**2**](#phase-2--foundation-hardening) | Foundation Hardening | Parser registry, complete MCP, test coverage, enhanced config, multi-repo MCP | **Complete** (v1.5.0) |
| [**2.5**](#phase-25--analysis-expansion) | Analysis Expansion | Complexity metrics, community detection, flow tracing, co-change, manifesto, boundary rules, check, triage, audit, batch, hybrid search | **Complete** (v2.7.0) |
| [**2.7**](#phase-27--deep-analysis--graph-enrichment) | Deep Analysis & Graph Enrichment | Dataflow analysis, intraprocedural CFG, AST node storage, expanded node/edge types, extractors refactoring, CLI consolidation, interactive viewer, exports command, normalizeSymbol | **Complete** (v3.0.0) |
| [**3**](#phase-3--architectural-refactoring) | Architectural Refactoring (Vertical Slice) | Unified AST analysis framework, command/query separation, repository pattern, queries.js decomposition, composable MCP, CLI commands, domain errors, builder pipeline, presentation layer, domain grouping, curated API, unified graph model, qualified names, CLI composability | **Complete** (v3.1.5) |
| [**4**](#phase-4--resolution-accuracy) | Resolution Accuracy | Dead role sub-categories, receiver type tracking, interface/trait implementation edges, resolution precision/recall benchmarks, `package.json` exports field, monorepo workspace resolution | **In Progress** (4.2 complete) |
| [**5**](#phase-5--typescript-migration) | TypeScript Migration | Project setup, core type definitions, leaf -> core -> orchestration module migration, test migration, supply-chain security, CI coverage gates | Planned |
| [**6**](#phase-6--native-analysis-acceleration) | Native Analysis Acceleration | Move JS-only build phases (AST nodes, CFG, dataflow, insert nodes, structure, roles, complexity) to Rust; fix incremental rebuild data loss on native; sub-100ms 1-file rebuilds | Planned |
| [**7**](#phase-7--runtime--extensibility) | Runtime & Extensibility | Event-driven pipeline, unified engine strategy, subgraph export filtering, transitive confidence, query caching, configuration profiles, pagination, plugin system, DX & onboarding, confidence annotations, shell completion | Planned |
| [**8**](#phase-8--intelligent-embeddings) | Intelligent Embeddings | LLM-generated descriptions, enhanced embeddings, build-time semantic metadata, module summaries | Planned |
| [**9**](#phase-9--natural-language-queries) | Natural Language Queries | `ask` command, conversational sessions, LLM-narrated graph queries, onboarding tools | Planned |
| [**10**](#phase-10--expanded-language-support) | Expanded Language Support | 8 new languages (11 -> 19), parser utilities | Planned |
| [**11**](#phase-11--github-integration--ci) | GitHub Integration & CI | Reusable GitHub Action, LLM-enhanced PR review, visual impact graphs, SARIF output | Planned |
| [**12**](#phase-12--advanced-features) | Advanced Features | Dead code detection, monorepo, agentic search, refactoring analysis | Planned |

### Dependency graph

```
Phase 1 (Rust Core)
  |-->  Phase 2 (Foundation Hardening)
         |-->  Phase 2.5 (Analysis Expansion)
                |-->  Phase 2.7 (Deep Analysis & Graph Enrichment)
                       |-->  Phase 3 (Architectural Refactoring)
                              |-->  Phase 4 (Resolution Accuracy)
                                     |-->  Phase 5 (TypeScript Migration)
                                            |-->  Phase 6 (Native Analysis Acceleration)
                                            |-->  Phase 7 (Runtime & Extensibility)
                                            |-->  Phase 8 (Embeddings + Metadata)  -->  Phase 9 (NL Queries + Narration)
                                            |-->  Phase 10 (Languages)
                                            |-->  Phase 11 (GitHub/CI) <-- Phase 8 (risk_score, side_effects)
Phases 1-9 -->  Phase 12 (Advanced Features)
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

> **Status:** Complete -- shipped in v1.5.0

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

> **Status:** Complete -- shipped across v2.0.0 -> v2.7.0

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

| Metric | Before (v2.7.0 baseline) | After (v3.0.0) | Delta |
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

## Phase 3 -- Architectural Refactoring ✅

> **Status:** Complete -- started in v3.1.1, finished in v3.1.5

**Goal:** Restructure the codebase for modularity, testability, and long-term maintainability. These are internal improvements -- no new user-facing features, but they make every subsequent phase easier to build and maintain.

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
>
> **v3.1.3 progress:** Extracted `cachedStmt` utility into `src/db/repository/cached-stmt.js` — reusable prepared statement caching for hot-path repository functions ([#417](https://github.com/optave/codegraph/pull/417), [#402](https://github.com/optave/codegraph/pull/402)).

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
    migrations.js              # Schema versions (currently 15 migrations)
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

### 3.4 -- Decompose queries.js (3,395 Lines) ✅

> **v3.1.1 progress:** `queries.js` reduced from 3,395 → 2,490 lines by extracting all CLI formatting to `queries-cli.js` (3.2). Symbol kind constants extracted to `kinds.js` (49 lines) ([#378](https://github.com/optave/codegraph/pull/378)).

- ✅ CLI formatting separated → `queries-cli.js` (via 3.2)
- ✅ `kinds.js` — symbol kind constants extracted
- ✅ Split remaining `queries.js` data functions into `src/analysis/` modules
- ✅ Extract `shared/normalize.js`, `shared/generators.js`

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

### 3.5 -- Composable MCP Tool Registry ✅

Replaced the monolithic 1,470-line `mcp.js` (31 tools in one switch dispatch) with self-contained tool modules.

```
src/
  mcp.js                       # 2-line re-export shim (preserves public API)
  mcp/
    index.js                   # Re-exports: TOOLS, buildToolList, startMCPServer
    server.js                  # MCP server setup, transport, lifecycle, dispatch
    tool-registry.js           # BASE_TOOLS schemas, buildToolList(), TOOLS constant
    middleware.js              # effectiveLimit/effectiveOffset pagination helpers
    tools/
      index.js                 # Barrel: Map<name, { name, handler }> for all 31 tools
      query.js ... ast-query.js  # { name, handler } -- one per tool (31 files)
```

Adding a new MCP tool = adding a file + one line in the barrel. No other files change.

**Affected files:** `src/mcp.js` -> split into `src/mcp/`

### 3.6 -- CLI Command Objects ✅

Monolithic 1,525-line `src/cli.js` split into `src/cli/` with auto-discovery of command modules. 40 independently testable command files in `src/cli/commands/`, each exporting `{ name, description, options, queryOpts, validate, execute }`. Shared utilities extracted to `src/cli/shared/` (query options, output formatting). `src/cli/index.js` provides `registerCommand()` + `discoverCommands()` — new commands are added by dropping a file into `commands/`. `src/cli.js` reduced to an 8-line thin wrapper ([#427](https://github.com/optave/codegraph/pull/427)).

```
src/
  cli.js                         # 8-line thin wrapper → cli/index.js
  cli/
    index.js                     # Commander setup, registerCommand(), discoverCommands()
    shared/
      output.js                  # --json, --ndjson, table, plain text
      options.js                 # Shared options (--no-tests, --json, --db, etc.)
    commands/                    # 40 files, one per command
      build.js                   # { name, description, options, validate, execute }
      ...
```

**Affected files:** `src/cli.js` -> split into `src/cli/`

### 3.7 -- Curated Public API Surface ✅

Reduced `index.js` from ~190 named exports (243 lines) to 48 curated exports (57 lines). CLI formatters, internal DB utilities, parser internals, infrastructure helpers, and implementation-detail constants removed from the public surface. `package.json` `exports` field updated to expose `./cli` entry point.

**What's exported:**
- **31 `*Data()` query functions** — one per command (e.g. `queryNameData`, `contextData`, `auditData`, `cfgData`)
- **4 graph building** — `buildGraph`, `loadConfig`, `findCycles`, `buildEmbeddings`
- **3 export formats** — `exportDOT`, `exportJSON`, `exportMermaid`
- **3 search** — `searchData`, `multiSearchData`, `hybridSearchData`
- **4 constants** — `EVERY_SYMBOL_KIND`, `EVERY_EDGE_KIND`, `EXTENSIONS`, `IGNORE_DIRS`

**What's removed:** CLI display wrappers (`commands/*.js`, `queries-cli.js`), internal DB functions (`fanInJoinSQL`, `NodeQuery`, etc.), parser internals (`parseFileAuto`, `disposeParsers`), infrastructure (`outputResult`, `isTestFile`), registry management, snapshot internals, pagination helpers, implementation-detail constants (`COMPLEXITY_RULES`, `HALSTEAD_RULES`, etc.), and lower-level analysis functions. All remain importable via direct paths.

**Affected files:** `src/index.js`, `package.json`

> **Removed: Decompose complexity.js** — Subsumed by 3.1. The standalone complexity decomposition from the previous revision is now part of the unified AST analysis framework (3.1). The `complexity.js` per-language rules become `ast-analysis/rules/complexity/{lang}.js` alongside CFG and dataflow rules.

### 3.8 -- Domain Error Hierarchy ✅

Structured domain errors replace ad-hoc error handling across the codebase. 8 error classes in `src/errors.js`: `CodegraphError`, `ParseError`, `DbError`, `ConfigError`, `ResolutionError`, `EngineError`, `AnalysisError`, `BoundaryError`. The CLI catches domain errors and formats for humans; MCP returns structured `{ isError, code }` responses.

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

- ✅ `src/errors.js` — 8 domain error classes with `code`, `file`, `cause` fields
- ✅ CLI top-level catch formats domain errors for humans
- ✅ MCP returns structured error responses
- ✅ Domain errors adopted across config, boundaries, triage, and query modules

**New file:** `src/errors.js`

### 3.9 -- Builder Pipeline Architecture ✅

Refactored `buildGraph()` from a monolithic mega-function into explicit, independently testable pipeline stages. `src/builder.js` is now a 12-line barrel re-export. `src/builder/pipeline.js` orchestrates 9 stages via `PipelineContext`. Each stage is a separate file in `src/builder/stages/`.

```
src/
  builder.js                    # 12-line barrel re-export
  builder/
    context.js                  # PipelineContext — shared state across stages
    pipeline.js                 # Orchestrator: setup → stages → timing
    helpers.js                  # batchInsertNodes, collectFiles, fileHash, etc.
    incremental.js              # Incremental build logic
    stages/
      collect-files.js          # Discover source files
      detect-changes.js         # Incremental: hash comparison, removed detection
      parse-files.js            # Parse via native/WASM engine
      insert-nodes.js           # Batch-insert nodes, children, contains/parameter_of edges
      resolve-imports.js        # Import resolution with aliases
      build-edges.js            # Call edges, class edges, barrel resolution
      build-structure.js        # Directory/file hierarchy
      run-analyses.js           # Complexity, CFG, dataflow, AST store
      finalize.js               # Build meta, timing, db close
```

- ✅ `PipelineContext` shared state replaces function parameters
- ✅ 9 sequential stages, each independently testable
- ✅ `src/builder.js` reduced to barrel re-export
- ✅ Timing tracked per-stage in `ctx.timing`

**Affected files:** `src/builder.js` → split into `src/builder/`

### 3.10 -- Embedder Subsystem Extraction ✅

Restructured `embedder.js` (1,113 lines) into a standalone `src/embeddings/` subsystem with pluggable stores and search strategies.

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

- ✅ Extracted into `src/embeddings/` with `index.js`, `models.js`, `generator.js` (v3.1.4, [#433](https://github.com/optave/codegraph/pull/433))
- ✅ Pluggable stores: `sqlite-blob.js`, `fts5.js`
- ✅ Search engines: `semantic.js`, `keyword.js`, `hybrid.js`
- ✅ Text preparation strategies: `structured.js`, `source.js`

**Affected files:** `src/embedder.js` -> split into `src/embeddings/`

### 3.11 -- Unified Graph Model ✅

Unified the four parallel graph representations into a shared in-memory `CodeGraph` model. The `src/graph/` directory contains the model, 3 builders, 6 algorithms, and 2 classifiers. Algorithms are composable — run community detection on the dependency graph, the temporal graph, or a merged graph.

```
src/
  graph/
    index.js                   # Barrel re-export
    model.js                   # CodeGraph class: nodes Map, directed/undirected adjacency
    builders/
      index.js                 # Barrel
      dependency.js            # Build from SQLite call/import edges
      structure.js             # Build from file/directory hierarchy
      temporal.js              # Build from git co-change history
    algorithms/
      index.js                 # Barrel
      bfs.js                   # Breadth-first traversal
      shortest-path.js         # Dijkstra path finding
      tarjan.js                # Strongly connected components / cycle detection
      louvain.js               # Community detection
      centrality.js            # Fan-in/fan-out, betweenness centrality
    classifiers/
      index.js                 # Barrel
      roles.js                 # Node role classification (hub, utility, leaf, etc.)
      risk.js                  # Composite risk scoring
```

- ✅ `CodeGraph` in-memory model with nodes Map, successors/predecessors adjacency
- ✅ 3 builders: dependency (SQLite edges), structure (file hierarchy), temporal (git co-changes)
- ✅ 6 algorithms: BFS, shortest-path, Tarjan SCC, Louvain community, centrality
- ✅ 2 classifiers: role classification, risk scoring
- ✅ `structure.js`, `communities.js`, `cycles.js`, `triage.js`, `viewer.js` refactored to use graph model

**Affected files:** `src/structure.js`, `src/cochange.js`, `src/communities.js`, `src/cycles.js`, `src/triage.js`, `src/viewer.js`

### 3.12 -- Qualified Names & Hierarchical Scoping ✅

> **Phase 2.7 progress:** `parent_id` column, `contains` edges, `parameter_of` edges, and `childrenData()` query now model one-level parent-child relationships.

Node model enriched with `qualified_name`, `scope`, and `visibility` columns (migration v15). Enables direct lookups like "all methods of class X" via `findNodesByScope()` and qualified name resolution via `findNodeByQualifiedName()` — no edge traversal needed.

```sql
ALTER TABLE nodes ADD COLUMN qualified_name TEXT;  -- 'DateHelper.format', 'freeFunction.x'
ALTER TABLE nodes ADD COLUMN scope TEXT;            -- 'DateHelper', null for top-level
ALTER TABLE nodes ADD COLUMN visibility TEXT;       -- 'public' | 'private' | 'protected'
CREATE INDEX idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX idx_nodes_scope ON nodes(scope);
```

- ✅ Migration v15: `qualified_name`, `scope`, `visibility` columns + indexes
- ✅ `batchInsertNodes` expanded to 9 columns (name, kind, file, line, end_line, parent_id, qualified_name, scope, visibility)
- ✅ `insert-nodes.js` computes qualified_name and scope during insertion: methods get scope from class prefix, children get `parent.child` qualified names
- ✅ Visibility extraction for all 8 language extractors:
  - JS/TS: `accessibility_modifier` nodes + `#` private field detection
  - Java/C#/PHP: `modifiers`/`visibility_modifier` AST nodes via shared `extractModifierVisibility()`
  - Python: convention-based (`__name` → private, `_name` → protected)
  - Go: capitalization convention (uppercase → public, lowercase → private)
  - Rust: `visibility_modifier` child (`pub` → public, else private)
- ✅ `findNodesByScope(db, scopeName, opts)` — query by scope with optional kind/file filters
- ✅ `findNodeByQualifiedName(db, qualifiedName)` — direct lookup without edge traversal
- ✅ `childrenData()` returns `qualifiedName`, `scope`, `visibility` for parent and children
- ✅ Integration tests covering qualified_name, scope, visibility, and childrenData output

**Affected files:** `src/db/migrations.js`, `src/db/repository/nodes.js`, `src/builder/helpers.js`, `src/builder/stages/insert-nodes.js`, `src/extractors/*.js`, `src/extractors/helpers.js`, `src/analysis/symbol-lookup.js`

### 3.13 -- Testing Pyramid with InMemoryRepository ✅

The repository pattern (3.3) enables true unit testing. `InMemoryRepository` provides an in-memory backend that implements the same interface as `SqliteRepository`, enabling fast unit tests without SQLite.

- ✅ `InMemoryRepository` at `src/db/repository/in-memory-repository.js` (v3.1.4, [#444](https://github.com/optave/codegraph/pull/444))
- ✅ Pure unit tests for graph algorithms (pass adjacency list, assert result)
- ✅ Pure unit tests for risk/confidence scoring (pass parameters, assert score)
- ✅ Migrate existing integration tests that only need query data to use `InMemoryRepository`

### 3.14 -- Presentation Layer Extraction ✅

Separated all output formatting from domain logic into `src/presentation/`. Domain functions return plain data objects; presentation functions are pure transforms: `data → formatted string`. Commands wire the two together.

```
src/
  presentation/
    viewer.js              # Interactive terminal viewer (tree rendering, color, layout)
    export.js              # DOT, Mermaid, JSON, SVG graph serialization
    table.js               # Tabular CLI output (used by complexity, stats, etc.)
    sequence-renderer.js   # Mermaid sequence diagram formatting (from sequence.js)
    result-formatter.js    # Structured result formatting (moved from infrastructure/)
    colors.js              # Shared color/style utilities
```

- ✅ Extract rendering logic from `viewer.js` (v3.1.4, [#443](https://github.com/optave/codegraph/pull/443))
- ✅ Extract serialization from `export.js` — DOT/Mermaid/JSON writers become pure data → string transforms
- ✅ Extract table formatting helpers used across `queries-cli.js`, `complexity`, `stats`
- ✅ Move `result-formatter.js` from `infrastructure/` to `presentation/`
- ✅ Extract Mermaid rendering from `sequence.js` into `sequence-renderer.js`

**Affected files:** `src/viewer.js`, `src/export.js`, `src/sequence.js`, `src/infrastructure/result-formatter.js`

### 3.15 -- Domain Directory Grouping ✅

**Completed:** `src/` reorganized into `domain/`, `features/`, and `presentation/` layers ([#456](https://github.com/optave/codegraph/pull/456), [#458](https://github.com/optave/codegraph/pull/458)). Three post-reorganization issues (circular imports, barrel exports, path corrections) resolved in [#459](https://github.com/optave/codegraph/pull/459). MCP server import path fixed in [#466](https://github.com/optave/codegraph/pull/466). Complexity/CFG/dataflow analysis restored after the move in [#469](https://github.com/optave/codegraph/pull/469).

```
src/domain/
  graph/                 # builder.js, resolve.js, cycles.js, watcher.js, journal.js, change-journal.js
  analysis/              # symbol-lookup.js, impact.js, dependencies.js, module-map.js,
                         # context.js, exports.js, roles.js
  search/                # embedder subsystem (models, generator, stores, search strategies)
  parser.js              # tree-sitter WASM wrapper + LANGUAGE_REGISTRY
  queries.js             # Query functions (symbol search, file deps, impact analysis)
```

- ✅ Move builder pipeline modules to `domain/graph/` ([#456](https://github.com/optave/codegraph/pull/456))
- ✅ Move decomposed query modules (from 3.4) to `domain/analysis/` ([#456](https://github.com/optave/codegraph/pull/456))
- ✅ Move embedder subsystem (from 3.10) to `domain/search/` ([#456](https://github.com/optave/codegraph/pull/456))
- ✅ Move remaining flat files (`features/`, `presentation/`, `infrastructure/`, `shared/`) into subdirectories ([#458](https://github.com/optave/codegraph/pull/458))
- ✅ Update all import paths across codebase ([#456](https://github.com/optave/codegraph/pull/456), [#458](https://github.com/optave/codegraph/pull/458), [#459](https://github.com/optave/codegraph/pull/459))

**Prerequisite:** 3.2, 3.4, 3.9, 3.10 should be complete before this step — it organizes the results of those decompositions.

### 3.16 -- CLI Composability ✅

**Completed:** `openGraph(opts)` helper eliminates DB-open/close boilerplate across CLI commands. `resolveQueryOpts(opts)` extracts the 5 repeated option fields into one call, refactoring 20 command files. Universal output formatter extended with `--table` (auto-column aligned) and `--csv` (RFC 4180 with nested object flattening) output formats ([#461](https://github.com/optave/codegraph/pull/461)).

- ✅ **`openGraph()` helper** — single helper returning `{ db, rootDir, config }` with engine selection, config loading, and cleanup ([#461](https://github.com/optave/codegraph/pull/461))
- ✅ **Universal output formatter** — `outputResult()` extended with `--table` and `--csv` formats; `resolveQueryOpts()` extracts repeated option fields ([#461](https://github.com/optave/codegraph/pull/461))

**Affected files:** `src/cli/commands/*.js`, `src/cli/shared/`, `src/presentation/result-formatter.js`

---

## Phase 4 -- Resolution Accuracy

> **Status:** Planned

**Goal:** Close the most impactful gaps in call graph accuracy before investing in type safety or native acceleration. The entire value proposition — blast radius, impact analysis, dependency chains — rests on the call graph. These targeted improvements make the graph trustworthy.

**Why before TypeScript:** These fixes operate on the existing JS codebase and produce measurable accuracy gains immediately. TypeScript types will further improve resolution later, but receiver tracking, dead role fixes, and precision benchmarks don't require types to implement.

### 4.1 -- Fix "Dead" Role Sub-categories

The current `dead` role classification conflates genuinely different categories, making the tool's own metrics misleading. Of ~509 dead callable symbols in codegraph's own codebase: 151 are Rust FFI (invisible by design), 94 are CLI/MCP entry points (framework dispatch), 26 are AST visitors (dynamic dispatch), 125 are repository methods (receiver type unknown), and only ~94 are genuine dead code or resolution misses.

- Add sub-categories to role classification: `dead-leaf` (parameters, properties, constants — leaf nodes by definition), `dead-entry` (framework dispatch: CLI commands, MCP tools, event handlers), `dead-ffi` (cross-language FFI boundaries), `dead-unresolved` (genuinely unreferenced callables — the real dead code)
- Update `classifyNodeRoles()` to use the new sub-categories
- Update `roles` command, `audit`, and `triage` to report sub-categories
- MCP `node_roles` tool gains `--role dead-entry`, `--role dead-unresolved` etc.

**Affected files:** `src/graph/classifiers/roles.js`, `src/shared/kinds.js`, `src/domain/analysis/roles.js`, `src/features/triage.js`

### 4.2 -- Receiver Type Tracking for Method Dispatch ✅

The single highest-impact resolution improvement. Previously `obj.method()` resolved to ANY exported `method` in scope — no receiver type tracking. This missed repository pattern calls (`repo.findCallers()`), builder chains, and visitor dispatch.

**Implemented:**
- ✅ Upgraded `typeMap` from `Map<string, string>` to `Map<string, {type, confidence}>` across all 8 language extractors
- ✅ Graded confidence per type source: `1.0` constructor (`new Foo()`), `0.9` type annotation / typed parameter, `0.7` factory method (`Foo.create()`)
- ✅ Factory pattern extraction: JS/TS (`Foo.create()`), Go (`NewFoo()`, `&Struct{}`, `Struct{}`), Python (`Foo()`, `Foo.create()`)
- ✅ Edge builder uses type map for precise `ClassName.method` qualified-name lookup in both JS fallback and native supplement paths
- ✅ Receiver edges carry type-source confidence instead of hardcoded 0.9/0.7
- ✅ `setIfHigher` logic ensures highest-confidence assignment wins per variable
- ✅ Incremental build path updated to consume new format
- ✅ Backwards-compatible: `typeof entry === 'string'` guards handle mixed old/new formats

**Affected files:** `src/domain/graph/builder/stages/build-edges.js`, `src/domain/graph/builder/incremental.js`, `src/extractors/*.js` (all 8 languages)

### 4.3 -- Interface and Trait Implementation Tracking

Extract `implements`/`extends`/trait-impl relationships from tree-sitter AST and store as `implements` edges. When an interface signature changes, all implementors appear in impact analysis.

- New `codegraph implementations <interface>` command — all concrete types implementing a given interface/trait
- Inverse: `codegraph interfaces <class>` — what a type implements
- Covers: TypeScript interfaces, Java interfaces/abstract classes, Go interfaces (structural matching), Rust traits, C# interfaces, PHP interfaces
- `fn-impact` and `diff-impact` include implementors in blast radius by default (`--include-implementations`, on by default)

**Affected files:** `src/extractors/*.js`, `src/domain/graph/builder/stages/build-edges.js`, `src/domain/analysis/impact.js`

### 4.4 -- Call Resolution Precision/Recall Benchmark Suite

No tests currently measure call resolution accuracy. Add a benchmark suite that tracks precision/recall across versions.

- Create `tests/benchmarks/resolution/` with hand-annotated fixture projects per language
- Each fixture declares expected call edges in a `expected-edges.json` manifest
- Benchmark runner compares codegraph's resolved edges against expected edges, reports precision (correct / total resolved) and recall (correct / total expected)
- Track metrics per language and per resolution mode (static, receiver-typed, interface-dispatched)
- CI gate: fail if precision or recall drops below baseline for any language
- Initial target: ≥85% precision, ≥80% recall for TypeScript and JavaScript

**New directory:** `tests/benchmarks/resolution/`

### 4.5 -- `package.json` Exports Field Resolution

Modern Node.js standard since v12. Currently codegraph's import resolution uses brute-force filesystem probing (tries 10+ extensions via `fs.existsSync()`). It doesn't read `package.json` `exports` field, meaning conditional exports, subpath patterns, and package self-references are invisible.

- Parse `package.json` `exports` field during import resolution
- Support subpath patterns (`"./lib/*": "./src/*.js"`)
- Support conditional exports (`"import"`, `"require"`, `"default"`)
- Fall back to current filesystem probing only when `exports` field is absent

**Affected files:** `src/domain/graph/resolve.js`

### 4.6 -- Monorepo Workspace Resolution

`pnpm-workspace.yaml`, npm workspaces (`package.json` `workspaces`), and `lerna.json` are not recognized. Internal package imports (`@myorg/utils`) fall through to global resolution with low confidence.

> **Scope note:** This phase covers the *resolution layer only* — detecting workspace packages and resolving internal imports to source files. Full monorepo graph support (package node type, cross-package edges, `build --workspace` flag) is deferred to Phase 12.2.

- Detect workspace root and enumerate workspace packages
- Resolve internal package imports to actual source files within the monorepo
- Assign high confidence (0.95) to workspace-resolved imports

**Affected files:** `src/domain/graph/resolve.js`, `src/infrastructure/config.js`

---

## Phase 5 -- TypeScript Migration

**Goal:** Migrate the codebase from plain JavaScript to TypeScript, leveraging the clean module boundaries established in Phase 3. Incremental module-by-module migration starting from leaf modules inward.

**Why after Phase 4:** The resolution accuracy work (Phase 4) operates on the existing JS codebase and produces immediate accuracy gains. TypeScript migration builds on Phase 3's clean module boundaries to add type safety across the entire codebase. Every subsequent phase benefits from types: MCP schema auto-generation, API contracts, refactoring safety. The Phase 4 resolution improvements (receiver tracking, interface edges) establish the resolution model that TypeScript types will formalize.

### 5.1 -- Project Setup

- Add `typescript` as a devDependency
- Create `tsconfig.json` with strict mode, ES module output, path aliases matching the Phase 3 module structure
- Update Biome config to lint `.ts` files
- Configure build step: `tsc` emits to `dist/`, `package.json` `exports` point to compiled output
- Add `tsc --noEmit` to CI as a type-checking gate
- Enable incremental compilation for fast rebuilds

**Affected files:** `package.json`, `biome.json`, new `tsconfig.json`

### 5.2 -- Core Type Definitions

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

### 5.3 -- Leaf Module Migration

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

### 5.4 -- Core Module Migration

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

### 5.5 -- Orchestration & Public API Migration

Migrate top-level orchestration and entry points:

| Module | Notes |
|--------|-------|
| `src/builder.ts` | Pipeline stages with typed `PipelineStage` |
| `src/watcher.ts` | File system events + pipeline |
| `src/embeddings/*.ts` | Vector store interface, model registry |
| `src/mcp/*.ts` | Tool schemas, typed handlers |
| `src/cli/*.ts` | Command objects with typed options |
| `src/index.ts` | Curated public API with proper export types |

### 5.6 -- Test Migration

- Migrate test files from `.js` to `.ts`
- Add type-safe test utilities and fixture builders
- Verify vitest TypeScript integration with path aliases
- Maintain `InMemoryRepository` (from Phase 3.2) as a typed test double

**Verification:** All existing tests pass. `tsc --noEmit` succeeds with zero errors. No `any` escape hatches except at FFI boundaries (napi-rs addon, tree-sitter WASM).

**Affected files:** All `src/**/*.js` -> `src/**/*.ts`, all `tests/**/*.js` -> `tests/**/*.ts`, `package.json`, `biome.json`

### 5.7 -- Supply-Chain Security & Audit

**Gap:** No `npm audit` in CI pipeline. No supply-chain attestation (SLSA/SBOM). No formal security audit history.

**Deliverables:**

1. **CI `npm audit`** -- add `npm audit --omit=dev` step to CI pipeline; fail on critical/high vulnerabilities
2. **SBOM generation** -- produce CycloneDX or SPDX SBOM on each release via `@cyclonedx/cyclonedx-npm` or similar
3. **SLSA provenance** -- enable SLSA Level 2+ build provenance using `actions/attest-build-provenance` in the publish workflow; attach attestation to npm packages
4. **Security audit log** -- maintain `docs/security/AUDIT_LOG.md` documenting past audits, dependency reviews, and remediation history

**Affected files:** `.github/workflows/ci.yml`, `.github/workflows/publish.yml`, `docs/security/`

### 5.8 -- CI Test Quality & Coverage Gates

**Gaps:**

- No coverage thresholds enforced in CI (coverage report runs locally only)
- Embedding tests in separate workflow requiring HuggingFace token
- 312 `setTimeout`/`sleep` instances in tests — potential flakiness under load
- No dependency audit step in CI (see also [5.7](#57----supply-chain-security--audit))

**Deliverables:**

1. **Coverage gate** -- add `vitest --coverage` to CI with minimum threshold (e.g. 80% lines/branches); fail the pipeline when coverage drops below the threshold
2. **Unified test workflow** -- merge embedding tests into the main CI workflow using a securely stored `HF_TOKEN` secret; eliminate the separate workflow
3. **Timer cleanup** -- audit and reduce `setTimeout`/`sleep` usage in tests; replace with deterministic waits (event-based, polling with backoff, or `vi.useFakeTimers()`) to reduce flakiness
4. > _Dependency audit step is covered by [5.7](#57----supply-chain-security--audit) deliverable 1._

**Affected files:** `.github/workflows/ci.yml`, `vitest.config.js`, `tests/`

### 5.9 -- Kill List (Technical Debt Cleanup)

Items to remove or rework during the TypeScript migration, identified by architectural audit:

1. **Remove Maintainability Index computation** — The 1991 Coleman-Oman formula (171 - 5.2*ln(V) - 0.23*G - 16.2*ln(LOC)) was validated on Fortran and C, not modern languages with closures, async/await, and higher-order functions. Microsoft deprecated their MI implementation in 2023. Remove from `ast-analysis/metrics.js` and `complexity` output, or replace with a validated metric
2. **Scope Halstead metrics to imperative code** — Halstead operator/operand counting is meaningless for JSX, template literals, HCL, and declarative code. Either scope to imperative code blocks or remove
3. **Migrate custom `graph/model.js` to `graphology`** — `graphology` is already a runtime dependency. The custom model reimplements `addNode`, `addEdge`, `successors`, `predecessors`, `inDegree`, `outDegree` — all available natively in `graphology`. Migrate during the TypeScript migration to avoid maintaining two graph representations
4. **Skip WASM loading on platforms with native binaries** — On supported platforms (darwin-arm64, linux-x64, win32-x64), WASM should not be loaded at all. Currently `loadNative()` is checked on every call in `resolve.js`

---

## Phase 6 -- Native Analysis Acceleration

**Goal:** Move the remaining JS-only build phases to Rust so that `--engine native` eliminates all redundant WASM visitor walks. Today only 3 of 10 build phases (parse, resolve imports, build edges) run in Rust — the other 7 execute identical JavaScript regardless of engine, leaving ~50% of native build time on the table.

**Why its own phase:** This is a substantial Rust engineering effort — porting 6 JS visitors to `crates/codegraph-core/`, fixing a data loss bug in incremental rebuilds, and optimizing the 1-file rebuild path. With TypeScript types (Phase 5) defining the interface contracts, the Rust ports can target well-typed boundaries. The Phase 3 module boundaries make each phase a self-contained target.

**Evidence (v3.1.4 benchmarks on 398 files):**

| Phase | Native | WASM | Ratio | Status |
|-------|-------:|-----:|------:|--------|
| Parse | 468ms | 1483ms | 3.2x faster | Already Rust |
| Build edges | 88ms | 152ms | 1.7x faster | Already Rust |
| Resolve imports | 8ms | 9ms | ~1x | Already Rust |
| **AST nodes** | **361ms** | **347ms** | **~1x** | JS visitor — biggest win |
| **CFG** | **126ms** | **125ms** | **~1x** | JS visitor |
| **Dataflow** | **100ms** | **98ms** | **~1x** | JS visitor |
| **Insert nodes** | **143ms** | **148ms** | **~1x** | Pure SQLite batching |
| **Roles** | **29ms** | **32ms** | **~1x** | JS classification |
| **Structure** | **13ms** | **17ms** | **~1x** | JS directory tree |
| Complexity | 16ms | 77ms | 5x faster | Partly pre-computed |

**Target:** Reduce native full-build time from ~1,400ms to ~700ms (2x improvement) by eliminating ~690ms of redundant JS visitor work.

### 6.1 -- AST Node Extraction in Rust

The largest single opportunity. Currently the native parser returns partial AST node data, so the JS `buildAstNodes()` visitor re-walks all WASM trees anyway (~361ms).

- Extend `crates/codegraph-core/` to extract all AST node types (`call`, `new`, `string`, `regex`, `throw`, `await`) during the native parse phase
- Return complete AST node data in the `FileSymbols` result so `run-analyses.js` can skip the WASM walker entirely
- Validate parity: ensure native extraction produces identical node counts to the WASM visitor (benchmark already tracks this via `nodes/file`)

**Affected files:** `crates/codegraph-core/src/lib.rs`, `src/features/ast.js`, `src/domain/graph/builder/stages/run-analyses.js`

### 6.2 -- CFG Construction in Rust

The intraprocedural control-flow graph visitor runs in JS even on native builds (~126ms).

- Port `createCfgVisitor()` logic to Rust: basic block detection, branch/loop edges, entry/exit nodes
- Return CFG block data per function in `FileSymbols` so the JS visitor is fully bypassed
- Validate parity: CFG block counts and edge counts must match the WASM visitor output

**Affected files:** `crates/codegraph-core/src/lib.rs`, `src/features/cfg.js`, `src/ast-analysis/visitors/cfg-visitor.js`

### 6.3 -- Dataflow Analysis in Rust

Dataflow edges are computed by a JS visitor that walks WASM trees (~100ms on native builds).

- Port `createDataflowVisitor()` to Rust: variable definitions, assignments, reads, def-use chains
- Return dataflow edges in `FileSymbols`
- Validate parity against WASM visitor output

**Affected files:** `crates/codegraph-core/src/lib.rs`, `src/features/dataflow.js`, `src/ast-analysis/visitors/dataflow-visitor.js`

### 6.4 -- Batch SQLite Inserts via Rust

`insertNodes` is pure SQLite work (~143ms) but runs row-by-row from JS. Batching in Rust can reduce JS↔native boundary crossings.

- Expose a `batchInsertNodes(nodes[])` function from Rust that uses a single prepared statement in a transaction
- Alternatively, generate the SQL batch on the JS side and execute as a single `better-sqlite3` call (may be sufficient without Rust)
- Benchmark both approaches; pick whichever is faster

**Affected files:** `crates/codegraph-core/src/lib.rs`, `src/db/index.js`, `src/domain/graph/builder/stages/insert-nodes.js`

### 6.5 -- Role Classification & Structure in Rust

Smaller wins (~42ms combined) but complete the picture of a fully native build pipeline.

- Port `classifyNodeRoles()` to Rust: hub/leaf/bridge/utility classification based on in/out degree and betweenness
- Port directory structure building and metrics aggregation
- Return role assignments and structure data alongside parse results

**Affected files:** `crates/codegraph-core/src/lib.rs`, `src/features/structure.js`, `src/domain/graph/builder/stages/build-structure.js`

### 6.6 -- Complete Complexity Pre-computation

Complexity is partly pre-computed by native (~16ms vs 77ms WASM) but not all functions are covered.

- Ensure native parse computes cognitive and cyclomatic metrics for every function, not just a subset
- Halstead and MI are scoped by Phase 5.9 (Kill List): MI will be removed entirely; Halstead will be limited to imperative code blocks. Native acceleration should only target the metrics that survive the Kill List
- Eliminate the WASM fallback path in `buildComplexityMetrics()` when running native

**Affected files:** `crates/codegraph-core/src/lib.rs`, `src/features/complexity.js`

### 6.7 -- Fix Incremental Rebuild Data Loss on Native Engine

**Bug:** On native 1-file rebuilds, complexity, CFG, and dataflow data for the changed file is **silently lost**. `purgeFilesFromGraph` removes the old data, but the analysis phases never re-compute it because:

1. The native parser does not produce a `_tree` (WASM tree-sitter tree)
2. The unified walker at `src/ast-analysis/engine.js:108-109` skips files without `_tree`
3. The `buildXxx` functions check for pre-computed fields (`d.complexity`, `d.cfg?.blocks`) which the native parser does not provide for these analyses
4. Result: 0.1ms no-op — the phases run but do nothing

This is confirmed by the v3.1.4 1-file rebuild data: complexity (0.1ms), CFG (0.1ms), dataflow (0.2ms) on native — these are just module import overhead, not actual computation. Contrast with v3.1.3 where the numbers were higher (1.3ms, 8.7ms, 4ms) because earlier versions triggered a WASM fallback tree via `ensureWasmTrees`.

**Fix (prerequisite: 6.1–6.3):** Once the native parser returns complete AST nodes, CFG blocks, and dataflow edges in `FileSymbols`, the `run-analyses` stage can store them directly without needing a WASM tree. The incremental path must:

- Ensure `parseFilesAuto()` returns pre-computed analysis data for the single changed file
- Have `run-analyses.js` store that data (currently it only stores if `_tree` exists or if pre-computed fields are present — the latter path needs to work reliably)
- Add an integration test: rebuild 1 file on native engine, then query its complexity/CFG/dataflow and assert non-empty results

**Affected files:** `src/ast-analysis/engine.js`, `src/domain/graph/builder/stages/run-analyses.js`, `src/domain/parser.js`, `tests/integration/`

### 6.8 -- Incremental Rebuild Performance

With analysis data loss fixed, optimize the 1-file rebuild path end-to-end. Current native 1-file rebuild is 265ms — dominated by parse (51ms), structure (13ms), roles (27ms), edges (13ms), insert (12ms), and finalize (12ms).

- **Skip unchanged phases:** Structure and roles are graph-wide computations. On a 1-file change, only the changed file's nodes/edges need updating — skip full reclassification unless the file's degree changed significantly
- **Incremental edge rebuild:** Only rebuild edges involving the changed file's symbols, not the full edge set
- **Benchmark target:** Sub-100ms native 1-file rebuilds (from current 265ms)

**Affected files:** `src/domain/graph/builder/stages/build-structure.js`, `src/domain/graph/builder/stages/build-edges.js`, `src/domain/graph/builder/pipeline.js`

---

## Phase 7 -- Runtime & Extensibility

**Goal:** Harden the runtime for large codebases and open the platform to external contributors. These items were deferred from Phase 3 -- they depend on the clean module boundaries and domain layering established there, and benefit from TypeScript's type safety (Phase 5) for safe refactoring of cross-cutting concerns like caching, streaming, and plugin contracts.

**Why after TypeScript Migration:** Several of these items introduce new internal contracts (plugin API, cache interface, streaming protocol, engine strategy). Defining those contracts in TypeScript from the start avoids a second migration pass and gives contributors type-checked extension points (Phase 5).

### 7.1 -- Event-Driven Pipeline

Replace the synchronous build/analysis pipeline with an event/streaming architecture. Enables progress reporting, cancellation tokens, and bounded memory usage on large repositories (10K+ files).

- Introduce a lightweight `EventBus` (or Node `EventEmitter` subclass) that pipeline stages publish to: `file:parsed`, `resolve:complete`, `build:progress`, `build:error`
- CLI subscribes for progress bars and cancellation (Ctrl-C gracefully stops in-flight parsing)
- MCP subscribes for streaming partial results back to the client
- Programmatic API consumers can attach custom listeners (logging, metrics, CI reporters)
- Back-pressure support: slow consumers don't block the pipeline; events are buffered up to a configurable high-water mark

**Affected files:** `src/domain/graph/builder.js`, `src/cli/`, `src/mcp/`

### 7.2 -- Unified Engine Interface (Strategy Pattern)

Replace scattered `engine.name === 'native'` / `engine === 'wasm'` branching throughout the codebase with a formal Strategy pattern. Each engine implements a common `ParsingEngine` interface with methods like `parse(file)`, `batchParse(files)`, `supports(language)`, and `capabilities()`.

- Define a `ParsingEngine` interface (TypeScript) with clear input/output contracts
- Implement `NativeEngine` and `WasmEngine` adapters behind this interface
- The `auto` strategy delegates to native first, falls back to WASM per-language based on `supports()` checks
- Remove all engine-name string comparisons from calling code -- callers interact only with the interface
- Less critical now that native is the primary path, but eliminates a class of branching bugs and simplifies adding future engines (e.g., LSP-backed parsing)

**Affected files:** `src/infrastructure/native.js`, `src/domain/parser.js`, `src/domain/graph/builder.js`

### 7.3 -- Subgraph Export Filtering

Add focus and depth controls to `codegraph export` so users can produce usable visualizations of specific subsystems rather than the entire graph.

```bash
codegraph export --focus src/domain/graph/builder.js --depth 2 --format mermaid
codegraph export --focus "buildGraph" --depth 3 --format dot
```

- `--focus <file|symbol>`: center the export on a specific file or symbol node
- `--depth <N>`: include only nodes within N hops of the focus (default: 2)
- `--direction <in|out|both>`: control traversal direction (callers, callees, or both)
- Combine with existing `--format` flags (DOT, Mermaid, GraphML, Neo4j)
- Large-graph safety: warn if the subgraph exceeds 500 nodes and suggest reducing depth

**Affected files:** `src/features/export.js`, `src/presentation/export.js`

### 7.4 -- Transitive Import-Aware Confidence

Improve import resolution accuracy by walking the import graph before falling back to proximity heuristics. Currently the 6-level priority system uses directory proximity as a strong signal, but this can mis-resolve when a symbol is re-exported through an index file several directories away.

- Before proximity fallback, trace the transitive import chain: if file A imports from barrel B which re-exports from C, resolve directly to C
- Track re-export chains in a lightweight in-memory graph built during the resolve phase
- Confidence scores account for chain length (direct import = 1.0, one re-export hop = 0.95, two hops = 0.9, etc.)
- Handles circular re-exports gracefully (cycle detection with visited set)

**Affected files:** `src/domain/graph/resolve.js`

### 7.5 -- Query Result Caching

Add an LRU/TTL cache layer between the analysis/query functions and the SQLite repository. With 34+ MCP tools that often run overlapping queries within a session, caching eliminates redundant DB round-trips.

- Implement a `QueryCache` with configurable max entries (default: 1000) and TTL (default: 60s)
- Cache key: deterministic hash of query name + parameters
- Automatic invalidation on `build` (cache cleared when graph is rebuilt)
- Optional `--no-cache` flag for debugging and benchmarking
- Cache hit/miss stats exposed via `codegraph stats` and debug logging
- MCP sessions benefit most -- typical tool sequences (`context` → `fn-impact` → `file-deps`) share intermediate results

**Affected files:** `src/domain/analysis/`, `src/db/index.js`

### 7.6 -- Configuration Profiles

Support named configuration profiles for monorepos and multi-service projects where different parts of the codebase need different settings.

```json
{
  "profiles": {
    "backend": { "include": ["services/api/**"], "engine": "native", "boundaries": "onion" },
    "frontend": { "include": ["packages/web/**"], "engine": "wasm", "boundaries": false },
    "shared": { "include": ["packages/shared/**"], "check": { "maxCycles": 0 } }
  }
}
```

- `--profile <name>` flag on all CLI commands
- Profiles inherit from the base `.codegraphrc.json` and override specific fields
- Each profile can specify its own `include`/`exclude` globs, engine preference, boundary rules, and check thresholds
- MCP respects the active profile when scoping tool results

**Affected files:** `src/infrastructure/config.js`, `src/cli/`

### 7.7 -- Pagination Standardization

Standardize SQL-level `LIMIT`/`OFFSET` pagination across all repository queries and surface it consistently through the CLI and MCP.

- All repository query methods accept `{ limit, offset }` options with sensible defaults
- CLI commands support `--limit` and `--offset` flags (or `--page` / `--per-page` for convenience)
- MCP tools accept `limit` and `offset` parameters; responses include `total` count and `hasMore` flag
- Eliminates ad-hoc in-memory slicing that currently happens in some query paths
- Large result sets are bounded by default (e.g., 100 rows) to prevent accidental memory blowups in MCP

**Affected files:** `src/shared/paginate.js`, `src/db/index.js`, `src/domain/analysis/`, `src/mcp/`

### 7.8 -- Plugin System for Custom Commands

Allow users to extend codegraph with custom commands by dropping a JS/TS module into `~/.codegraph/plugins/` (global) or `.codegraph/plugins/` (project-local).

**Plugin contract:**

```ts
export const meta = {
  name: 'my-command',
  description: 'Does something custom',
  args: [{ name: 'target', required: true, description: 'Symbol or file to analyze' }],
};

export function data(db: Database, args: ParsedArgs, config: Config): object {
  // Access the full codegraph DB and config
  // Return a plain object -- the framework handles formatting
}
```

- Auto-discovered at startup; registered as CLI subcommands and (optionally) MCP tools
- Plugins receive the open DB handle, parsed arguments, and resolved config
- Output goes through the universal formatter (`--json`, `--table`, etc.) automatically
- Plugin errors are isolated -- a failing plugin doesn't crash the main process
- `codegraph plugins list` shows installed plugins with their source (global vs project)
- Low priority until there's user demand for extensibility beyond the built-in commands

**Affected files:** `src/cli/`, `src/mcp/`, new `src/infrastructure/plugins.js`

### 7.9 -- Developer Experience & Onboarding

Lower the barrier to first successful use. Today codegraph requires manual install, manual config, and prior knowledge of which command to run next.

1. **`codegraph init`** -- interactive wizard that detects the project (languages, framework, monorepo), suggests `.codegraphrc.json` config, and auto-writes MCP settings for the detected editor (Claude Code, Cursor, VS Code, Zed)
2. **Surface benchmark numbers in README** -- headline performance numbers (parse time, build time, query latency) already exist internally; surface them prominently in the README so users see concrete numbers before installing
3. **`npx @optave/codegraph` support** -- zero-install path; ensure the package works correctly when invoked via `npx` without prior `npm install` (handle WASM grammar bootstrapping, native addon fallback)
4. **Pre-built editor configs** -- ship ready-to-use MCP/extension configs for Cursor, VS Code, and Zed (not just Claude Code); include in `docs/editors/` with one-command setup instructions
5. **Guided CLI output** -- after each command, suggest the logical next step (e.g. `"Next: try codegraph context <symbol> to see full context"`); suppressible via `--quiet` or config

**Affected files:** new `src/cli/commands/init.js`, `docs/benchmarks/`, `docs/editors/`, `src/presentation/result-formatter.js`

### 7.10 -- Confidence Annotations on Query Output

Every query output should communicate its known limitations. When `fn-impact` shows a blast radius of 5 functions, it should note how many method-dispatch calls may be missing.

- Add `confidence` and `resolution_stats` fields to all `*Data()` function return values
- Format: `{ resolved: N, unresolved_method_calls: M, confidence: 0.XX }`
- CLI displays as a footer line: `"5 affected functions (confidence: 82%, 3 unresolved method calls in scope)"`
- MCP tools include the fields in JSON responses

**Affected files:** `src/domain/analysis/*.js`, `src/presentation/result-formatter.js`

### 7.11 -- Shell Completion

Commander supports shell completion but it's not implemented. Basic UX gap for a CLI tool with 40+ commands.

- Generate bash/zsh/fish completion scripts via Commander's built-in support
- `codegraph completion bash|zsh|fish` outputs the script
- Document in README

**Affected files:** `src/cli/index.js`

---

## Phase 8 -- Intelligent Embeddings

**Goal:** Dramatically improve semantic search quality by embedding natural-language descriptions instead of raw code.

> **Phase 8.3 (Hybrid Search) was completed early** during Phase 2.5 -- FTS5 BM25 + semantic search with RRF fusion is already shipped in v2.7.0.

### 8.1 -- LLM Description Generator

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

### 8.2 -- Enhanced Embedding Pipeline

- When descriptions exist, embed the description text instead of raw code
- Keep raw code as fallback when no description is available
- Add `--use-descriptions` flag to `codegraph embed` (default: true when descriptions exist)
- Store embedding source type in `embedding_meta` (code vs description)

**Expected improvement:** ~12% better semantic similarity for natural-language queries.

**Affected files:** `src/embedder.js`

### ~~8.3 -- Hybrid Search~~ ✅ Completed in Phase 2.5

Shipped in v2.7.0. FTS5 BM25 keyword search + semantic vector search with RRF fusion. Three search modes: `hybrid` (default), `semantic`, `keyword`.

### 8.4 -- Build-time Semantic Metadata

Enrich nodes with LLM-generated metadata beyond descriptions. Computed incrementally at build time (only for changed nodes), stored as columns on the `nodes` table.

| Column | Content | Example |
|--------|---------|---------|
| `side_effects` | Mutation/IO tags | `"writes DB"`, `"sends email"`, `"mutates state"` |
| `complexity_notes` | Responsibility count, cohesion rating | `"3 responsibilities, low cohesion -- consider splitting"` |
| `risk_score` | Fragility metric from graph centrality + LLM assessment | `0.82` (high fan-in + complex logic) |

- MCP tool: `assess <name>` -- returns complexity rating + specific concerns
- Cascade invalidation: when a node changes, mark dependents for re-enrichment

**Depends on:** 8.1 (LLM provider abstraction)

### 8.5 -- Module Summaries

Aggregate function descriptions + dependency direction into file-level narratives.

- `module_summaries` table -- one entry per file, re-rolled when any contained node changes
- MCP tool: `explain_module <file>` -- returns module purpose, key exports, role in the system
- `naming_conventions` metadata per module -- detected patterns (camelCase, snake_case, verb-first), flag outliers

**Depends on:** 8.1 (function-level descriptions must exist first)

> **Full spec:** See [llm-integration.md](./llm-integration.md) for detailed architecture, infrastructure table, and prompt design.

---

## Phase 9 -- Natural Language Queries

**Goal:** Allow developers to ask questions about their codebase in plain English.

### 9.1 -- Query Engine

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

### 9.2 -- Conversational Sessions

Multi-turn conversations with session memory.

```bash
codegraph ask "How does auth work?" --session my-session
codegraph ask "What about the token refresh?" --session my-session
codegraph sessions list
codegraph sessions clear
```

- Store conversation history in SQLite table `sessions`
- Include prior Q&A pairs in subsequent prompts

### 9.3 -- MCP Integration

New MCP tool: `ask_codebase` -- natural language query via MCP.

Enables AI coding agents (Claude Code, Cursor, etc.) to ask codegraph questions about the codebase.

**Affected files:** `src/mcp.js`

### 9.4 -- LLM-Narrated Graph Queries

Graph traversal + LLM narration for questions that require both structural data and natural-language explanation. Each query walks the graph first, then sends the structural result to the LLM for narration.

| Query | Graph operation | LLM adds |
|-------|----------------|----------|
| `trace_flow <entry>` | BFS from entry point to leaves | Sequential narrative: "1. handler validates -> 2. calls createOrder -> 3. writes DB" |
| `trace_upstream <name>` | Recursive caller walk | Ranked suspects: "most likely cause is X because it modifies the same state" |
| `effect_analysis <name>` | Full callee tree walk, aggregate `side_effects` | "Calling X will: write to DB (via Y), send email (via Z)" |
| `dependency_path <A> <B>` | Shortest path(s) between two symbols | Narrates each hop: "A imports X from B because A needs to validate tokens" |

Pre-computed `flow_narratives` table caches results for key entry points at build time, invalidated when any node in the chain changes.

**Depends on:** 8.4 (`side_effects` metadata), 8.1 (descriptions for narration context)

### 9.5 -- Onboarding & Navigation Tools

Help new contributors and AI agents orient in an unfamiliar codebase.

- `entry_points` query -- graph finds roots (high fan-out, low fan-in) + LLM ranks by importance
- `onboarding_guide` command -- generates a reading order based on dependency layers
- MCP tool: `get_started` -- returns ordered list: "start here, then read this, then this"
- `change_plan <description>` -- LLM reads description, graph identifies relevant modules, returns touch points and test coverage gaps

**Depends on:** 8.5 (module summaries for context), 9.1 (query engine)

---

## Phase 10 -- Expanded Language Support

**Goal:** Go from 11 -> 19 supported languages.

### 10.1 -- Batch 1: High Demand

| Language | Extensions | Grammar | Effort |
|----------|-----------|---------|--------|
| C | `.c`, `.h` | `tree-sitter-c` | Low |
| C++ | `.cpp`, `.hpp`, `.cc`, `.cxx` | `tree-sitter-cpp` | Medium |
| Kotlin | `.kt`, `.kts` | `tree-sitter-kotlin` | Low |
| Swift | `.swift` | `tree-sitter-swift` | Medium |

### 10.2 -- Batch 2: Growing Ecosystems

| Language | Extensions | Grammar | Effort |
|----------|-----------|---------|--------|
| Scala | `.scala`, `.sc` | `tree-sitter-scala` | Medium |
| Dart | `.dart` | `tree-sitter-dart` | Low |
| Lua | `.lua` | `tree-sitter-lua` | Low |
| Zig | `.zig` | `tree-sitter-zig` | Low |

### 10.3 -- Parser Abstraction Layer

Extract shared patterns from existing extractors into reusable helpers.

| Helper | Purpose |
|--------|---------|
| `findParentNode(node, typeNames)` | Walk parent chain to find enclosing class/struct |
| `extractBodyMethods(bodyNode, parentName)` | Extract method definitions from a body block |
| `normalizeImportPath(importText)` | Cross-language import path normalization |

**Result:** Reduces boilerplate for each new language from ~200 lines to ~80 lines.

**New file:** `src/parser-utils.js`

---

## Phase 11 -- GitHub Integration & CI

**Goal:** Bring codegraph's analysis into pull request workflows.

> **Note:** Phase 2.5 delivered `codegraph check` (CI validation predicates with exit code 0/1), which provides the foundation for GitHub Action integration. The boundary violation, blast radius, and cycle detection predicates are already available.

### 11.1 -- Reusable GitHub Action

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

### 11.2 -- PR Review Integration

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

### 11.3 -- Visual Impact Graphs for PRs

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

**Depends on:** 11.1 (GitHub Action), 8.4 (`risk_score`, `side_effects`)

### 11.4 -- SARIF Output

> **Note:** SARIF output could be delivered as early as Phase 7 for IDE integration, since it only requires serializing existing cycle/check data into the SARIF JSON schema.

Add SARIF output format for cycle detection. SARIF integrates with GitHub Code Scanning, showing issues inline in the PR.

**Affected files:** `src/export.js`

### 11.5 -- Auto-generated Docstrings

```bash
codegraph annotate
codegraph annotate --changed-only
```

LLM-generated docstrings aware of callers, callees, and types. Diff-aware: only regenerate for functions whose code or dependencies changed. Stores in `docstrings` column on nodes table -- does not modify source files unless explicitly requested.

**Depends on:** 8.1 (LLM provider abstraction), 8.4 (side effects context)

---

## Phase 12 -- Advanced Features

### 12.1 -- Dead Code Detection

```bash
codegraph dead
codegraph dead --exclude-exports --exclude-tests
```

Find functions/methods/classes with zero incoming edges (never called). Filters for exports, test files, and entry points.

> **Note:** Phase 2.5 added role classification (`dead` role in structure.js) and Phase 2.7 added AST node storage (`ast_query` can find unreferenced exports). This extends those foundations with a dedicated command, smarter filtering, and cross-reference with `exports` command data.

**Affected files:** `src/queries.js`

### 12.2 -- Cross-Repository Support (Monorepo)

Support multi-package monorepos with cross-package edges.

- Detect workspace root (`package.json` workspaces, `pnpm-workspace.yaml`, `lerna.json`)
- Resolve internal package imports (e.g., `@myorg/utils`) to actual source files
- Add `package` column to nodes table
- `codegraph build --workspace` to scan all packages
- Impact analysis across package boundaries

### 12.3 -- Agentic Search

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

### 12.4 -- Refactoring Analysis

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

**Depends on:** 8.4 (`risk_score`, `complexity_notes`), 8.5 (module summaries)

### 12.5 -- Auto-generated Docstrings

```bash
codegraph annotate
codegraph annotate --changed-only
```

LLM-generated docstrings aware of callers, callees, and types. Diff-aware: only regenerate for functions whose code or dependencies changed. Stores in `docstrings` column on nodes table -- does not modify source files unless explicitly requested.

**Depends on:** 8.1 (LLM provider abstraction), 8.4 (side effects context)

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
| **4** | Hand-annotated fixture projects with expected call edges; precision ≥85%, recall ≥80% for JS/TS; dead role sub-categories produce correct classifications on codegraph's own codebase |
| **5** | `tsc --noEmit` passes with zero errors; all existing tests pass after migration; no runtime behavior changes |
| **6** | Native full-build time reduced from ~1,400ms to ~700ms; 1-file rebuild complexity/CFG/dataflow data verified non-empty on native engine |
| **7** | Event pipeline emits progress events; plugin system loads and executes a sample plugin; confidence annotations appear on query output |
| **8** | Compare `codegraph search` quality before/after descriptions; verify `side_effects` and `risk_score` populated for LLM-enriched builds |
| **9** | `codegraph ask "How does import resolution work?"` against codegraph itself; verify `trace_flow` and `get_started` produce coherent narration |
| **10** | Parse sample files for each new language, verify definitions/calls/imports |
| **11** | Test PR in a fork, verify GitHub Action comment with Mermaid graph and risk labels is posted |
| **12** | `hotspots` returns ranked list with LLM commentary; `split_analysis` produces actionable output; dead code detection filters correctly |

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
