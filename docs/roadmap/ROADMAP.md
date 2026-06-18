# Codegraph Roadmap

> **Current version:** 3.13.0 | **Status:** Active development | **Updated:** 2026-06-16

Codegraph is a strong local-first code graph CLI. This roadmap describes planned improvements across fourteen phases -- closing gaps with commercial code intelligence platforms while preserving codegraph's core strengths: fully local, open source, zero cloud dependency by default.

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
| [**4**](#phase-4--resolution-accuracy) | Resolution Accuracy | Dead role sub-categories, receiver type tracking, interface/trait implementation edges, resolution precision/recall benchmarks, `package.json` exports field, monorepo workspace resolution | **Complete** (v3.3.1) |
| [**5**](#phase-5--typescript-migration) | TypeScript Migration | Project setup, core type definitions, leaf -> core -> orchestration module migration, test migration | **Complete** (v3.4.0) |
| [**6**](#phase-6--native-analysis-acceleration) | Native Analysis Acceleration | Rust extraction for AST/CFG/dataflow/complexity; batch SQLite inserts; incremental rebuilds; native DB write pipeline; full rusqlite migration so native engine never touches better-sqlite3 | **Complete** (v3.5.0) |
| [**7**](#phase-7--expanded-language-support) | Expanded Language Support | Parser abstraction layer, 23 new languages in 4 batches (11 → 34), dual-engine support — all 4 batches shipped across v3.6.0–v3.8.0 | **Complete** (v3.8.0) |
| [**8**](#phase-8--analysis-depth) | Analysis Depth | TypeScript-native resolution, inter-procedural type propagation, field-based points-to analysis, enhanced dynamic dispatch, barrel file resolution, precision/recall CI gates, language-specific analysis reference map (34 languages, Jelly-equivalents, fixture acquisition guide) | **Complete** (v3.12.0) |
| [**9**](#phase-9--runtime--extensibility) | Runtime & Extensibility | Event-driven pipeline, unified engine strategy, subgraph export filtering, transitive confidence, query caching, configuration profiles, pagination, plugin system | Planned |
| [**10**](#phase-10--quality-security--technical-debt) | Quality, Security & Technical Debt | Supply-chain security, test quality gates, architectural debt cleanup | In Progress |
| [**11**](#phase-11--intelligent-embeddings) | Intelligent Embeddings | LLM-generated descriptions, enhanced embeddings, build-time semantic metadata, module summaries | Planned |
| [**12**](#phase-12--natural-language-queries) | Natural Language Queries | `ask` command, conversational sessions, LLM-narrated graph queries, onboarding tools | Planned |
| [**13**](#phase-13--github-integration--ci) | GitHub Integration & CI | Reusable GitHub Action, LLM-enhanced PR review, visual impact graphs, SARIF output | Planned |
| [**14**](#phase-14--advanced-features) | Advanced Features | Dead code detection, monorepo, agentic search, refactoring analysis | Planned |

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
                                            |-->  Phase 7 (Expanded Language Support)  -->  Phase 8 (Analysis Depth)
                                            |-->  Phase 9 (Runtime & Extensibility)
                                            |-->  Phase 10 (Quality, Security & Technical Debt)
                                            |-->  Phase 11 (Intelligent Embeddings)  -->  Phase 12 (Natural Language Queries)
                                            |-->  Phase 13 (GitHub Integration & CI) <-- Phase 11 (risk_score, side_effects)
Phases 1-13 -->  Phase 14 (Advanced Features)
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

**Completed:** All 4 analyses (complexity, CFG, dataflow, AST-store) now run in a single DFS walk via `walkWithVisitors`. The CFG visitor rewrite ([#392](https://github.com/optave/ops-codegraph-tool/pull/392)) eliminated the Mode A/B split, replaced the 813-line `buildFunctionCFG` with a node-level visitor, and derives cyclomatic complexity directly from CFG structure (`E - N + 2`). `cfg.js` reduced from 1,242 → 518 lines.

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
- ✅ CFG visitor rewrite — node-level DFS visitor replaces statement-level `buildFunctionCFG`, Mode A/B split eliminated ([#392](https://github.com/optave/ops-codegraph-tool/pull/392))
- ✅ Cyclomatic complexity derived from CFG (`E - N + 2`) — single source of truth for control flow metrics ([#392](https://github.com/optave/ops-codegraph-tool/pull/392))

**Affected files:** `src/complexity.js`, `src/cfg.js`, `src/dataflow.js`, `src/ast.js` → split into `src/ast-analysis/`

### 3.2 -- Command/Query Separation ★ Critical ✅

CLI display wrappers extracted from all 19 analysis modules into dedicated `src/commands/` files. Shared infrastructure (`result-formatter.js`, `test-filter.js`) moved to `src/infrastructure/`. `*Data()` functions remain in original modules — MCP dynamic imports unchanged. ~1,059 lines of CLI formatting code separated from analysis logic ([#373](https://github.com/optave/ops-codegraph-tool/pull/373), [#393](https://github.com/optave/ops-codegraph-tool/pull/393)).

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
- ✅ CLI wrappers extracted from remaining 15 modules into `src/commands/` ([#393](https://github.com/optave/ops-codegraph-tool/pull/393))
- ✅ Per-command `src/commands/` directory structure ([#393](https://github.com/optave/ops-codegraph-tool/pull/393))
- ✅ `src/infrastructure/` directory for shared utilities ([#393](https://github.com/optave/ops-codegraph-tool/pull/393))
- ⏭️ `CommandRunner` shared lifecycle — deferred (command files vary too much for a single pattern today)

**Affected files:** All 19 modules with dual-function pattern, `src/cli.js`, `src/mcp.js`

### 3.3 -- Repository Pattern for Data Access ★ Critical ✅

> **v3.1.1 progress:** `src/db/` directory created with `repository.js` (134 lines), `query-builder.js` (280 lines), and `migrations.js` (312 lines). All db usage across the codebase wrapped in try/finally for reliable `db.close()` ([#371](https://github.com/optave/ops-codegraph-tool/pull/371), [#384](https://github.com/optave/ops-codegraph-tool/pull/384), [#383](https://github.com/optave/ops-codegraph-tool/pull/383)).
>
> **v3.1.2 progress:** `repository.js` split into `src/db/repository/` directory with 10 domain files (nodes, edges, build-stmts, complexity, cfg, dataflow, cochange, embeddings, graph-read, barrel). Raw SQL migrated from 14 src/ modules into repository layer. `connection.js` already complete (89 lines handling open/close/WAL/pragma/locks/readonly).
>
> **v3.1.3 progress:** Extracted `cachedStmt` utility into `src/db/repository/cached-stmt.js` — reusable prepared statement caching for hot-path repository functions ([#417](https://github.com/optave/ops-codegraph-tool/pull/417), [#402](https://github.com/optave/ops-codegraph-tool/pull/402)).

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

> **v3.1.1 progress:** `queries.js` reduced from 3,395 → 2,490 lines by extracting all CLI formatting to `queries-cli.js` (3.2). Symbol kind constants extracted to `kinds.js` (49 lines) ([#378](https://github.com/optave/ops-codegraph-tool/pull/378)).

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

Monolithic 1,525-line `src/cli.js` split into `src/cli/` with auto-discovery of command modules. 40 independently testable command files in `src/cli/commands/`, each exporting `{ name, description, options, queryOpts, validate, execute }`. Shared utilities extracted to `src/cli/shared/` (query options, output formatting). `src/cli/index.js` provides `registerCommand()` + `discoverCommands()` — new commands are added by dropping a file into `commands/`. `src/cli.js` reduced to an 8-line thin wrapper ([#427](https://github.com/optave/ops-codegraph-tool/pull/427)).

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

- ✅ Extracted into `src/embeddings/` with `index.js`, `models.js`, `generator.js` (v3.1.4, [#433](https://github.com/optave/ops-codegraph-tool/pull/433))
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

- ✅ `InMemoryRepository` at `src/db/repository/in-memory-repository.js` (v3.1.4, [#444](https://github.com/optave/ops-codegraph-tool/pull/444))
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

- ✅ Extract rendering logic from `viewer.js` (v3.1.4, [#443](https://github.com/optave/ops-codegraph-tool/pull/443))
- ✅ Extract serialization from `export.js` — DOT/Mermaid/JSON writers become pure data → string transforms
- ✅ Extract table formatting helpers used across `queries-cli.js`, `complexity`, `stats`
- ✅ Move `result-formatter.js` from `infrastructure/` to `presentation/`
- ✅ Extract Mermaid rendering from `sequence.js` into `sequence-renderer.js`

**Affected files:** `src/viewer.js`, `src/export.js`, `src/sequence.js`, `src/infrastructure/result-formatter.js`

### 3.15 -- Domain Directory Grouping ✅

**Completed:** `src/` reorganized into `domain/`, `features/`, and `presentation/` layers ([#456](https://github.com/optave/ops-codegraph-tool/pull/456), [#458](https://github.com/optave/ops-codegraph-tool/pull/458)). Three post-reorganization issues (circular imports, barrel exports, path corrections) resolved in [#459](https://github.com/optave/ops-codegraph-tool/pull/459). MCP server import path fixed in [#466](https://github.com/optave/ops-codegraph-tool/pull/466). Complexity/CFG/dataflow analysis restored after the move in [#469](https://github.com/optave/ops-codegraph-tool/pull/469).

```
src/domain/
  graph/                 # builder.js, resolve.js, cycles.js, watcher.js, journal.js, change-journal.js
  analysis/              # symbol-lookup.js, impact.js, dependencies.js, module-map.js,
                         # context.js, exports.js, roles.js
  search/                # embedder subsystem (models, generator, stores, search strategies)
  parser.js              # tree-sitter WASM wrapper + LANGUAGE_REGISTRY
  queries.js             # Query functions (symbol search, file deps, impact analysis)
```

- ✅ Move builder pipeline modules to `domain/graph/` ([#456](https://github.com/optave/ops-codegraph-tool/pull/456))
- ✅ Move decomposed query modules (from 3.4) to `domain/analysis/` ([#456](https://github.com/optave/ops-codegraph-tool/pull/456))
- ✅ Move embedder subsystem (from 3.10) to `domain/search/` ([#456](https://github.com/optave/ops-codegraph-tool/pull/456))
- ✅ Move remaining flat files (`features/`, `presentation/`, `infrastructure/`, `shared/`) into subdirectories ([#458](https://github.com/optave/ops-codegraph-tool/pull/458))
- ✅ Update all import paths across codebase ([#456](https://github.com/optave/ops-codegraph-tool/pull/456), [#458](https://github.com/optave/ops-codegraph-tool/pull/458), [#459](https://github.com/optave/ops-codegraph-tool/pull/459))

**Prerequisite:** 3.2, 3.4, 3.9, 3.10 should be complete before this step — it organizes the results of those decompositions.

### 3.16 -- CLI Composability ✅

**Completed:** `openGraph(opts)` helper eliminates DB-open/close boilerplate across CLI commands. `resolveQueryOpts(opts)` extracts the 5 repeated option fields into one call, refactoring 20 command files. Universal output formatter extended with `--table` (auto-column aligned) and `--csv` (RFC 4180 with nested object flattening) output formats ([#461](https://github.com/optave/ops-codegraph-tool/pull/461)).

- ✅ **`openGraph()` helper** — single helper returning `{ db, rootDir, config }` with engine selection, config loading, and cleanup ([#461](https://github.com/optave/ops-codegraph-tool/pull/461))
- ✅ **Universal output formatter** — `outputResult()` extended with `--table` and `--csv` formats; `resolveQueryOpts()` extracts repeated option fields ([#461](https://github.com/optave/ops-codegraph-tool/pull/461))

**Affected files:** `src/cli/commands/*.js`, `src/cli/shared/`, `src/presentation/result-formatter.js`

---

## Phase 4 -- Resolution Accuracy ✅

> **Status:** Complete -- all 6 sub-phases shipped across v3.2.0 → v3.3.1

**Goal:** Close the most impactful gaps in call graph accuracy before investing in type safety or native acceleration. The entire value proposition — blast radius, impact analysis, dependency chains — rests on the call graph. These targeted improvements make the graph trustworthy.

**Why before TypeScript:** These fixes operate on the existing JS codebase and produce measurable accuracy gains immediately. TypeScript types will further improve resolution later, but receiver tracking, dead role fixes, and precision benchmarks don't require types to implement.

### ~~4.1 -- Fix "Dead" Role Sub-categories~~ ✅

The coarse `dead` role is now sub-classified into four categories: `dead-leaf` (parameters, properties, constants), `dead-entry` (CLI commands, MCP tools, route/handler files), `dead-ffi` (cross-language FFI — `.rs`, `.c`, `.go`, etc.), and `dead-unresolved` (genuinely unreferenced callables). The `--role dead` filter matches all sub-roles for backward compatibility. Risk weights are tuned per sub-role. `VALID_ROLES`, `DEAD_SUB_ROLES` exported from `shared/kinds.js`. Stats, MCP `node_roles`, CLI `roles`/`triage` all updated.

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

### 4.3 -- Interface and Trait Implementation Tracking ✅

Extract `implements`/`extends`/trait-impl relationships from tree-sitter AST and store as `implements` edges. When an interface signature changes, all implementors appear in impact analysis.

**Implemented:**
- ✅ `codegraph implementations <interface>` command — all concrete types implementing a given interface/trait
- ✅ `codegraph interfaces <class>` command — what a type implements (inverse query)
- ✅ Covers: TypeScript interfaces, Java interfaces/abstract classes, Go interfaces (structural matching), Rust traits, C# interfaces, PHP interfaces, Ruby module inclusion
- ✅ `fn-impact` and `diff-impact` include implementors in blast radius by default (`--include-implementations`, on by default)
- ✅ `bfsTransitiveCallers` seeds interface/trait nodes with their implementors and traverses them transitively
- ✅ `contextData` includes `implementors` for interface/trait nodes and `implements` for class/struct nodes
- ✅ Go structural interface matching: post-extraction pass matches struct method sets against interface method sets (file-local)
- ✅ C# base type disambiguation: post-walk pass reclassifies `extends` entries as `implements` when target is a known same-file interface; also fixed `base_list` lookup (`findChild` fallback for tree-sitter-c-sharp grammar)
- ✅ DB layer: `findImplementors(db, nodeId)` and `findInterfaces(db, nodeId)` with cached prepared statements
- ✅ MCP tools: `implementations` and `interfaces` tools registered in tool registry
- ✅ TypeScript type definitions updated: `ImplementationsResult`, `InterfacesResult`, `Repository.findImplementors/findInterfaces`
- ✅ Integration tests: 13 tests covering `implementationsData`, `interfacesData`, `contextData` with implementation info, and `fnImpactData` with/without implementors

**Affected files:** `src/extractors/go.js`, `src/extractors/csharp.js`, `src/domain/graph/builder/stages/build-edges.js`, `src/domain/analysis/impact.js`, `src/domain/analysis/implementations.js`, `src/db/repository/edges.js`, `src/cli/commands/implementations.js`, `src/cli/commands/interfaces.js`, `src/mcp/tools/implementations.js`, `src/mcp/tools/interfaces.js`, `src/presentation/queries-cli/inspect.js`, `src/types.ts`

### ~~4.4 -- Call Resolution Precision/Recall Benchmark Suite~~ ✅

Hand-annotated fixture projects per language with `expected-edges.json` manifests. Benchmark runner compares codegraph's resolved edges against expected, reports precision and recall. CI gate fails if metrics drop below baseline. Child-process isolation prevents state leaks between benchmark runs.

- ✅ `tests/benchmarks/resolution/` with per-language fixtures and expected-edges manifests
- ✅ Benchmark runner with precision/recall reporting per language and resolution mode
- ✅ CI gate on accuracy regression
- ✅ Child-process isolation for benchmark builds ([#512](https://github.com/optave/ops-codegraph-tool/pull/512))

**New directory:** `tests/benchmarks/resolution/` ([#507](https://github.com/optave/ops-codegraph-tool/pull/507))

### ~~4.5 -- `package.json` Exports Field Resolution~~ ✅

Import resolution now reads `package.json` `exports` field for conditional exports, subpath patterns, and package self-references. Falls back to filesystem probing only when `exports` is absent.

- ✅ Parse `package.json` `exports` field during import resolution
- ✅ Support subpath patterns (`"./lib/*": "./src/*.js"`)
- ✅ Support conditional exports (`"import"`, `"require"`, `"default"`)
- ✅ Fallback to filesystem probing when `exports` field is absent

**Affected files:** `src/domain/graph/resolve.js` ([#509](https://github.com/optave/ops-codegraph-tool/pull/509))

### ~~4.6 -- Monorepo Workspace Resolution~~ ✅

npm workspaces (`package.json` `workspaces`), `pnpm-workspace.yaml`, and `lerna.json` are now recognized. Internal package imports (`@myorg/utils`) resolve to actual source files with high confidence (0.95).

> **Scope note:** This phase covers the *resolution layer only* — detecting workspace packages and resolving internal imports to source files. Full monorepo graph support (package node type, cross-package edges, `build --workspace` flag) is deferred to Phase 14.2.

- ✅ Detect workspace root and enumerate workspace packages
- ✅ Resolve internal package imports to actual source files within the monorepo
- ✅ High confidence (0.95) for workspace-resolved imports

**Affected files:** `src/domain/graph/resolve.js`, `src/infrastructure/config.js` ([#509](https://github.com/optave/ops-codegraph-tool/pull/509))

---

## Phase 5 -- TypeScript Migration ✅

> **Status:** Complete — all 271 source files migrated to TypeScript, 0 `.js` files remaining (v3.4.0)

**Goal:** Migrate the codebase from plain JavaScript to TypeScript, leveraging the clean module boundaries established in Phase 3. Incremental module-by-module migration starting from leaf modules inward.

**Why after Phase 4:** The resolution accuracy work (Phase 4) operates on the existing JS codebase and produces immediate accuracy gains. TypeScript migration builds on Phase 3's clean module boundaries to add type safety across the entire codebase. Every subsequent phase benefits from types: MCP schema auto-generation, API contracts, refactoring safety. The Phase 4 resolution improvements (receiver tracking, interface edges) establish the resolution model that TypeScript types will formalize.

**Note:** Migration is complete as of v3.4.0. All 271 source files are TypeScript. The migration proceeded leaf-inward: shared utilities → core domain → graph algorithms → builder stages → search → CLI layer → AST analysis → features → presentation → MCP tools → tests.

### ~~5.1 -- Project Setup~~ ✅

TypeScript project configured with strict mode, ES module output, path aliases, incremental compilation, and `dist/` build output with source maps. Biome configured for `.ts` files. `package.json` `exports` point to compiled output.

- ✅ `typescript` devDependency, `tsconfig.json` with strict mode
- ✅ Build pipeline emitting to `dist/` with source maps
- ✅ `tsc --noEmit` CI type-checking gate
- ✅ Incremental compilation enabled

**Affected files:** `package.json`, `biome.json`, new `tsconfig.json` ([#508](https://github.com/optave/ops-codegraph-tool/pull/508))

### ~~5.2 -- Core Type Definitions~~ ✅

Comprehensive TypeScript type definitions for the entire domain model — symbols, edges, nodes, config, queries, analysis results, MCP tools, and all Phase 3 abstractions.

- ✅ `SymbolNode`, `Edge`, `SymbolKind`, `EdgeKind`, `ASTNodeKind` types
- ✅ `Repository`, `Engine`, `ASTVisitor`, `Extractor`, `Command` interfaces
- ✅ Config, query options, analysis result types
- ✅ Narrowed edge kind types and `ExtendedSymbolKind` method

**New file:** `src/types.ts` ([#516](https://github.com/optave/ops-codegraph-tool/pull/516))

### ~~5.3 -- Leaf Module Migration~~ ✅

Migrate modules with no or minimal internal dependencies. All 29 modules migrated.

**Migrated (29):** `shared/errors`, `shared/kinds`, `shared/normalize`, `shared/paginate`, `shared/constants`, `shared/file-utils`, `shared/generators`, `shared/hierarchy`, `infrastructure/logger`, `infrastructure/config`, `infrastructure/native`, `infrastructure/registry`, `infrastructure/update-check`, `infrastructure/result-formatter`, `infrastructure/test-filter`, `db/repository/*` (14 files), `db/connection`, `db/index`, `db/migrations`, `db/query-builder`, `domain/analysis/*` (9 files), `presentation/colors`, `presentation/table` — via [#553](https://github.com/optave/ops-codegraph-tool/pull/553), [#566](https://github.com/optave/ops-codegraph-tool/pull/566)

### ~~5.4 -- Core Module Migration~~ ✅

All core domain modules migrated: builder stages, search subsystem, graph utilities, incremental rebuild logic.

**Migrated:** `db/repository/*.ts` (14 files), `domain/parser.ts`, `domain/graph/resolve.ts`, `extractors/*.ts` (11 files), `domain/graph/builder.ts` + `context.ts` + `helpers.ts` + `pipeline.ts`, `domain/graph/watcher.ts`, `domain/search/` (all files), `graph/` (all files), `domain/queries.ts`, `domain/graph/builder/stages/` (all 9 stages), `domain/graph/{cycles,journal,change-journal}.ts`

**Key PRs:** [#554](https://github.com/optave/ops-codegraph-tool/pull/554), [#570](https://github.com/optave/ops-codegraph-tool/pull/570), [#579](https://github.com/optave/ops-codegraph-tool/pull/579)

### ~~5.5 -- Orchestration & Public API Migration~~ ✅

All orchestration, features, presentation, MCP, and CLI modules migrated — including 48 CLI command handlers.

**Migrated:** `cli.ts` + `cli/` (all 55 files), `index.ts`, `ast-analysis/` (all 18 files), `features/` (all 20 files), `presentation/` (all 28 files), `mcp/` + `mcp/tools/` (all files). All stale `.js` counterparts deleted.

**Key PRs:** [#555](https://github.com/optave/ops-codegraph-tool/pull/555), [#558](https://github.com/optave/ops-codegraph-tool/pull/558), [#580](https://github.com/optave/ops-codegraph-tool/pull/580), [#581](https://github.com/optave/ops-codegraph-tool/pull/581)

### ~~5.6 -- Test Migration~~ ✅

All test files migrated from `.js` to `.ts`. Vitest TypeScript integration verified. `tsc --noEmit` succeeds with zero errors. No `any` escape hatches except at FFI boundaries (napi-rs addon, tree-sitter WASM).

**Key PRs:** [#588](https://github.com/optave/ops-codegraph-tool/pull/588)

---

## Phase 6 -- Native Analysis Acceleration

**Goal:** Make `--engine native` meaningfully faster than WASM across every build phase. At the start of this phase, only 3 of 10 build phases (parse, resolve imports, build edges) ran in Rust — the other 7 executed identical JavaScript regardless of engine. The extraction side (6.1–6.3, 6.6) is done — Rust extracts AST nodes, CFG, dataflow, and complexity during the parse phase, and the JS visitors are bypassed on native builds. But the **DB-writing phases** that consume that extracted data still run identical JS code on both engines, so native full builds show little-to-no speedup over WASM on most phases.

**Why its own phase:** This is a substantial Rust engineering effort — porting JS visitors to `crates/codegraph-core/`, fixing a data loss bug in incremental rebuilds, and optimizing the 1-file rebuild path. With TypeScript types (Phase 5) defining the interface contracts, the Rust ports can target well-typed boundaries. The Phase 3 module boundaries make each phase a self-contained target.

**Current state (full-build: v3.3.1, 442 files · 1-file: v3.4.0, 473 files):**

| Phase | Native (full) | WASM (full) | Speedup | Native (1-file) | WASM (1-file) | Status |
|-------|------:|------:|:-------:|------:|------:|--------|
| Parse | 601ms | 2123ms | **3.5×** | 57ms | 201ms | Rust ✅ — real speedup |
| Build edges | 108ms | 167ms | 1.5× | 21ms | 15ms | Rust ✅ — modest; native *slower* on 1-file |
| Resolve imports | 12ms | 13ms | ~same | 2ms | 2ms | Rust ✅ — no meaningful difference |
| AST nodes | **393ms** | 397ms | **~same** | 0.2ms | 0.2ms | Rust ✅ — native rusqlite bulk insert (PR #651) |
| CFG | **161ms** | 155ms | **Rust slower** | 0.1ms | 0.1ms | Rust ✅ — native rusqlite bulk insert (PR #653) |
| Dataflow | **125ms** | 129ms | **~same** | 0.1ms | 0.2ms | Rust ✅ — native rusqlite bulk insert (PR #653) |
| Insert nodes | 206ms | 201ms | ~same | 8ms | 8ms | Rust ✅ — native rusqlite pipeline (PR #654) |
| Complexity | 171ms | 216ms | 1.3× | 0.1ms | 0.1ms | Rust pre-computation ✅; modest speedup |
| Roles | 52ms | 52ms | ~same | 54ms | 55ms | Rust ✅ — native rusqlite roles + edges (PR #658) |
| Structure | 22ms | 21ms | ~same | 26ms | 24ms | JS ✅ — already fast |
| **Total** | **2.7s** | **5.0s** | **1.85×** | **466ms** | **611ms** | Parse carries most of the speedup |

*Note: Phase totals above sum to ~1.85s (native) / ~3.47s (WASM) for full builds and ~168ms / ~305ms for 1-file rebuilds. The remaining time is spent in phases not listed here: startup/initialization, dependency resolution setup, build-dependencies, finalize (orphan cleanup, unused-export marking), and CLI overhead.*

**Key insight:** The 1.85× native speedup comes almost entirely from the Parse phase (3.5×). The other 9 phases combined show negligible native advantage because they execute the same JS/SQL code regardless of engine. The Rust extraction work (6.1–6.3, 6.6) successfully bypasses the JS *visitors* on native, but the *DB insertion loops* that store AST nodes, CFG edges, dataflow edges, and complexity rows are identical — they iterate over the extracted data in JS either way. To unlock real native speedup on these phases, the DB writes themselves need to move to Rust or be radically restructured.

*Note:* The `dataflowMs`, `cfgMs`, `astMs`, and `complexityMs` timings on full builds measure the DB edge/node-building phase, not the visitor walk. On 1-file rebuilds the JS visitor is fully bypassed (0.1–0.2ms) because the data was extracted during parse.

### 6.1 -- AST Node Extraction in Rust ✅

**Complete.** All 6 AST node types (`call`, `new`, `string`, `regex`, `throw`, `await`) are extracted in Rust during the native parse phase. The JS `ast-store` visitor is bypassed when `symbols.astNodes` is already an array. Parity validated via `tests/engines/ast-parity.test.ts`.

**Key PRs:** #340, #361, #591

### 6.2 -- CFG Construction in Rust ✅

**Complete.** `crates/codegraph-core/src/cfg.rs` computes per-function CFG blocks and edges for all 11 languages. `Definition.cfg` is populated during native parse. The JS CFG visitor is bypassed when `d.cfg?.blocks` exists. Parity validated via `tests/engines/cfg-parity.test.ts`.

**Key PRs:** #342, #344

### 6.3 -- Dataflow Analysis in Rust ✅

**Complete.** `crates/codegraph-core/src/dataflow.rs` implements `extract_dataflow()` with full scope tracking, binding resolution, and confidence scoring for all 11 languages. `FileSymbols.dataflow` is populated when `include_dataflow=true`. The JS dataflow visitor is bypassed when `symbols.dataflow` exists. Parity validated via `tests/engines/dataflow-parity.test.ts` (13 tests across Go, Rust, Ruby).

### 6.4 -- Batch SQLite Inserts ✅

**Complete (JS-side approach).** Batch inserts use `better-sqlite3` multi-value INSERT statements with cached prepared statements (keyed by chunk size to avoid recompilation). Chunk size tuned to 500 rows. Export marking uses batched `UPDATE ... WHERE (name=? AND kind=? AND file=? AND line=?) OR ...` instead of per-export UPDATEs. The insert-nodes stage shares `bulkNodeIdsByFile` maps between children and edge phases. A Rust-side approach was evaluated but JS-side batching proved sufficient — the bottleneck is SQLite I/O, not JS↔native boundary crossings.

**Result:** Native full-build insertMs **429ms → 310ms** (−28%) as of 6.4; further reduced to **206ms** after v3.3.1 optimizations.

**Key PRs:** #361, #434

### 6.5 -- Role Classification & Structure Optimization ✅

**Complete (JS-side approach).** Role classification stays JS/SQL-based — the bottleneck is SQL query execution, not classification logic (which is simple median-threshold comparisons). The optimization replaces row-by-row `UPDATE nodes SET role = ? WHERE id = ?` (one statement per node, ~10k nodes) with batch `UPDATE nodes SET role = ? WHERE id IN (...)` grouped by role (~10 statements total). This eliminates ~10k SQLite B-tree lookups in favor of ~10 set-based updates.

Structure building is unchanged — at 22ms it's already fast.

**Result:** Native full-build rolesMs **268ms → 192ms** (−28%) as of 6.5; further reduced to **52ms** after v3.3.1 optimizations. Native 1-file rebuild rolesMs **301ms → 36ms** (−88%) as of 6.5; further reduced to **9ms** via 6.8 incremental path (PR #622).

### 6.6 -- Complete Complexity Pre-computation ✅

**Complete.** `crates/codegraph-core/src/complexity.rs` computes cognitive, cyclomatic, max nesting, Halstead, and LOC metrics for every function during native parse. `Definition.complexity` is populated for all functions/methods. The JS complexity visitor is bypassed when `!d.complexity` check passes. MI is computed JS-side from the pre-computed components.

### 6.7 -- Fix Incremental Rebuild Data Loss on Native Engine ✅

**Complete.** The original bug (analysis data silently lost on native 1-file rebuilds) is fixed. The prerequisites (6.1–6.3) are done — native parse now returns complete AST nodes, CFG blocks, and dataflow edges in `FileSymbols`. The unified analysis engine (`src/ast-analysis/engine.ts`) skips per-visitor creation when native data exists, and `buildDataflowEdges`/`buildCFGData`/`buildComplexityMetrics` all check for pre-computed data before falling back to WASM. Edge parity on incremental rebuilds is validated via `tests/engines/` and CI (#539, #542).

**Key PRs:** #469, #533, #539, #542

### 6.8 -- Incremental Rebuild Performance ✅

**Complete.** Sub-100ms incremental rebuilds achieved: **466ms → 67–80ms** on 473 files (PR #644). Roles classification optimized (255ms → 9ms via incremental path, PR #622). Structure batching, finalize skip, and compound DB indexes all done (PR #632).

**Done:**
- **Incremental roles** (255ms → 9ms): Only reclassify nodes from changed files + edge neighbours using indexed correlated subqueries. Global medians for threshold consistency. Parity-tested against full rebuild. *Note:* The benchmark table shows ~54ms for 1-file roles because the standard benchmark runs the full roles phase; the 9ms incremental path (PR #622) is used only when the builder detects a 1-file incremental rebuild
- **Structure batching:** Replace N+1 per-file queries with 3 batch queries regardless of file count
- **Finalize skip:** Skip advisory queries (orphaned embeddings, unused exports) during incremental builds
- **DB index regression:** Compound indexes on nodes/edges tables restored after TS migration (PR #632)

**Result:** Native 1-file incremental rebuilds: **466ms → 67–80ms** (target was sub-100ms). Roles incremental path: **255ms → 9ms** via edge-neighbour expansion with indexed correlated subqueries.

**Key PRs:** #622, #632, #644

**Affected files:** `src/domain/graph/builder/stages/build-structure.ts`, `src/domain/graph/builder/stages/build-edges.ts`, `src/domain/graph/builder/pipeline.ts`

### 6.9 -- AST Node DB Write Optimization ✅

**Complete.** Bulk AST node inserts via native Rust/rusqlite. The `bulk_insert_ast_nodes` napi-rs function receives the AST node array and writes directly to SQLite via `rusqlite` multi-row INSERTs, bypassing the JS iteration loop entirely.

**Key PRs:** #651

### 6.10 -- CFG & Dataflow DB Write Optimization ✅

**Complete.** Bulk CFG block/edge and dataflow edge inserts via native Rust/rusqlite. Same approach as 6.9 — `rusqlite` multi-row INSERTs bypass the JS iteration loop for both CFG and dataflow writes.

**Key PRs:** #653

### 6.11 -- Native Insert Nodes Pipeline ✅

**Complete.** Native Rust/rusqlite pipeline for node insertion. The entire insert-nodes loop runs in Rust — receives `FileSymbols[]` via napi-rs and writes nodes, children, and edge stubs directly to SQLite via `rusqlite`, eliminating JS↔native boundary crossings.

**Key PRs:** #654

### 6.12 -- Native Roles & Edge Build Optimization ✅

**Complete.** Native Rust/rusqlite for both role classification and edge insertion. Role classification SQL moved to Rust — fan-in/fan-out aggregation + median-threshold classification in a single Rust function. Edge building uses `bulkInsertEdges` via rusqlite with chunked multi-row INSERTs. Includes `classifyRolesIncremental` for the 1-file rebuild path and `classify_dead_sub_role` for dead-entry detection.

**Key PRs:** #658

### 6.13 -- NativeDatabase Class (rusqlite Connection Lifecycle) ✅

**Complete.** `NativeDatabase` napi-rs class in `crates/codegraph-core/src/native_db.rs` holding a persistent `rusqlite::Connection`. Factory methods (`openReadWrite`/`openReadonly`), lifecycle (`close`/`exec`/`pragma`), schema migrations (`initSchema` with all 16 migrations embedded), and build metadata KV (`getBuildMeta`/`setBuildMeta`). Wired into the build pipeline: when native engine is available, `NativeDatabase` handles schema init and metadata reads/writes. Foundation for 6.14+ which migrates all query and write operations to rusqlite on the native path.

**Key PRs:** #666

### 6.14 -- Native Read Queries (Repository Migration) ✅

**Complete.** All Repository read methods migrated to Rust via `NativeDatabase`. `NativeRepository extends Repository` delegates all methods to `NativeDatabase` napi calls. `NodeQuery` fluent builder replicated in Rust for dynamic filtering. `openRepo()` returns `NativeRepository` when native engine is available.

**Key PRs:** #671

### 6.15 -- Native Write Operations (Build Pipeline) ✅

**Complete.** All build-pipeline write operations migrated to `NativeDatabase` rusqlite. Consolidated scattered rusqlite usage from 6.9–6.12 into `NativeDatabase` methods. `batchInsertNodes`, `batchInsertEdges`, `purgeFilesData`, complexity/CFG/dataflow/co-change writes, `upsertFileHashes`, and `updateExportedFlags` all run via rusqlite on native. `PipelineContext` threads `NativeDatabase` through all build stages.

**Key PRs:** #669

### 6.16 -- Dynamic SQL & Edge Cases ✅

**Complete.** Generic parameterized query execution on NativeDatabase, connection lifecycle helpers, version validation, and `db.prepare()` audit.

**Delivered:**
- **`NativeDatabase.queryAll` / `queryGet`:** Generic parameterized SELECT execution via rusqlite, returning rows as JSON objects. Uses `serde_json::Value` for dynamic column support
- **`NodeQuery` native dispatch:** `all()` and `get()` accept optional `nativeDb` parameter for rusqlite execution. Combinatorial parity test suite covers all filter/JOIN/ORDER BY combinations
- **`NativeDatabase.validateSchemaVersion`:** Schema version check for future read-path callers
- **`closeDbPair` / `closeDbPairDeferred`:** Unified connection lifecycle helpers — close NativeDatabase first (fast), then better-sqlite3 (WAL checkpoint). Replaces manual close sequences in `finalize.ts` and `pipeline.ts`
- **Starter straggler migrations:** 3 build-pipeline reads in `detect-changes.ts` and `build-structure.ts` dispatch through `nativeDb` when available
- **`db.prepare()` audit:** 194 calls across 43 files documented in `docs/migration/db-prepare-audit.md` with tiered migration path (Tier 0 done, Tier 1 build pipeline next, Tiers 2-3 blocked on read-path NativeDatabase)

**Affected files:** `crates/codegraph-core/src/native_db.rs`, `src/db/connection.ts`, `src/db/query-builder.ts`, `src/db/repository/nodes.ts`, `src/types.ts`, `src/domain/graph/builder/stages/finalize.ts`, `src/domain/graph/builder/pipeline.ts`, `src/domain/graph/builder/stages/detect-changes.ts`, `src/domain/graph/builder/stages/build-structure.ts`

### 6.17 -- Cleanup & better-sqlite3 Isolation ✅

**Complete.** Lazy-load `better-sqlite3` via `createRequire` so it's never loaded on native-engine read paths. Removed 5 standalone `#[napi]` Rust functions (`bulk_insert_nodes`, `bulk_insert_edges`, `bulk_insert_ast_nodes`, `classify_roles_full`, `classify_roles_incremental`) — `NativeDatabase` methods delegate to the same `do_*` internals. Simplified fallback chains from 3-tier to 2-tier (NativeDatabase → JS). Tuned rusqlite: statement cache capacity 64, `mmap_size = 256MB`, `temp_store = MEMORY`. Extended build-parity test with roles and ast_nodes checks.

**Key PRs:** #673

---

## Phase 7 -- Expanded Language Support ✅

> **Status:** Complete -- shipped across v3.6.0 → v3.8.0

**Goal:** Support every major programming language that has a mature tree-sitter grammar available in both WASM (npm) and Rust (crates.io). This takes codegraph from 11 to 34 languages, covering every actively-used language where dependency and call-graph analysis is meaningful.

**Why before Analysis Depth:** Language expansion is largely mechanical (one registry entry + extractor per language) and unblocks users on languages codegraph doesn't yet support. Analysis depth (Phase 8) is a deeper investment that benefits all languages — existing and newly added — once it lands. Shipping breadth first maximizes the user base that benefits from the subsequent depth work.

### 7.1 -- Parser Abstraction Layer ✅

Extract shared patterns from existing extractors into reusable helpers to reduce per-language boilerplate from ~200 lines to ~80 lines.

| Helper | Purpose |
|--------|---------|
| ✅ `findParentNode(node, typeNames, nameField?)` | Walk parent chain to find enclosing class/struct |
| ✅ `extractBodyMembers(node, bodyFields, memberType, kind, nameField?, visibility?)` | Extract child declarations from a body block |
| ✅ `stripQuotes(text)` | Strip leading/trailing quotes from string literals |
| ✅ `lastPathSegment(path, separator?)` | Extract last segment of a delimited import path |

**File:** `src/extractors/helpers.ts` (extended existing helper module)

- `findParentNode` replaces 6 per-language `findParent*` functions (JS, Python, Java, C#, Ruby, Rust)
- `extractBodyMembers` replaces 5 body-iteration patterns (Rust struct/enum, Java enum, C# enum, PHP enum)
- `stripQuotes` + `lastPathSegment` replace inline `.replace(/"/g, '')` and `.split('.').pop()` patterns across 7 extractors

### 7.2 -- Batch 1: High Demand ✅

Major languages with official or widely-adopted tree-sitter grammars (millions of crate downloads).

- ✅ All 6 languages shipped in v3.6.0 ([#708](https://github.com/optave/ops-codegraph-tool/pull/708))

| Language | Extensions | Grammar | Org | Notes |
|----------|-----------|---------|-----|-------|
| C | `.c`, `.h` | `tree-sitter-c` | Official | 3.9M crate downloads |
| C++ | `.cpp`, `.hpp`, `.cc`, `.cxx` | `tree-sitter-cpp` | Official | 4.1M crate downloads |
| Kotlin | `.kt`, `.kts` | `tree-sitter-kotlin` | `fwcd/` | Major Android/multiplatform language |
| Swift | `.swift` | `tree-sitter-swift` | `alex-pinkus/` | iOS/macOS ecosystem |
| Scala | `.scala`, `.sc` | `tree-sitter-scala` | Official | JVM ecosystem, 1.5M crate downloads |
| Bash | `.sh`, `.bash` | `tree-sitter-bash` | Official | 2.6M crate downloads |

### 7.3 -- Batch 2: Growing Ecosystems ✅

Actively maintained grammars with both npm and Rust packages available.

- ✅ All 6 languages shipped in v3.7.0 ([#718](https://github.com/optave/ops-codegraph-tool/pull/718))

| Language | Extensions | Grammar | Org | Notes |
|----------|-----------|---------|-----|-------|
| Elixir | `.ex`, `.exs` | `tree-sitter-elixir` | `elixir-lang/` | Official Elixir org, 1.2M crate downloads |
| Lua | `.lua` | `tree-sitter-lua` | `tree-sitter-grammars/` | Neovim ecosystem, 1.2M crate downloads |
| Dart | `.dart` | `tree-sitter-dart` | Third-party | Flutter/mobile ecosystem |
| Zig | `.zig` | `tree-sitter-zig` | `tree-sitter-grammars/` | Growing systems language |
| Haskell | `.hs` | `tree-sitter-haskell` | Official | 1.0M crate downloads |
| OCaml | `.ml`, `.mli` | `tree-sitter-ocaml` | Official | ML family, mature grammar |

### 7.4 -- Batch 3: Functional & BEAM ✅

Languages with solid tree-sitter grammars and active communities.

- ✅ All 6 languages shipped in v3.8.0 ([#722](https://github.com/optave/ops-codegraph-tool/pull/722))

| Language | Extensions | Grammar | Org | Notes |
|----------|-----------|---------|-----|-------|
| F# | `.fs`, `.fsx`, `.fsi` | `tree-sitter-fsharp` | `ionide/` | .NET functional, Ionide community |
| Gleam | `.gleam` | `tree-sitter-gleam` | `gleam-lang/` | Official Gleam org, fastest-growing BEAM language |
| Clojure | `.clj`, `.cljs`, `.cljc` | `tree-sitter-clojure` | Third-party | JVM Lisp, active community |
| Julia | `.jl` | `tree-sitter-julia` | Official | Scientific computing |
| R | `.r`, `.R` | `tree-sitter-r` | `r-lib/` | Statistical computing, 135K crate downloads; WASM built from repo |
| Erlang | `.erl`, `.hrl` | `tree-sitter-erlang` | `WhatsApp/` | BEAM VM; WASM built from repo |

### 7.5 -- Batch 4: Specialized ✅

- ✅ All 5 languages shipped in v3.8.0 ([#729](https://github.com/optave/ops-codegraph-tool/pull/729))

| Language | Extensions | Grammar | Org | Notes |
|----------|-----------|---------|-----|-------|
| Solidity | `.sol` | `tree-sitter-solidity` | Third-party | Smart contracts, 787K crate downloads |
| Objective-C | `.m` | `tree-sitter-objc` | `tree-sitter-grammars/` | Apple legacy, 121K crate downloads |
| CUDA | `.cu`, `.cuh` | `tree-sitter-cuda` | `tree-sitter-grammars/` | C++ superset for GPU/ML, both npm + crate |
| Groovy | `.groovy`, `.gvy` | `tree-sitter-groovy` | Third-party | JVM, Gradle build scripts |
| Verilog/SystemVerilog | `.v`, `.sv` | `tree-sitter-verilog` | Official | HDL, 33K crate downloads |

> For languages where the npm package is name-squatted or missing (R, Erlang), WASM binaries can be built from the grammar repo via `tree-sitter build --wasm`.

---

## Phase 8 -- Analysis Depth ✅

> **Status:** Complete -- all 8 sub-phases shipped in v3.12.0

**Goal:** Raise caller coverage from 29% to ≥70% for TypeScript/JavaScript projects by investing in analysis depth — type-aware resolution, inter-procedural type propagation, and field-based points-to analysis. The [architecture audit (v3.4.0)](https://github.com/optave/ops-codegraph-tool/blob/main/generated/architecture/ARCHITECTURE_AUDIT_v3.4.0_2026-03-26.md) identified this as the single highest-impact investment: "A code intelligence tool that can only resolve callers for 29% of functions is fundamentally limited in the value it can provide." Every downstream feature — diff-impact, blast radius, dead code detection, community analysis — degrades proportionally with low caller coverage. **Depth over breadth.**

**Why after Expanded Language Support:** Language expansion (Phase 7) is largely mechanical and unblocks new users quickly. Once the language surface area is wide, the analysis depth work here benefits all 34 languages — not just the original 11. The architecture audit recommends investing in resolution accuracy as the single highest-impact improvement; sequencing it after breadth maximizes the number of languages that benefit from the improved pipeline.

**Research context:** This phase draws on techniques from Joern's [Code Property Graph](https://cpg.joern.io/) (unified AST + CFG + PDG with type edges and dispatch classification), [Jelly](https://github.com/cs-au-dk/jelly) (field-based points-to analysis with approximate interpretation for JS/TS), [ACG](https://arxiv.org/abs/2405.07206) (field-based call graph construction achieving 99% precision / 91% recall on benchmarks), and the TypeScript compiler API (`ts.createProgram` + type checker). The [comparative study of static JS call graphs](https://arxiv.org/abs/2405.07206) found that combining field-based analysis (ACG) with type analysis (TAJS) covers 99% of true edges at 98% precision — the hybrid approach codegraph should adopt.

### 8.1 -- TypeScript-Native Type Resolution

The single highest-ROI improvement. Currently codegraph treats TypeScript as "JavaScript with types" — all type annotations are ignored during import resolution and call graph construction. Integrating the TypeScript compiler API provides type information for free.

**Approach:**
- Use `ts.createProgram()` with the project's `tsconfig.json` to create a TypeScript program instance
- Access the type checker via `program.getTypeChecker()` for semantic type information
- For each call expression, resolve the actual declaration via `checker.getSymbolAtLocation()` → `symbol.declarations`
- For method calls on typed receivers, resolve through the type hierarchy: `checker.getTypeAtLocation(receiver)` → member lookup
- Handle `import type`, re-exports, path mappings (`paths`, `baseUrl`), and project references natively
- Run as a build-time enrichment pass: tree-sitter parses the AST (fast), then the TS checker resolves ambiguous edges (accurate)

**Expected impact:** +30–40 percentage points on caller coverage for `.ts`/`.tsx` files — the tool's primary use case. The TypeScript checker already knows every type, every import target, and every re-export chain. This eliminates the heuristic fallback for the majority of codegraph's target audience.

**Scope:** TypeScript and TSX files only. JavaScript files without type annotations continue using the existing resolution pipeline.

**Affected files:** new `src/domain/graph/resolver/ts-resolver.ts`, `src/domain/graph/builder/stages/build-edges.ts`, `src/infrastructure/config.ts`

**Progress (v3.12.0):**
- ✅ `src/domain/graph/resolver/ts-resolver.ts` — build-time enrichment pass using `ts.createProgram` + `getTypeChecker`; heuristic typeMap entries replaced with compiler-verified confidence 1.0 values ([#1278](https://github.com/optave/ops-codegraph-tool/pull/1278))
- ✅ Auto-enabled when `typescript` is installed and `tsconfig.json` is found — disable with `"build": { "typescriptResolver": false }` in `.codegraphrc.json` ([#1278](https://github.com/optave/ops-codegraph-tool/pull/1278))
- ✅ Native Rust engine: `returnTypeMap` and `callAssignments` extracted in Rust, closing the enrichment gap ([#1283](https://github.com/optave/ops-codegraph-tool/pull/1283))

### 8.2 -- Inter-Procedural Type Propagation

Extend type tracking beyond single-function scope. Currently, type information from Phase 4.2 (receiver type tracking) is purely intra-procedural — if `createUser()` returns a `User` object and the caller assigns it to a variable, the type is lost at the call boundary.

**Approach:**
- Build a **return-type map** during extraction: for each function, record its return type (from TS annotations, constructor `new` expressions, or inferred from return statements)
- When a call expression assigns to a variable (`const x = createUser()`), propagate the callee's return type to the caller's type map
- Chain propagation: if `getService().getRepo().findAll()`, resolve each receiver's type through the return-type chain
- Limit propagation depth to avoid combinatorial explosion (configurable, default: 3 hops)
- Track propagation confidence: direct annotation = 1.0, single-hop inference = 0.9, two-hop = 0.8, three-hop = 0.7

**Expected impact:** +10–15 percentage points on caller coverage. Method chains, factory patterns, and builder patterns are the primary beneficiaries.

**Affected files:** `src/extractors/*.ts` (return type extraction), `src/domain/graph/builder/stages/build-edges.ts` (propagation during edge construction)

**Progress (v3.12.0):**
- ✅ `extractReturnTypeMapWalk` added to JS/TS extractor — explicit TS annotations at confidence 1.0, `return new Constructor()` at 0.85 ([#1279](https://github.com/optave/ops-codegraph-tool/pull/1279))
- ✅ Intra-file propagation: `const x = createUser()` → `x` gets type `User`; chain resolution up to 3 hops with decaying confidence ([#1279](https://github.com/optave/ops-codegraph-tool/pull/1279))
- ✅ Cross-file propagation in `build-edges.ts`: unresolved call assignments resolved against imported files' `returnTypeMap`s before native and JS call-edge paths run ([#1279](https://github.com/optave/ops-codegraph-tool/pull/1279))
- ✅ `analysis.typePropagationDepth: 3` added to `DEFAULTS` for future tunability ([#1279](https://github.com/optave/ops-codegraph-tool/pull/1279))
- ✅ WASM worker protocol: `returnTypeMap`, `paramBindings`, `callAssignments` wired through `SerializedExtractorOutput` ([#1352](https://github.com/optave/ops-codegraph-tool/pull/1352))

### 8.3 -- Field-Based Points-To Analysis

Implement a lightweight field-based points-to analysis inspired by [ACG](https://arxiv.org/abs/2405.07206) and [Jelly](https://github.com/cs-au-dk/jelly). This resolves higher-order function calls (callbacks, event handlers, strategy patterns) that syntactic analysis completely misses.

**What it solves:** When `app.use(authMiddleware)` or `events.on('click', handler)` passes a function reference, the current extractor sees only a variable name — not the function it points to. Points-to analysis tracks what values flow into function-typed variables.

**Progress (v3.9.4):**
- ✅ Lightweight name-based callback resolution for JS/TS — identifier and member_expression arguments of call expressions emit dynamic call edges; destructured bindings from factory calls emit function definitions so the edge resolver can match them as call targets ([#947](https://github.com/optave/ops-codegraph-tool/pull/947))

**Progress (v3.12.0):**
- ✅ Field-based points-to analysis for higher-order calls (Phase 8.3) — callback assignments, event-handler registrations, strategy-pattern wiring ([#1289](https://github.com/optave/ops-codegraph-tool/pull/1289))
- ✅ Cross-module points-to propagation (Phase 8.3 + 8.3b) — WASM + native parity; inter-module flows through import edges ([#1296](https://github.com/optave/ops-codegraph-tool/pull/1296))
- ✅ Parameter-flow tracking (Phase 8.3c) — typed parameters seed the receiver typeMap for downstream method resolution ([#1294](https://github.com/optave/ops-codegraph-tool/pull/1294), [#1308](https://github.com/optave/ops-codegraph-tool/pull/1308))
- ✅ Object property write tracking (Phase 8.3d) — `obj.handler = fn` tracked so `obj.handler()` resolves ([#1295](https://github.com/optave/ops-codegraph-tool/pull/1295))
- ✅ Constructor-assigned property types (Phase 8.3e scope folded into 8.3 family without a separate label) — `this.svc = new Service()` seeds the typeMap so `this.svc.call()` resolves; landed in ([#1314](https://github.com/optave/ops-codegraph-tool/pull/1314)) alongside the 8.3d work
- ✅ Object destructuring rest parameter resolution (Phase 8.3f) — `const { a, ...rest } = obj; rest.method()` resolved via the rest binding's source type; WASM + native ([#1355](https://github.com/optave/ops-codegraph-tool/pull/1355))
- ✅ Prototype-based method calls, func-prop this-dispatch, spread/iteration callbacks ([#1331](https://github.com/optave/ops-codegraph-tool/pull/1331))
- ✅ Constructor-assigned property types for receiver-typed resolution (JS/TS) ([#1314](https://github.com/optave/ops-codegraph-tool/pull/1314))
- ✅ `Object.defineProperty` accessor this-dispatch ([#1346](https://github.com/optave/ops-codegraph-tool/pull/1346), [#1351](https://github.com/optave/ops-codegraph-tool/pull/1351))
- ✅ Calls through `Object.defineProperty` / `defineProperties` / `Object.create` ([#1328](https://github.com/optave/ops-codegraph-tool/pull/1328))
- ✅ Generator functions extracted as definitions (JS/TS) ([#1333](https://github.com/optave/ops-codegraph-tool/pull/1333))
- ✅ `.call()/.apply()` this-rebinding ([#1405](https://github.com/optave/ops-codegraph-tool/pull/1405))
- ✅ `Function.bind/call/apply` receiver-typed resolution ([#1330](https://github.com/optave/ops-codegraph-tool/pull/1330))
- ✅ `for-of`, `Set`, and `Array.from` iteration-callback edges ([#1397](https://github.com/optave/ops-codegraph-tool/pull/1397))
- ✅ Inline-array spread call edges `fn(...[a, b, c])` ([#1394](https://github.com/optave/ops-codegraph-tool/pull/1394))
- 🔲 Full allocation-site abstraction and constraint solver (fixed-point iteration over points-to constraints)

**Approach:**
- **Field-based** (not field-sensitive): treat all instances of `obj.field` as the same abstract location regardless of which `obj` instance. This is the sweet spot between precision and scalability — ACG achieves 99% precision with this approach
- **Allocation-site abstraction:** each `new Foo()`, function literal, or arrow function creates an abstract object tagged with its source location
- **Assignment propagation:** track flows through assignments (`x = y`), parameter passing (`f(callback)`), and returns (`return handler`)
- **Constraint solver:** fixed-point iteration over the points-to constraints until no new flows are discovered. Bound iterations to prevent divergence on pathological cases (configurable, default: 50 iterations)
- **Scope:** intra-module first (8.3a), cross-module via import edges second (8.3b)

**Expected impact:** +5–10 percentage points on caller coverage, primarily for callback-heavy code (Express/Koa middleware, React event handlers, Node.js EventEmitter patterns).

**Affected files:** new `src/domain/graph/resolver/points-to.ts`, `src/domain/graph/builder/stages/build-edges.ts`

### 8.4 -- Barrel File & Re-Export Chain Resolution

Barrel files (`index.ts` that re-export from sub-modules) are the #1 source of resolution failures in real TypeScript projects. The current 6-level priority system doesn't trace re-export chains, causing symbols imported through barrels to resolve to the barrel file itself rather than the actual declaration.

**Approach:**
- During the build phase, construct a **re-export graph**: for each `export { X } from './sub'` or `export * from './sub'`, record the re-export edge
- When resolving an import that points to a barrel file, walk the re-export graph transitively to find the actual declaration file
- Cache the resolved chains (most projects have <100 barrel files, so the re-export graph is small)
- Handle circular re-exports with a visited set
- Integrate with 8.1 (TS resolver already knows re-export chains; this sub-phase handles the WASM/JS fallback path)

**Expected impact:** +5–10 percentage points on caller coverage. Barrel files are ubiquitous in TypeScript monorepos and component libraries.

**Affected files:** `src/domain/graph/resolve.ts`, `src/domain/graph/builder/stages/build-edges.ts`

**Progress (v3.12.0):**
- ✅ `buildImportedNamesMap` traces through barrel re-exports to actual declaration files — symbols imported via `components/index.ts` now resolve to their source module ([#1302](https://github.com/optave/ops-codegraph-tool/pull/1302))
- ✅ `buildBarrelEdges` uses cached `resolveBarrelExportCached` to avoid repeated DFS traversal ([#1302](https://github.com/optave/ops-codegraph-tool/pull/1302))
- ✅ Barrel-through `imports` edges emitted on WASM full builds ([#1298](https://github.com/optave/ops-codegraph-tool/pull/1298), [#1302](https://github.com/optave/ops-codegraph-tool/pull/1302))

### 8.5 -- Enhanced Dynamic Dispatch Resolution

Extend Phase 4.2's receiver type tracking with class hierarchy analysis (CHA) and rapid type analysis (RTA) for virtual/interface method dispatch.

**Approach:**
- **CHA (Class Hierarchy Analysis):** when a call targets an interface or abstract method, resolve to ALL concrete implementations (already partially implemented in Phase 4.3 via `implements` edges — this sub-phase wires it into the call graph builder)
- **RTA (Rapid Type Analysis):** refine CHA by only considering types that are actually instantiated in the program. If `class AdminUser extends User` is never constructed with `new AdminUser()`, exclude it from dispatch targets. Track instantiation sites during extraction
- **Dispatch type annotation:** classify each call edge as `static` (direct function call), `dynamic_resolved` (receiver type known), or `dynamic_unresolved` (receiver type unknown). Store on the edge for downstream confidence scoring
- **`this`/`self` propagation:** inside a method body, `this.method()` should resolve through the class's own method table and parent hierarchy, not through global name matching

**Expected impact:** +3–5 percentage points on caller coverage. Primarily benefits OOP-heavy codebases (Java, C#, TypeScript with class hierarchies).

**Affected files:** `src/domain/graph/builder/stages/build-edges.ts`, `src/extractors/*.ts` (instantiation tracking)

**Progress (v3.12.0):**
- ✅ CHA interface dispatch — when a call targets an interface method, emit edges to all concrete implementations reachable via `implements`/`extends` hierarchy ([#1302](https://github.com/optave/ops-codegraph-tool/pull/1302))
- ✅ RTA filter — CHA targets narrowed to types actually instantiated via `new X()`; `extractNewExpressionsWalk` captures unassigned `new` calls ([#1302](https://github.com/optave/ops-codegraph-tool/pull/1302))
- ✅ `this`/`super` dispatch inside method bodies resolved through the class's own method table and parent hierarchy ([#1302](https://github.com/optave/ops-codegraph-tool/pull/1302))
- ✅ `super.method()` dispatch via class expression, static block, and field def (extends Phase 8.5 coverage) ([#1399](https://github.com/optave/ops-codegraph-tool/pull/1399))
- ✅ Native orchestrator CHA expansion post-pass reads `implements`/`extends` edges from SQLite after native parse ([#1302](https://github.com/optave/ops-codegraph-tool/pull/1302))

### 8.6 -- Precision/Recall CI Gate Upgrade

Upgrade the Phase 4.4 benchmark suite to enforce regression gates on the new resolution techniques and track progress toward the 70% coverage target.

**Deliverables:**
- Expand fixture projects with barrel files, callback patterns, method chains, class hierarchies, and TypeScript generics
- Add per-technique breakdown: report how many edges each resolver contributed (TS-native, type propagation, points-to, barrel, CHA/RTA)
- Add a **coverage dashboard** to `codegraph stats`: `"caller_coverage": { "total": 5122, "resolved": 3585, "percentage": 70, "by_technique": { ... } }`
- CI gate: fail if caller coverage drops below baseline (initially 29%, ratcheted upward as each sub-phase ships)
- Benchmark against Jelly and ACG on shared fixture projects for external validation

**Progress (v3.9.2):**
- ✅ Resolution benchmark v2 — dynamic call tracing across 14 languages, per-mode categories ([#878](https://github.com/optave/ops-codegraph-tool/pull/878))
- ✅ Dynamic call tracing extended to all language fixtures ([#883](https://github.com/optave/ops-codegraph-tool/pull/883))
- ✅ Release workflow gated on resolution precision/recall thresholds ([#886](https://github.com/optave/ops-codegraph-tool/pull/886))

**Progress (v3.12.0):**
- ✅ Per-technique breakdown in `codegraph stats` — DB migration v17 adds `technique` column; edges tagged `ts-native` or `points-to` at insertion; `byTechnique` counts in `codegraph stats --json` and human-readable output ([#1303](https://github.com/optave/ops-codegraph-tool/pull/1303))
- ✅ Coverage dashboard in `codegraph stats` — `caller_coverage.percentage` included in both JS and native stat paths ([#1299](https://github.com/optave/ops-codegraph-tool/pull/1299))
- ✅ Jelly micro-test fixtures imported (59 fixtures) and per-fixture recall floors wired — JS/TS comparison fixtures with per-fixture precision/recall baselines ([#1376](https://github.com/optave/ops-codegraph-tool/pull/1376), [#1409](https://github.com/optave/ops-codegraph-tool/pull/1409))
- ✅ Research comparison of Jelly vs codegraph on shared JS/TS fixtures ([#1304](https://github.com/optave/ops-codegraph-tool/pull/1304))
- 🔲 Full Jelly/ACG benchmark with statistical parity tables (see 8.8 for reference map and fixture acquisition guide)

**Affected files:** `tests/benchmarks/resolution/`, `src/domain/analysis/symbol-lookup.ts`, `src/presentation/queries-cli/overview.ts`

### 8.7 -- Reaching Definition Analysis (PDG Foundation)

Build a reaching definitions pass that computes which assignments reach each use of a variable. This is the foundation for a Program Dependence Graph (PDG) — the same representation that powers Joern's data-flow queries.

**Approach:**
- Operate on the existing intra-procedural CFG (Phase 2.7 / 6.2)
- For each CFG basic block, compute GEN and KILL sets for variable assignments
- Fixed-point iteration: propagate reaching definitions across CFG edges until convergence
- Store reaching-definition edges in the `edges` table with kind `reaching_def`
- Use SSA-like variable renaming within basic blocks to disambiguate multiple assignments to the same variable

**Why:** Reaching definitions are a prerequisite for precise data-flow tracking. Once available, queries like "which user input reaches this SQL query" or "does this return value depend on the config parameter" become possible. This also improves points-to analysis precision (8.3) by providing flow-sensitive variable tracking within functions.

**Expected impact:** Indirect — enables more precise points-to resolution and unlocks data-flow queries for future phases. Modest direct impact on caller coverage (~1–2 points from disambiguating variable assignments in the same scope).

**Affected files:** new `src/domain/graph/resolver/reaching-defs.ts`, `src/domain/graph/builder/stages/build-edges.ts`

### 8.8 — Language-Specific Analysis Reference Map

This section is a research reference map, not an implementation plan. It documents the state-of-the-art static call-graph and points-to analysis tools for every language codegraph supports, identifies the precision/recall techniques those tools use, and maps the specific gaps in codegraph's current extraction for each language. Sub-phases of Phase 8 beyond 8.7 should consult this section to identify which tool or paper defines the target quality bar for the language they are improving.

Precision/recall figures are cited to their source paper or benchmark. Entries marked **(unverified)** could not be confirmed from publicly accessible materials at the time of writing.

**Fixture acquisition:** Each language subsection includes a "Benchmark suites / fixture sources" entry that lists ground-truth test corpora with their licenses. Where the license is MIT, Apache-2.0, BSD-2/3, or CC-BY, fixtures may be copied directly into `tests/benchmarks/resolution/fixtures/<lang>/` and committed. CC-BY datasets require attribution in the fixture README. GPL-licensed fixtures may only be used as a run-time reference (run the tool, record expected edges) — do not copy source files into the repo. Academic benchmark suites with no explicit license listed should be treated as reference-only; derive expected edges by running the tool, not by copying test files.

---

#### JVM (Java, Kotlin, Scala, Groovy, Clojure)

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| Doop | Declarative Datalog points-to (k-CFA, k-obj-sensitive) on Soufflé | Doop 0-CFA produces more edges than OPAL 0-CFA at comparable precision (ISSTA 2024, Helm et al., "Total Recall?") | https://github.com/plast-lab/doop |
| OPAL / Unimocg | Modular CHA/RTA/XTA/0-CFA; Unimocg decouples type-set from dispatch | OPAL 0-CFA 0.5% higher precision than Doop 0-CFA while emitting 5000+ fewer edges (ISSTA 2024) | https://github.com/opalj/opal |
| Soot / SootUp (SPARK) | CHA, RTA, VTA, SPARK field-sensitive Andersen on-the-fly | Soot IR more precise and scalable than WALA IR on DaCapo (PointEval 2019) | https://github.com/soot-oss/SootUp |
| Qilin | Fine-grained variable-level context-sensitivity; context debloating (DebloaterX, Moon) | Same precision as Doop at 2.4x faster (ECOOP 2022) | https://github.com/QilinPTA/Qilin |
| ScalaCG | Source-level TCA algorithms handling traits and abstract type members | TCAexpand-this: 1.5–17.3x fewer edges than bytecode RTA with formal soundness (ECOOP 2014 / TOSEM 2015) | https://github.com/themaplelab/scalacg |
| Zipper / Zipper-e | Precision-guided selective context-sensitivity on top of Doop | Identifies 38% of methods as precision-critical; preserves 98.8% of 2-obj-sensitive precision at 3.4–9.2x speedup (OOPSLA 2018) | https://github.com/silverbullettt/zipper |

**Codegraph gap:** No field-sensitivity, no points-to propagation, no Scala trait mixin (TCA) resolution, no handling of Groovy/Clojure invokedynamic patterns, no selective context-sensitivity.

**Groovy and Clojure note:** Both languages compile almost entirely to JVM `invokedynamic` bytecode — Groovy via its `CallSite` caching infrastructure, Clojure via its persistent data structures and protocol dispatch. Source-level call-graph analysis reaches a precision ceiling at name matching: the concrete dispatch target is determined at runtime. For these two languages, the JVM-level tools above (Doop, OPAL) remain the reference; codegraph's current source-level name matching is the practical ceiling. All Groovy and Clojure call edges should be emitted as low-confidence. No dedicated source-level CG benchmark exists for either language; the JVM-hosted languages study (Ali et al., IEEE TSE) is the closest reference.

**Adoption candidates:**
- Implement VTA-style type propagation along assignment edges for Java/Kotlin (Soot/SPARK): instead of including all declared subtypes at a call site (CHA), propagate the set of types assigned to each variable through `new T()` allocation sites. Expected 2–5x reduction in false virtual dispatch edges.
- Implement TCAexpand-this for Scala: when resolving a call on `this` inside a trait method, include all concrete classes that mix in the trait, using the `extends`/`implements` graph already extracted by Phase 4.3. Expected 1.5–17x reduction in Scala call graph edges per ECOOP 2014 results.
- Apply Zipper's two-pass principle: run a fast initial pass, identify call sites with high receiver-type fan-out (the precision-critical positions), then apply type-narrowing only to those sites rather than globally.

**Benchmark suites:** JCG (opalj/JCG, BSD) — annotated Java CG benchmark covering reflection, invokedynamic, lambdas; DaCapo suite; ISSTA 2024 dynamic baseline corpus (Zenodo 13134617).

---

#### Groovy

Groovy compiles almost entirely to JVM `invokedynamic` bytecode via its `CallSite` caching infrastructure. Source-level call-graph analysis reaches a precision ceiling at name matching; the concrete dispatch target is determined at runtime. All Groovy call edges should be emitted as low-confidence.

**Reference tools:** Doop / OPAL (see JVM section above) — the same JVM-level toolchain covers Groovy bytecode analysis.

**Codegraph gap:** No `invokedynamic` dispatch modelling; all Groovy call edges are emitted as name-matched with no confidence downgrade.

**Adoption candidates:** Emit a `confidence: low` annotation on all Groovy call edges and surface this in `codegraph audit` output. No source-level precision improvement is achievable without JVM bytecode access.

**Benchmark suites:** No dedicated source-level Groovy CG benchmark exists. JVM-hosted languages study (Ali et al., IEEE TSE) is the closest reference.

---

#### Clojure

Clojure dispatches through persistent data structures and protocol `defprotocol`/`extend-type` dispatch, compiled to JVM `invokedynamic`. Source-level name matching is the practical ceiling; reflection and dynamic `eval` make full soundness impossible at tree-sitter level.

**Reference tools:** Doop / OPAL (see JVM section above) — bytecode-level analysis is required for sound Clojure CG construction.

**Codegraph gap:** No `invokedynamic` modelling; no `defprotocol` dispatch; `apply` and `eval` forms silently dropped.

**Adoption candidates:** Emit `confidence: low` on all Clojure call edges. For `defprotocol`/`extend-type` forms, record the protocol name and all `extend-type` targets syntactically — these provide a partial static dispatch table even without bytecode.

**Benchmark suites:** No dedicated source-level Clojure CG benchmark exists. JVM-hosted languages study (Ali et al., IEEE TSE) is the closest reference.

---

#### Python

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| PyCG | Flow-insensitive assignment-graph type propagation | Macro: precision ~99.2%, recall ~69.9% (ICSE 2021, arXiv 2103.00587) | https://github.com/vitsalis/PyCG |
| JARVIS | Per-function type graphs; flow-sensitive strong updates; application-centered reachability | ≥84% higher precision, ≥20% higher recall vs PyCG; 8.16 s/analysis avg (arXiv 2305.05949, TOSEM 2024) | https://pythonjarvis.github.io/ |
| HeaderGen | PyCG extended with .pyi stub files for external library return-type resolution | 95.6% precision, 95.3% recall on call-graph benchmark (SANER 2023 / EMSE 2024) | https://github.com/secure-software-engineering/HeaderGen |
| PoTo | First Andersen-style context-insensitive points-to for Python; hybrid concrete evaluation for external library calls | Outperforms Pytype and DLInfer on 10 real packages (ECOOP 2025, arXiv 2409.03918) | https://github.com/Ingkarat/PoTo |
| PyAnalyzer | Points-to-style with first-class heap objects for functions/classes/modules; duck-typing and attribute mutation | +24.7% F1 over 7 compared tools on 191 real projects / 10M SLOC (ICSE 2024) | https://github.com/xjtu-enre/ICSE2024_PyAnalyzer |

**Codegraph gap:** No assignment-graph or points-to analysis; no external library stub integration; flow-insensitive treatment of assignments; no tracking of `__call__`, `__getattr__`, or metaclass-generated methods; no PyCG-equivalent micro-benchmark regression harness.

**Adoption candidates:**
- Integrate Python stub files (typeshed + popular library stubs such as those bundled with pyright) into the import resolver: when a call target is an external module symbol, consult its `.pyi` stub to resolve return type, then re-enter resolution with that type. HeaderGen achieves 95%+ precision/recall from this technique alone over PyCG's 70% recall baseline.
- Implement a per-function assignment graph (JARVIS-style FTG) for Python: maintain a local map from identifier to set of possible function objects within each function scope, updated at each assignment and propagated across call boundaries. This handles higher-order functions, closures, and decorated callables invisible to name-matching.
- Adopt the PyCG micro-benchmark suite (vitsalis/pycg-evaluation, Apache-2.0, 112 tests, 16 categories) as a fixture set in `tests/benchmarks/resolution/` to track which Python call patterns regress or improve with each change.

**Benchmark suites:** PyCG micro-benchmark (112 tests, vitsalis/pycg-evaluation); JARVIS extended benchmark (135 tests, 21 categories); TypeEvalPy (154 snippets, github.com/secure-software-engineering/TypeEvalPy); PyAnalyzer macro-corpus (191 projects, 10M SLOC).

---

#### JavaScript / TypeScript

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| Jelly | Flow-insensitive Andersen-style field-based points-to; on-the-fly CG; approximate interpretation (PLDI 2024); indirection bounding (ECOOP 2024) | Indirection-bounded: ~2x speedup at ~5% recall reduction vs baseline (ECOOP 2024, Chakraborty et al.) | https://github.com/cs-au-dk/jelly |
| ACG | Field-based points-to (pessimistic/optimistic); ONESHOT optimization for IIFEs | 99% precision, 91% recall on SunSpider 26-program suite (ICSE 2013 / IEEE Access 2023) | https://github.com/ecspat/acg |
| TAJS | Flow-sensitive abstract interpretation; .d.ts declaration files as library type filters | 98% precision, 71% recall on SunSpider; combined with ACG: 98% precision, 99% recall (IEEE Access 2023) | https://github.com/cs-au-dk/TAJS |
| ArkAnalyzer | HarmonyOS-focused TypeScript/ArkTS CG + dataflow analysis; native ArkUI component awareness; Taint analysis | Evaluated on ArkTS apps in Huawei ecosystem; no published standalone P/R figures | https://github.com/ArkAnalyzer/ArkAnalyzer |

**Codegraph gap:** Codegraph's JS/TS pipeline (tree-sitter + TypeScript compiler API type enrichment + intra-module Andersen-style field-based points-to per Phase 8.3c) is stronger than ACG on TypeScript files but has five concrete gaps vs Jelly: (1) no cross-module field-based alias propagation; (2) no handling of `obj[computedKey]()` dynamic property access (the #1 root cause of missing edges per ECOOP 2022); (3) no interprocedural higher-order function tracking; (4) no indirection-depth bound; (5) no dynamic ground truth validation.

**Adoption candidates:**
- Cross-file field-based alias propagation: extend the existing `buildPointsToMap` to accept a cross-file alias map populated during the resolve-imports stage, mirroring ACG's field-based treatment across module boundaries. This closes the primary false-negative source in multi-module Node.js projects.
- Expose a `pointsToMaxIndirections` config key in `DEFAULTS` (analogous to the existing `pointsToMaxIterations`); bound propagation depth at 3 hops by default (matching Jelly's default), providing a precision/recall knob and preventing pathological blowup — the ECOOP 2024 result shows ~2x speedup at 5% recall cost.
- Add hard-coded parameter-flow rules for known higher-order API patterns (`Array.prototype.map/filter/reduce/forEach`, `Promise.then`, `EventEmitter.on`, express `Router.use/get/post`) as the ONESHOT strategy from ACG, catching the most common higher-order false-negative category without a full interprocedural solver.

**Benchmark suites:** SunSpider (26 programs, 941 manually validated edges); Jelly benchmark set (25 large Node.js + 10 web + 4 mobile programs with NodeProf dynamic ground truth); SWARM-JS (50 npm packages, 163K edges, EMSE 2025).

**TSX note:** TSX analysis is identical to TypeScript — the same tree-sitter grammar extension, the same TypeScript compiler API type-enrichment pipeline, and the same Jelly/ACG reference tools apply. JSX syntax within `.tsx` files introduces no additional dispatch patterns: JSX element types resolve to component function or class definitions via the same name-matching and CHA pass as any other call. All tools, gaps, adoption candidates, and benchmarks listed above for TypeScript apply equally to TSX.

---

#### Go

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| golang.org/x/tools — go/callgraph (CHA/RTA/VTA) | CHA → RTA → VTA graduated precision; VTA propagates type labels through struct fields, local vars, return values, function literals to fixed point | VTA is the algorithm used by govulncheck in production; CHA < RTA < VTA in precision (documented ordering, no published P/R figures) | https://pkg.go.dev/golang.org/x/tools/go/callgraph |
| golang.org/x/tools — go/pointer (Andersen's) | Field-sensitive Andersen inclusion-based; whole-program; HVN presolver | Avg 30,481 non-static CG edges / 13,160 reachable functions at 14.89s on 14 real Go modules vs Steensgaard's 65,570 edges / 2.22s (BarrensZeppelin/pointer benchmark) | https://pkg.go.dev/golang.org/x/tools/go/pointer |
| govulncheck / golang.org/x/vuln | VTA call graph + import graph + module dependency graph; ssa.InstantiateGenerics for generics | Production security use at scale; no published P/R figures | https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck |
| go-callvis | Visualization wrapper over go/pointer / VTA / RTA / CHA; v0.7.1 (Jan 2025) fixed generics edge cases | No published P/R metrics; widely used as informal ground truth | https://github.com/ondrajz/go-callvis |

**Codegraph gap:** No go/ssa IR; no interface-aware dispatch resolution; no function-value/closure tracking; no generics-aware call graph (`ssa.InstantiateGenerics`); `go f()` goroutine-launch call edges not extracted; no whole-program analysis.

**Adoption candidates:**
- Resolve Go interface calls using CHA as a minimum baseline: enumerate all concrete types in the parsed file set that implement the interface's method set, and add call edges to all their implementations. Codegraph already tracks class hierarchies for JS/TS (Phase 4.3); apply the same pattern for Go interface dispatch.
- Detect and emit call edges for goroutine-launch statements (`go f(args)`): in the AST, `go_statement` has the call expression as a child. Treat `GoStmt` call targets identically to regular call targets — low effort, high recall gain for concurrency-heavy Go codebases.
- Use `ssa.InstantiateGenerics` semantics for generic function instantiations: at each call site that instantiates a generic, record the type arguments and emit a resolved call edge to the monomorphic version rather than a single edge to the generic definition.

**Benchmark suites:** BarrensZeppelin/pointer benchmark (14 real Go modules, Andersen vs Steensgaard comparison); govulncheck test suite (real CVE reproduction, golang.org/x/vuln); golang.org/x/tools/cmd/callgraph as reference ground truth.

---

#### Rust

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| Rupta | Andersen-style k-callsite context-sensitive points-to on Rust MIR; on-the-fly CG; stack filtering (CGO 2025) | 29% more call edges than Ruscg; ~70% fewer spurious dynamic call edges than Rurta (CC 2024) | https://github.com/rustanlys/rupta |
| MIRAI | Abstract interpretation over Rust MIR; summary-based interprocedural; Datalog/DOT export | Resolves 100% of static dispatch, dynamic dispatch, generics, function pointers, macros; 50% of conditionally compiled calls (ktrianta benchmark) | https://github.com/facebookexperimental/MIRAI |
| rust-callgraph-benchmark (ktrianta) | Benchmark suite only; six categories: static_dispatch, dynamic_dispatch, generics, function_pointers, conditionally_compiled, macros | Reference ground truth used in CC 2024 Rupta paper and MIRAI evaluation | https://github.com/ktrianta/rust-callgraph-benchmark |
| Charon | Compiler frontend lifting Rust MIR to structured LLBC, preserving full trait-clause and trait-bound information symbolically | Not a CG tool per se; the correct IR substrate for precise trait dispatch without monomorphization; TACAS 2025 | https://github.com/AeneasVerif/charon |

**Codegraph gap:** No `dyn Trait` dispatch resolution (requires MIR or type information absent from tree-sitter AST); no generic monomorphization; no `Fn*` trait closure resolution; no benchmark validation against the six ktrianta categories.

**Adoption candidates:**
- Adopt the ktrianta/rust-callgraph-benchmark six categories (static_dispatch, dynamic_dispatch, generics, function_pointers, conditionally_compiled, macros) as fixture sets in `tests/benchmarks/resolution/` with `expected-edges.json` manifests, immediately surfacing which gap categories are real.
- Build a trait-impl index for static dispatch approximation (CHA-equivalent): map `impl Trait for Type` blocks from the parsed AST so that `x.method()` where `x: SomeType` resolves to all `impl _ for SomeType` blocks that define `method`. Achievable purely from tree-sitter output, already significantly better than name-only matching.
- Track closure literal and fn-pointer assignments to local variables in the same function scope; when a function-typed variable is called, resolve to the assigned function. Flow-insensitive, intra-scope, no external IR required.

**Benchmark suites:** ktrianta/rust-callgraph-benchmark; Rupta CC 2024 evaluation corpus (Zenodo 10566216); RustSec Advisory Database (used by Rudra SOSP 2021 and cargo-scan ESOP 2026).

---

#### .NET (C#, F#)

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| dotnet/ILLink (Trimmer / NativeAOT ILC) | RTA-equivalent conditional dependency edges; virtual method body included only when declaring type is constructed; CHA-based devirtualization under closed-world | Production trimmer in .NET 6–10; no published academic P/R figures | https://github.com/dotnet/runtime/tree/main/docs/tools/illink |
| CodeQL for C# | CHA-level virtual/interface dispatch via `getAnOverrider()`/`getAnImplementor()` predicates; over-approximation | Highest F1 on taint-tracking OWASP Benchmark v1.2 across SAST tools (arXiv 2601.22952, 2025); no standalone C# CG P/R benchmark published | https://codeql.github.com/ |
| call-graph-orleans | Roslyn-based CHA/RTA over C# source; `IMethodSymbol.OverriddenMethod` + `FindImplementationsAsync` chains | Tested on ShareX, ILSpy, Azure-PowerShell (FSE 2017); no numeric P/R figures | https://github.com/edgardozoppi/call-graph-orleans |
| NoCFG | Language-agnostic lightweight CG approximation; coarse program abstraction | Lower-bound precision 90% on C# and Python corpora up to 2M LOC (arXiv 2105.03099) | https://arxiv.org/abs/2105.03099 |

**Codegraph gap:** Virtual dispatch resolution is name-based only; interface implementors are not enumerated; no conditional-edge / RTA semantics (virtual override inclusion not gated on receiver-type instantiation); no Roslyn `IMethodSymbol` chain walk; F# discriminated-union dispatch entirely unmodeled.

**Adoption candidates:**
- CHA via Roslyn `IMethodSymbol` chains for C#: for every virtual/abstract/interface call site, walk `IMethodSymbol.OverriddenMethod` up to the root declaration, collect all overriders via `OverridingMethods`, and enumerate interface implementors via `FindImplementationsAsync`. This replicates what CodeQL and call-graph-orleans do without bytecode processing. **Note:** this approach requires the Roslyn SDK (`Microsoft.CodeAnalysis.CSharp`) as a runtime dependency — unlike TypeScript where the compiler API is already in the pipeline, Roslyn is a separate .NET SDK and cannot be driven from tree-sitter output alone.
- Conditional-edge (RTA) semantics from ILC/NativeAOT: after CHA expansion, prune virtual dispatch edges where the declaring type is never instantiated in reachable code. Track a "constructed types" worklist populated by `new T()` expressions; only include override edges for types in that set.
- For C# delegate and lambda tracking: for every `new MethodName` or `SomeMethod` delegate-literal expression, add a call edge from any call site that invokes a delegate of the matching signature — analogous to Jelly's field-based treatment of function values in JS.

**Benchmark suites:** No dedicated .NET CG benchmark comparable to JCG exists as of the time of writing. ShareX and ILSpy are used informally. ISSTA 2024 "Total Recall?" dynamic-baseline methodology is directly applicable to .NET; OWASP Benchmark v1.2 covers taint analysis but not raw CG edge precision/recall.

---

#### Ruby

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| Sorbet | Flow-sensitive type inference with class hierarchy symbol table; gradual typing | No published CG P/R figures; open classes and `method_missing` are unmodeled | https://github.com/sorbet/sorbet |
| TypeProf | Whole-program abstract interpreter; speculatively enumerates concrete receiver types from a reachability worklist | No published P/R figures; conservative under uncertainty (outputs "untyped") | https://github.com/ruby/typeprof |
| Shopify/loupe (SCTP) | Sparse Conditional Type Propagation over a DAG call graph; field-sensitive object analysis; 175K functions in 2.5s | Experimental prototype; no P/R figures (Shopify, Feb 2025) | https://github.com/Shopify/loupe |

**Codegraph gap:** No class hierarchy model; `obj.foo` resolved purely by string matching on `foo` rather than by narrowing receiver class; open classes and `method_missing` entirely unmodeled; no abstract type propagation.

**Adoption candidates:**
- Two-pass CHA: first collect all `class C < B` and `module M; include X` declarations to build a hierarchy; then for each `obj.method` call site, resolve to all classes in the receiver's concrete type set using the hierarchy rather than global name matching. Replicates Sorbet's two-pass strategy, achievable from tree-sitter output.
- TypeProf-style reachability: start from declared entry points and speculatively enumerate all concrete receiver types reachable at each call site via a worklist. This converts name-based dispatch into a reachability-constrained type set.

**Benchmark suites:** PyCG micro-benchmark methodology (directly portable to Ruby); CLBG (Computer Language Benchmarks Game) Ruby programs (methodology reference — the Ali et al. IEEE TSE study applied these to JVM-hosted languages, not MRI Ruby; no dedicated Ruby CG precision/recall evaluation exists as of the time of writing).

---

#### PHP

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| Psalm | Flow-sensitive type inference; union-type narrowing at `instanceof`/`is_a()` guards; interprocedural via function-summary caching | No published CG P/R figures; v6.16.1 (Mar 2026) | https://github.com/vimeo/psalm |
| Phan | Multi-pass whole-program type inference; phase 1 indexes all classes/functions; phase 2 type-checks using that index | No published CG P/R figures; v6.0.5 (Mar 2026) | https://github.com/phan/phan |
| TChecker | Iterative type-sensitive CG construction for PHP; bootstraps with CHA, refines via data-flow to fixed point; explicit handling of PHP's seven method-invocation forms | CCS 2022: found 18 new vulnerabilities, 2 CVEs; outperforms PHPJoern and RIPS on precision | https://github.com/cuhk-seclab/TChecker |
| Artemis | Hybrid explicit+implicit CG for PHP; magic methods, variable class/method names via heuristics; LLM-assisted false-positive pruning | OOPSLA 2025: 207 true vulnerable paths, 15 false positives, 35 new CVEs on 250 PHP web apps | https://arxiv.org/abs/2502.21026 |

**Codegraph gap:** No handling of PHP's seven call-site forms (static literal, dynamic static, instance literal, dynamic instance, constructor, variable constructor, `call_user_func*`); no receiver type narrowing; no type propagation; magic methods (`__call`, `__callStatic`) and variable class/method names silently dropped.

**Adoption candidates:**
- Classify every PHP call site as one of the seven forms at extraction time (following TChecker CCS 2022 and Artemis OOPSLA 2025), then apply separate resolution strategies: literal forms use class-hierarchy lookup; dynamic forms union all classes implementing a same-named method; magic method forms match any class with `__call`.
- Adopt Psalm-style flow-sensitive receiver narrowing: at `$v->method()`, use the narrowed type of `$v` from preceding `instanceof` guards or assignment context rather than the full class hierarchy.
- Phan's two-phase design: build a global class/method index from all parsed files before resolving any call site. Replicates what codegraph's build pipeline already does for JS/TS but is not yet applied to PHP.

**Benchmark suites:** TChecker evaluation corpus (CCS 2022); Artemis corpus (250 PHP web apps, OOPSLA 2025).

---

#### Elixir

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| Dialyzer | Success typings; whole-program interprocedural via PLT; exports call graph; zero false positives by design at cost of recall | Zero false positives; recall is deliberately partial; part of Erlang/OTP (Apache-2.0) | https://www.erlang.org/doc/apps/dialyzer/dialyzer.html |
| Elixir gradual set-theoretic type system (v1.17+) | Union/intersection/negation semantic subtyping built into Elixir compiler; guard-based narrowing at pattern-match branches; protocol dispatch checking (v1.19) | No published P/R figures; still being calibrated in v1.20-rc | https://elixir-lang.org/blog/2024/12/19/elixir-v1-18-0-released/ |
| Reach (elixir-vibe/reach) | Program Dependence Graph combining CFG, call graph, dataflow, and OTP process relationships; four frontends (Elixir AST, Erlang AST, Gleam AST, BEAM bytecode); OTP-aware (GenServer, Supervisor, ETS) | No published P/R figures; 610+ commits, last update May 2026 | https://github.com/elixir-vibe/reach |
| Erlang xref / mix xref | Cross-reference analysis from BEAM bytecode (xref) or source (mix xref); distinguishes compile / export / runtime dependency edge types | Sound for direct `M:F/A` calls; does not resolve `apply/3` with runtime atoms | https://www.erlang.org/doc/apps/tools/xref_chapter.html |

**Codegraph gap:** No OTP dispatch pattern modeling — `GenServer.call/cast`, `Supervisor` child_spec, Phoenix controller routing, and `Ecto.Repo` callbacks are all false negatives; no guard-based type narrowing for multi-clause functions; `mix xref` compile/export/runtime edge-type distinction not preserved; no `M:F/A` arity-qualified resolution.

**Adoption candidates:**
- Add a post-processing step that inserts synthetic call edges for known OTP dispatch patterns: `GenServer.call` → `handle_call`, `GenServer.cast` → `handle_cast`, `Supervisor.start_child` → child module's `init/1`, Phoenix controller action → route handler. These are derivable from `use` declarations in the source.
- Use the full `Module:Function/Arity` triple as the call-target key for Elixir/Erlang; build a module-export index during graph construction and resolve cross-module calls against it. This converts `apply(Mod, Fun, Args)` calls with statically known atoms into concrete edges.
- Preserve the `mix xref` compile/export/runtime edge classification when extracting Elixir dependencies, exposing it as edge metadata so impact analysis correctly distinguishes compile-time ripple from runtime call.

**Benchmark suites:** Set-theoretic Types for Erlang test suite (321 tests, arXiv 2302.12783); Dialyzer scalability benchmarks on OTP applications (Jansen et al.); flowR OOPSLA 2025 corpus methodology (portable to BEAM).

---

#### Erlang

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| Dialyzer | Success typings; PLT-cached interprocedural; `M:F/A` triple resolution | Zero false positives by design; part of OTP | https://www.erlang.org/doc/apps/dialyzer/dialyzer.html |
| eqWAlizer | Gradual type checker; typespec-aware interprocedural; deployed at WhatsApp scale | No published P/R figures; Apache-2.0 | https://github.com/WhatsApp/eqwalizer |
| Erlang Language Platform (ELP) | Incremental IDE-first semantic analysis; call hierarchy (LSP `callHierarchy`); `M:F/A` resolution across whole codebase; written in Rust | Sound for direct `M:F/A` calls; dynamic `send`/`spawn` calls unresolved; v56, last release Feb 2026 | https://github.com/WhatsApp/erlang-language-platform |
| InfERL | Compositional bi-abduction/separation-logic interprocedural analysis on Erlang; linear-time scaling; deployed in WhatsApp CI | Production-validated at millions of LOC (Erlang Workshop 2022) | https://research.facebook.com/publications/inferl-scalable-and-extensible-erlang-static-analysis/ |

**Codegraph gap:** No `M:F/A` triple resolution across modules; `apply/3` with runtime atoms silently dropped; no PLT-equivalent inter-module index.

**Adoption candidates:**
- Use `Module:Function/Arity` triples as call-target keys; build a module-export index analogous to Dialyzer's PLT during graph construction. Arity disambiguation is the single highest-leverage change for Erlang precision.
- ELP-style incremental module index: resolve `M:F/A` triples across the whole corpus via a symbol index, replicating ELP's call-hierarchy queries without requiring a full LSP integration.

**Benchmark suites:** ELP call hierarchy (WhatsApp/erlang-language-platform, Apache-2.0); Dialyzer OTP scalability benchmarks (Jansen et al.); Set-theoretic Types for Erlang test suite (321 tests, arXiv 2302.12783).

---

#### Gleam

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| Reach (elixir-vibe/reach) | Native Gleam AST frontend; Gleam's static type system provides full dispatch information at the source level; integrates with BEAM bytecode frontend for compiled library calls | No published P/R figures; MIT license | https://github.com/elixir-vibe/reach |

**Codegraph gap:** Gleam's static type system provides full dispatch information at the source level; codegraph does not leverage it. All Gleam call resolution is currently name-based.

**Adoption candidates:**
- Exploit Gleam's type annotations to restrict dispatch candidates: unlike dynamic languages, Gleam function calls are fully type-resolved by the compiler. At minimum, use declared parameter types to filter candidate targets by type compatibility rather than name alone.

**Benchmark suites:** No dedicated Gleam call-graph precision/recall benchmark exists as of the time of writing. The Reach project's BEAM bytecode test cases (elixir-vibe/reach, MIT) are the closest available ground truth.

---

#### C / C++ / CUDA / Objective-C

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| SVF | LLVM IR Andersen/Steensgaard/flow-sensitive/demand-driven points-to; SVFG; co-iterates CG and pts-to to fixed point | Demand-driven SUPA: 97.4% of full flow-sensitive results (IEEE TSE 2018); SVF-3.3 (May 2026) | https://github.com/SVF-tools/SVF |
| TypeDive / MLTA | Multi-layer type analysis on LLVM IR: constrains indirect call targets by type-compatible struct-field layer | Eliminates 86–98% more indirect-call targets than FLTA on Linux kernel, FreeBSD, Firefox (CCS 2019) | https://github.com/umnsec/mlta |
| KallGraph | On-demand backward-slicing indirect call analysis; points-to on value-flow graph; proves unsoundness in MLTA/DeepType under aliasing | Validated against 937 unique indirect calls / 981 targets from 7-day Syzkaller fuzzing on Linux-6.5 (IEEE S&P 2025) | https://github.com/seclab-ucr/KallGraph |
| Cocktail | Staged cascade: constant propagation → type-inference → allocation-site tracking → full points-to; empirically-driven classification of 5,355 indirect calls | 34.5% of C indirect calls resolvable by constant folding; 23.9% of address-taken functions uniquely invocable by signature (OOPSLA 2023) | https://dl.acm.org/doi/10.1145/3622833 |
| Clang Static Analyzer (built-in `CallGraph`) | AST-level recursive visitor; CHA for C++ virtual calls using the Clang type system | Sound for direct calls within a TU; no interprocedural pts-to; CHA for virtual is imprecise | https://clang.llvm.org/doxygen/classclang_1_1CallGraph.html |

**Codegraph gap:** C function pointers completely unresolved when callee is a pointer dereference or field load; no C++ virtual dispatch CHA (class hierarchy `extends` data is present but not used for dispatch); CUDA `<<<...>>>` kernel launch calls silently dropped; no address-taken function tracking.

**Adoption candidates:**
- CHA for C++ virtual calls using the existing `ctx.classes` inheritance data: when a method call is made through a receiver, enumerate all subclasses that override the method and emit additional call edges. The `classes` array with `extends` edges is already populated by `handleCppClassSpecifier` — wire it into `handleCppCallExpression` for virtual method names.
- CUDA kernel launch extraction: handle the `cuda_kernel_call_expression` AST node type in `walkCudaNode` alongside `call_expression`. The kernel function name is the first child of this node — a one-line addition that recovers the primary call edges in any CUDA program.
- Address-taken function pre-pass for C indirect call resolution (FLTA baseline): scan for identifier nodes whose text matches a known function definition and whose parent is not a `call_expression`; emit call edges from each indirect-call site to all address-taken functions with a matching parameter count. This is coarser than MLTA but sound and achievable at tree-sitter level.

**Benchmark suites:** Linux kernel (used by MLTA, DeepType, KallGraph); Cocktail corpus (nginx, Redis, SQLite, OpenSSL, CPython — 5,355 annotated indirect calls, OOPSLA 2023); GNU coreutils 28 programs (Phoenix 2026); NVIDIA CUDA Samples repository; Syzkaller-generated call traces (KallGraph, IEEE S&P 2025).

---

#### Objective-C

Objective-C `[receiver selector]` message-send semantics require class-hierarchy analysis (CHA) over the class/protocol hierarchy — the same pass needed for C++ virtual calls. The tree-sitter-objc grammar captures receiver/selector pairs syntactically, but dispatch target resolution requires the `extends` / `conforms-to` hierarchy data.

**Reference tools:** Clang's built-in `CallGraph` (AST-level) and SVF (LLVM-IR-level) — both model Objective-C method dispatch via CHA when compiled with Clang.

**Codegraph gap:** `[receiver selector]` messages are extracted as call edges with the selector as the callee name, but no CHA over the class/protocol hierarchy is performed. Dispatch targets are not enumerated for virtual selectors.

**Adoption candidates:** The same CHA pass described for C++ virtual calls (using existing `ctx.classes` inheritance data) applies to Objective-C selectors. Enumerate all classes that implement the selector method via the class hierarchy, emitting additional edges with lower confidence weight.

**Benchmark suites:** No standalone Objective-C CG benchmark comparable to JCG or PyCG exists. Apple's open-source projects (objc4, Foundation) serve as informal ground truth. All C/C++ toolchain benchmarks above cover Objective-C when compiled with Clang.

---

#### Swift

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| SWAN | SIL-based whole-program CHA, VTA, and UCG algorithms; SPDS demand-driven pointer queries; SWIRL IR for library modelling | No published P/R figures; UCG described as slightly more precise than VTA (ESEC/FSE 2020) | https://github.com/themaplelab/swan |
| CodeQL for Swift | CHA-level over-approximate call graph; closure semantics and protocol dispatch modelled in QL schema | No published numeric P/R figures for Swift CG specifically | https://codeql.github.com/ |
| Barik et al. OOPSLA 2019 (Uber Swift protocol optimization) | SoleTypeAnalysis: whole-module SIL-level dataflow determines when a protocol variable has exactly one concrete type; devirtualizes those call sites | Up to 12% reduction in method call overhead on a large Uber production iOS app (OOPSLA 2019) | https://manu.sridharan.net/files/OOPSLA19Swift.pdf |

**Codegraph gap:** No protocol conformance graph; `obj.method()` where `obj` is of protocol type resolves to the protocol declaration rather than conforming implementations; closures stored in protocol-typed variables produce no call edge; no SoleType pruning.

**Adoption candidates:**
- Protocol conformance graph construction: build a map from all `extension X: P` and `struct/class X: P` declarations. For any call site `x.method()` where `x` is typed as protocol `P`, add call edges to all conforming types' implementations — CHA over the conformance graph rather than the inheritance graph.
- SoleType pruning (Barik et al. OOPSLA 2019): if a protocol-typed variable has only one concrete conforming type assigned across all visible assignment sites in the same file/module, demote the call to a direct edge. Implementable at tree-sitter AST level without SIL.

**Benchmark suites:** SWAN crypto benchmark (13 iOS/macOS apps); ISSTA 2024 "Total Recall?" dynamic-baseline methodology applicable to Swift via XCTest coverage instrumentation.

---

#### Dart

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| Dart VM Type Flow Analysis (TFA) — dart-lang/sdk pkg/vm | Two-phase: RTA seeds allocated classes; then iterative type-flow propagation to fixed point; sound devirtualization under closed-world assumption | 49.5% reduction in AOT compilation time in a large Flutter app; devirtualizes only when a unique target is provable (no published academic P/R paper) | https://github.com/dart-lang/sdk/tree/master/pkg/vm/lib/transformations/type_flow |
| Heinze, Møller, Strocco (Aarhus, DLS 2016) | Flow analysis using optional Dart type annotations as filters | 99.3% of all property lookup operations type-safe across benchmark Dart programs (DLS 2016) | https://cs.au.dk/~amoeller/papers/safedart/ |

**Codegraph gap:** No RTA pre-pass; Dart 2+ sound type annotations are unused for dispatch filtering; all Dart virtual calls treated as fully dynamic; closure argument types untracked.

**Adoption candidates:**
- RTA pre-pass: collect all `T()` and `new T()` constructor call sites; only emit virtual dispatch edges to types that are actually instantiated. Directly replicates the first phase of the Dart VM's TFA at tree-sitter level.
- Leverage Dart 2+ sound type annotations: when a local variable or parameter is declared as `Foo x`, restrict dispatch targets of `x.method()` to `Foo` and its subtypes. Mirrors the Aarhus DLS 2016 finding that annotation-guided filtering achieves 99.3% precision without context sensitivity.

**Benchmark suites:** DyPyBench methodology (arXiv 2403.00539) — executable benchmark comparing static vs dynamic CG — portable to Dart via Dart Observatory/VM coverage.

---

#### Zig

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| Zig compiler internal call graph (ziglang/zig Sema) | Lazy whole-program semantic analysis; comptime-driven monomorphization produces per-instantiation AIR; all dispatch statically resolved at AIR level | 100% precise by construction for non-function-pointer calls — Zig has no runtime OOP polymorphism | https://github.com/ziglang/zig |
| ZLint (DonIsaac/zlint) | AST-based linter; single-file intraprocedural only; no CG construction | No CG P/R figures; v0.8.1 (Apr 2026) | https://github.com/DonIsaac/zlint |
| Zwanzig (forketyfork/zwanzig) | CFG-based checks using ZIR output; single-file intraprocedural; cross-file calls treated as external | No CG P/R figures | https://github.com/forketyfork/zwanzig |

**Codegraph gap:** No comptime-aware monomorphic call graph; OOP dispatch heuristics (CHA/RTA) are inapplicable to Zig and produce false edges; function pointers (the only source of dynamic dispatch in Zig) not tracked; tagged-union dispatch unmodeled.

**Adoption candidates:**
- Comptime-aware monomorphic edge generation: detect `fn f(comptime T: type, ...)` patterns and the comptime arguments at each call site; emit one call edge per distinct instantiation of `T` observed in the corpus rather than a single polymorphic edge.
- Explicitly suppress OOP dispatch heuristics for Zig: do not apply class-hierarchy virtual dispatch logic to Zig code; all `instance.method()` syntax in Zig resolves to a direct struct-field access followed by a direct call.
- ZIR-level analysis (longer-term): consume `zig ast-check --emit-zir` output rather than the surface AST. ZIR has resolved comptime parameters and contains explicit monomorphized call targets, eliminating the comptime guessing problem entirely.

---

#### Haskell

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| Calligraphy | HIE-file-based CG extraction; GHC-generated `.hie` files carry fully resolved, type-annotated ASTs | Authors report ~80% accuracy; no formal P/R benchmark (BSD-3-Clause) | https://github.com/jonascarpay/calligraphy |
| Weeder | Whole-program reachability over HIE files; handles cross-module boundaries | No published P/R figures; known false positive: Template Haskell splices untracked | https://github.com/ocharles/weeder |
| GHC-WPC (Whole Program Compiler project) | Exports External STG IR for whole-program analysis outside GHC; designed for Datalog/Soufflé-based CG construction | No published benchmarks; WIP research infrastructure | https://github.com/grin-compiler/ghc-whole-program-compiler-project |

**Codegraph gap:** Type class dispatch (the dominant virtual call mechanism in Haskell) is invisible to tree-sitter; higher-order function calls through lambda-bound variables and dictionary-passing are not resolvable without GHC type information; no HIE or STG IR integration.

**Adoption candidates:**
- HIE-file ingestion: when a Haskell project is compiled with `-fwrite-ide-info`, detect the `.hie` directory and use HIE files as the authoritative symbol/call source instead of tree-sitter re-parsing. HIE files resolve type-class dispatch and all import aliasing at GHC type-checker level.
- Even without HIE, tag all Haskell call-graph edges through type-class method names as low-confidence `dynamic` edges rather than emitting them as false-positive direct edges, making the precision gap visible.

**Benchmark suites:** No published Haskell CG precision/recall benchmark comparable to PyCG or JCG exists as of the time of writing.

---

#### OCaml

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| Salto | Abstract interpretation over salto-IL (desugared OCaml TypedTree); novel abstract domain for closure values with hash-consing; OPAM-installable (v0.2, Nov 2025) | No published P/R figures; experimental | https://salto.gitlabpages.inria.fr/ |
| ocp-analyzer | Whole-program data and exception analysis over Xlambda IR (normalised OCaml Lambda bytecode) | No published benchmarks; README acknowledges tests are out of date; historical reference only | https://github.com/OCamlPro/ocp-analyzer |

**Codegraph gap:** No IL normalisation; OCaml higher-order function calls through closure parameters invisible to name-matching; OCaml module system (first-class modules, functors, `include`) creates aliasing chains not resolvable from tree-sitter AST.

**Adoption candidates:**
- IL normalisation pass for OCaml before symbol extraction: convert nested match arms and point-free expressions to a flat let-binding form (A-normal form), making call sites explicit. Reference: Salto-IL and Xlambda normalisation design.
- Closure allocation-site tagging: for calls through function-typed variables, tag the edge with the set of closure allocation sites visible at the binding point (even a 0-CFA approximation — all `fun`/`function` expressions in scope — is better than no edge). Reference: Salto's abstract domain for closure values.

---

#### Julia

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| JET.jl | Abstract interpretation piggybacking on Julia's native compiler inference (`Core.Compiler.AbstractInterpreter`); emits `:invoke` (direct) vs `:call` (dynamic dispatch) sites | No published P/R figures; inference terminates at non-inferable nodes so recall drops where type inference fails | https://github.com/aviatesk/JET.jl |
| Cthulhu.jl | Interactive descent-based CG explorer using Julia's `AbstractInterpreter`; surfaces `:invoke`/`:call` distinction; `TypedSyntax.jl` for type-annotated source | No published P/R benchmark; resolution quality equals Julia compiler inference quality | https://github.com/JuliaDebug/Cthulhu.jl |

**Codegraph gap:** Multiple dispatch makes name-based call resolution fundamentally incorrect — the same function name dispatches to different methods based on argument types. Codegraph likely treats all `foo(a, b)` calls as edges to all methods named `foo`, producing high recall but very low precision.

**Adoption candidates:**
- Multiple-dispatch aware resolution: for calls `f(a, b)` in Julia, use argument type information from context (literal types, declared types from prior assignments) to filter to matching method signatures rather than emitting edges to all methods named `f`.
- Adopt the `:invoke`/`:call` confidence split: tag Julia call graph edges as `concrete` (argument types fully inferred, single dispatch target) vs `dynamic` (type unknown, multiple possible targets), surfacing unresolved dispatch sites to users rather than emitting potentially-false edges.

**Benchmark suites:** Type Stability in Julia (OOPSLA 2021, arXiv 2109.01950) defines formal notions of type stability — the correct framework for evaluating Julia CG precision.

---

#### R

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| flowR | Sophisticated dataflow analysis framework; stateful fold over normalised AST; handles dynamic scoping, lazy evaluation, first-class environments, `source()` cross-file loading | 99.7% on 779 manually curated slicing points from real R scripts (OOPSLA 2025); 84.8% avg token reduction in program slicing; 153.2 ms/file | https://github.com/flowr-analysis/flowr |
| CodeDepends / callGraph | AST-walk name-based dependency detection; pure name-matching | No published P/R figures; no handling of calls through function-valued variables | https://cran.r-project.org/web/packages/CodeDepends/index.html |

**Codegraph gap:** R's dynamic scoping, `<<-`, `assign()`/`get()`, and `source()` make name-based call graphs severely incomplete. Calls through function-valued variables (`f <- mean; f(x)`) produce no edge. flowR achieves 99.7% slicing accuracy; codegraph's R extractor is at a CodeDepends-equivalent capability level.

**Adoption candidates:**
- AST normalisation before extraction (flowR-style): convert R's syntactic sugar into a uniform AST form before graph construction so that call sites are explicit, including those inside nested function-valued expressions.
- Function-variable assignment tracking: detect `f <- some_function` patterns and treat any subsequent call through `f` as an edge to `some_function`. Even this simple step covers the most common R higher-order pattern.
- `source()` resolution: when a script sources another file with a literal path (`source('./lib.R')`), include that file's functions as in-scope for the calling script's call graph.

**Benchmark suites:** flowR OOPSLA 2025 evaluation corpus (779 manually curated slicing points + 4,230 CRAN scripts, github.com/flowr-analysis/flowr) — the only published precision/recall benchmark for R static analysis.

---

#### Lua

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| LuaLS (lua-language-server) | Contextual type inference; annotation-assisted (LuaCATS); go-to-definition and find-references cross-file | No published CG P/R figures; metatable-based OOP dispatch is a known open gap | https://github.com/LuaLS/lua-language-server |
| Luau | Gradual typing with bidirectional inference and flow-sensitive refinement; strict mode | No published CG P/R figures; POPL 2024 benchmarks type-error detection but not CG accuracy | https://github.com/luau-lang/luau |
| LuaTaint | Interprocedural taint analysis; field-sensitive table tracking; LuCI dispatcher-rule injection; context-sensitive | Precision 89.29% on 2,447 IoT firmware samples; recall 97.80% on 323 manufactured test cases (arXiv 2402.16043) | https://arxiv.org/abs/2402.16043 |

**Codegraph gap:** No metatable and `__index`-based dispatch resolution (the dominant OOP pattern in Lua); no field-sensitive table tracking; no framework dispatch-rule injection (e.g. LuCI entry points); LuaLS annotation-based class model not consulted.

**Adoption candidates:**
- Annotation-based metatable resolution: when a local variable is assigned `setmetatable({}, {__index = ClassName})`, record `ClassName` as the receiver type for method calls on that variable, following LuaLS's annotation-guided model.
- Field-sensitive table tracking (LuaTaint approach): track table field types individually rather than treating the whole table as a single node; this recovers method calls on table slots in OOP-style Lua.
- Framework entry-point injection: for Lua frameworks with implicit dispatch (LuCI, OpenResty), add known framework caller-callee edges as synthetic nodes.

**Benchmark suites:** LuaTaint corpus (2,447 IoT firmware samples, arXiv 2402.16043).

---

#### Bash

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| sash (MIT/Penn/Rice/Brown, HotOS 2025) | Formal regular-language type system for shell string shapes; JIT seeding for dynamic values; LLM-guardrailed command specification | No published P/R figures; position paper identifying core soundness blockers (HotOS 2025) | https://dl.acm.org/doi/10.1145/3713082.3730395 |
| shell-call-graph (rak) | Static regex scan of shell scripts for function definitions and call sites; DOT output | No benchmarks; does not handle `eval`, variable-based dispatch, or command substitution | https://codeberg.org/rak/shell-call-graph |
| callGraph (koknat) | Regex-based multi-language CG including Bash; no type inference or alias analysis | No benchmarks; covers both Lua and Bash | https://github.com/koknat/callGraph |

**Codegraph gap:** Variable-indirection calls (`$func_name`), `eval`, and `source` with non-literal paths are the three core soundness blockers identified by sash (HotOS 2025). These are fundamentally unresolvable by static name matching.

**Adoption candidates:**
- Acknowledge and flag unsoundness: mark all Bash call edges as low-confidence `dynamic` when the callee is derived from a variable, command substitution, or a `source` with a non-literal path rather than silently dropping or falsely emitting edges.
- `source` file tracking: when a script sources another file with a literal path (`source ./lib.sh`), treat that file's functions as in-scope for the calling script — the same treatment codegraph already applies to JS/TS imports.

**Benchmark suites:** No established public benchmark for Bash call graph precision/recall exists as of the time of writing (acknowledged gap in the sash HotOS 2025 paper).

---

#### Solidity

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| Slither | SSA-based SlithIR; per-contract CG, inheritance graph, CFG; C3-linearized MRO for `super` call resolution; handles `virtual`/`override` modifiers | Avg F1 0.941 across vulnerability types (arXiv 2310.20212v4); parses 99.9% of public Solidity | https://github.com/crytic/slither |
| Aderyn | Rust-based Solidity AST analyzer using foundry-compilers and compiler-verified AST; CI toolchain integration | No published CG P/R figures; 45K+ downloads | https://github.com/Cyfrin/aderyn |
| SmartBugs 2.0 | Execution framework wrapping 19 Solidity tools; SmartBugs-Curated annotated vulnerability dataset | Conkas avg F1 0.968; Slither avg F1 0.941 (arXiv 2310.20212v4) | https://arxiv.org/abs/2306.05057 |

**Codegraph gap:** No C3-linearized MRO for `super` call resolution; no `virtual`/`override` dispatch modeling; no cross-contract interface-typed call resolution.

**Adoption candidates:**
- C3 MRO dispatch: implement C3 linearization of contract inheritance hierarchies and resolve `super.f()` and `virtual f()` calls using MRO position of the calling contract, matching Slither's approach.
- `virtual`/`override` modeling: when a function is declared `virtual` and a call target has the same signature in a derived contract marked `override`, add an edge to the most-derived override visible from the call site.
- Cross-contract interface calls: when an external call is made on an interface-typed variable, add edges to all contracts in the compilation unit that implement that interface (CHA-style over-approximation).

**Benchmark suites:** SmartBugs-Curated (github.com/smartbugs/smartbugs-curated); SWC Registry (swcregistry.io).

---

#### Verilog / SystemVerilog

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| Qihe | First general-purpose Verilog static analysis framework; three-address code IR; models blocking/non-blocking/delayed assignments, module instantiation as call edges, `invokeStmt` nodes for task/function calls; 22 fundamental analyses | Found 9 previously unknown bugs confirmed by developers; 18 bugs beyond existing linters (PLDI 2026, arXiv 2601.11408) | https://arxiv.org/abs/2601.11408 |
| slang (sv-lang) | Full-featured SystemVerilog IEEE 1800-2023 parser and analysis library; cross-module elaboration; semantic verification; used by Qihe as its frontend | No CG P/R figures; highest-conformance open SystemVerilog frontend | https://sv-lang.com/ |
| Pyverilog | Python toolkit; dataflow and control-flow analysis; no task/function call graph | No published CG P/R figures; ARC 2015 | https://github.com/PyHDI/Pyverilog |

**Codegraph gap:** Tree-sitter Verilog grammar lacks semantic elaboration; hierarchical name resolution, parameterized module instantiation, and blocking vs non-blocking assignment semantics not captured; task and function call sites not distinguished from module instantiation edges.

**Adoption candidates:**
- Module instantiation as call edges: add module instantiation relationships as directed call edges in the graph (parent module → child module instance). This is the primary unit of Verilog call graph construction and requires only AST-level detection of `module_instantiation` node types.
- Distinguish task/function call edges from module instantiation edges: classify `task_call` and `function_call` AST node types as function-level call edges, emitting them separately from structural module instantiation edges.
- Longer-term: consider slang (via pyslang bindings) as an alternative frontend for SystemVerilog projects where semantic elaboration is needed for correct hierarchical name resolution.

**Benchmark suites:** Qihe evaluation corpus (popular real-world Verilog hardware projects from OpenCores and CVA6, PLDI 2026).

---

#### Multi-language / General frameworks

| Tool | Coverage | Approach | URL |
|------|----------|----------|-----|
| Joern / CPG | C, C++, Java, JS, Python, Kotlin, Binary | Code Property Graph (AST + CFG + PDG); CALL edges pre-materialized; interprocedural dataflow via query-time call-resolver | https://github.com/joernio/joern |
| Fraunhofer AISEC CPG | Java, C++, Python, Go, TypeScript/JS (exp.), Ruby (exp.), LLVM IR (Rust, Swift, ObjC, Haskell) | Source-level CPG with multi-pass type-inference and virtual-dispatch resolution passes after initial graph build | https://github.com/Fraunhofer-AISEC/cpg |
| CodeQL | C, C++, Java, C#, JS, TS, Python, Ruby, Go, Swift, Kotlin | TypeTracker demand-driven type-tag propagation; `polyCalls` predicate for virtual dispatch; per-language extractors | https://codeql.github.com/ |
| Tai-e | Java, Android | On-the-fly Andersen-style CG + context-sensitive pts-to; reflection analysis; lambda/invokedynamic; extensible plugin system | https://github.com/pascal-lab/Tai-e |
| WALA | Java, Android, JavaScript | On-the-fly CG co-evolved with flow-insensitive pts-to; CHA/RTA/0-CFA/n-CFA; SSA IR | https://github.com/wala/WALA |

The AISEC CPG framework is the closest architectural analogue to codegraph (source-level, multi-language, Apache-2.0, multi-pass resolution). Its key differentiator is multi-pass resolution: after the initial graph is built, additional passes use type information from neighboring files to re-resolve previously unknown call targets. This is the pattern codegraph's builder pipeline should adopt as analysis depth improves.

---


#### Terraform / HCL

| Tool | Approach | Precision / Recall | URL |
|------|----------|--------------------|-----|
| Checkov (graph runner) | Graph-based cross-resource analysis; interpolation walking + variable default resolution + module inheritance; 800+ cross-resource policies | No published P/R for edge accuracy; security check correctness tested internally | https://github.com/bridgecrewio/checkov |
| InfraMap | HCL interpolation expression walking → resource-reference edges; provider-specific edge filtering; reads `hashicorp/hcl/v2` | No published P/R benchmark | https://github.com/cycloidio/inframap |
| Pulumi Converter (`pulumi-converter-terraform`) | Full HCL→Pulumi AST translation; resolves all module call, variable, output, and data-source references to emit valid Pulumi programs | Conversion correctness test suite acts as implicit ground truth for reference resolution | https://github.com/pulumi/pulumi-converter-terraform |
| Rover | Parses plan JSON + raw HCL; builds resource state overview + resource-dependency graph; models module structure, locals, outputs | No published P/R benchmark | https://github.com/im2nguyen/rover |

**Codegraph gap:** No module-call edge tracking (`module "foo" { source = "..." }` not emitted as a call edge); no variable-flow edges across module boundaries (`var.x` → consuming resource); no data-source attribute reference edges (`data.aws_ami.latest.id`); no module output reference edges (`module.foo.output_name`). HCL has no dynamic dispatch concept — the equivalent of "call graph precision" is dependency-edge coverage across these four reference classes. No existing tool models all four, and no published precision/recall benchmark exists for any tool.

**Adoption candidates:**
- Study Checkov's `checkov/terraform/graph_builders/` (Apache-2.0) for interpolation walking and variable-default resolution — the most complete open-source implementation of HCL reference resolution, suitable as a reference algorithm for codegraph's HCL extractor.
- Mine the `pulumi-converter-terraform` test corpus (Apache-2.0) for multi-module HCL configurations that require correct cross-module reference resolution — these function as de facto ground-truth fixture candidates.
- Use the **TerraDS dataset** (CC-BY-4.0, 279,344 modules, Zenodo 14217386, MSR 2025) as the HCL precision/recall corpus: the `external_module_calls` JSON field records declared module call edges and provides ground truth for module-call resolution benchmarking. This is the closest available analogue to the PyCG micro-benchmark for Python.

**Benchmark suites / fixture sources:**
- TerraDS (MSR 2025, CC-BY-4.0): https://zenodo.org/records/14217386 — 279,344 Terraform modules with structured module-call metadata
- Blast Radius examples (MIT): https://github.com/28mm/blast-radius/tree/master/examples — multi-resource AWS/GCP/Azure HCL configurations
- Rover example (MIT): https://github.com/im2nguyen/rover/tree/main/example — multi-feature module + output + locals configuration
- Trivy/tfsec fixture corpus (Apache-2.0): https://github.com/aquasecurity/trivy — hundreds of annotated HCL snippets, reusable under Apache-2.0

---

#### Summary: All Supported Languages

| Language | Top Reference Tool | Primary Technique Gap in Codegraph | Target Benchmark |
|----------|-------------------|-------------------------------------|-----------------|
| JavaScript | Jelly (BSD-3) | Cross-module field-based alias propagation; dynamic property access | SWARM-JS; Jelly benchmark set |
| TypeScript | Jelly / ArkAnalyzer | Cross-module field-based alias propagation; indirection bounding | SWARM-JS; SunSpider 26-program suite |
| TSX | Jelly | Same as TypeScript | Same as TypeScript |
| Python | JARVIS / HeaderGen | External library stub integration; per-function type graphs | PyCG 112-test suite; TypeEvalPy |
| Go | golang.org/x/tools VTA | Interface-aware dispatch; goroutine-launch edges; generics instantiation | BarrensZeppelin/pointer 14-module benchmark |
| Rust | Rupta (CC 2024) | `dyn Trait` dispatch (requires MIR); generic monomorphization; closure provenance | ktrianta/rust-callgraph-benchmark (6 categories) |
| Java | Doop / OPAL | Field-sensitive VTA / points-to propagation; no RTA instantiation filtering | JCG (opalj/JCG); ISSTA 2024 dynamic baseline |
| Kotlin | OPAL / Soot | Same as Java; Android lifecycle callbacks | JCG; DaCapo suite |
| Scala | ScalaCG (ECOOP 2014) | Trait mixin TCA dispatch (1.5–17x edge reduction per ECOOP 2014) | JCG; ScalaCG TOSEM 2015 evaluation |
| C# | dotnet/ILLink (NativeAOT) | CHA via Roslyn IMethodSymbol chains; RTA conditional-edge semantics; interface implementor enumeration | No public P/R benchmark; ShareX/ILSpy informal |
| F# | dotnet/ILLink (NativeAOT) | F# DU/computation-expression dispatch unmodeled; CIL-level CHA needed | No public P/R benchmark |
| C | KallGraph (S&P 2025) | Address-taken function tracking; FLTA/MLTA indirect call target narrowing | Cocktail corpus (5,355 annotated indirect calls); Linux kernel subsystems |
| C++ | SVF / Clang CallGraph | CHA for virtual calls using existing `ctx.classes` inheritance data | Linux kernel; Firefox (MLTA CCS 2019) |
| CUDA | Clang CallGraph / SVF | `<<<...>>>` kernel launch calls silently dropped | NVIDIA CUDA Samples repository |
| Objective-C | Clang CallGraph | `[receiver selector]` message send CHA via protocol/superclass graph | No dedicated benchmark |
| Swift | SWAN (ESEC/FSE 2020) | Protocol conformance graph; SoleType pruning (OOPSLA 2019) | SWAN crypto benchmark (13 iOS/macOS apps) |
| Dart | Dart VM TFA (dart-lang/sdk) | RTA pre-pass; sound type annotation leverage | DyPyBench methodology (arXiv 2403.00539) |
| Zig | Zig compiler Sema (internal) | Comptime monomorphization; suppress inapplicable OOP heuristics | No public benchmark; ZIR output as ground truth |
| Haskell | Calligraphy / GHC-WPC | Type class dispatch invisible without HIE files; HIE ingestion needed | No public CG P/R benchmark |
| OCaml | Salto (INRIA, v0.2 2025) | IL normalisation before extraction; closure allocation-site tagging | No public CG P/R benchmark |
| Julia | JET.jl / Cthulhu.jl | Multiple-dispatch name resolution produces false edges; `:invoke`/`:call` confidence split needed | OOPSLA 2021 type-stability benchmark (arXiv 2109.01950) |
| R | flowR (OOPSLA 2025) | Dynamic scoping, `<<-`, `assign()`/`get()`, function-valued variables entirely unmodeled | flowR corpus (779 curated slicing points + 4,230 CRAN scripts) |
| Elixir | Dialyzer / Elixir v1.17+ type system | OTP dispatch patterns (GenServer, Supervisor) produce false negatives; no `M:F/A` arity resolution | Set-theoretic Types for Erlang test suite (321 tests) |
| Erlang | Dialyzer / ELP | `M:F/A` triple resolution not used; `apply/3` silently dropped | ELP call hierarchy; Dialyzer OTP scalability benchmarks |
| Gleam | Reach (MIT, BEAM PDG) | Hindley-Milner type information unused; name-only matching | No dedicated benchmark |
| Lua | LuaTaint / LuaLS | Metatable/`__index` OOP dispatch unmodeled; field-sensitive table tracking absent | LuaTaint corpus (2,447 IoT firmware samples) |
| Bash | sash (HotOS 2025) | Variable-indirection calls unresolvable; `eval` and non-literal `source` paths are fundamental soundness limits | No public benchmark (gap acknowledged in sash paper) |
| Ruby | TypeProf / Shopify loupe | No class hierarchy model; all method dispatch is name-only | PyCG methodology portable to Ruby |
| PHP | TChecker (CCS 2022) / Artemis (OOPSLA 2025) | Seven PHP call-site forms not classified; magic methods and variable class/method names dropped | TChecker corpus (CCS 2022); Artemis corpus (250 apps, OOPSLA 2025) |
| Solidity | Slither (Apache-2.0) | No C3 MRO `super` resolution; no `virtual`/`override` dispatch; no cross-contract interface resolution | SmartBugs-Curated; SWC Registry |
| Groovy | Doop / OPAL (JVM-level) | Compiles almost entirely to `invokedynamic`; source-level analysis is the only tractable path; all Groovy call edges should be flagged low-confidence | JVM-hosted languages study (Ali et al., IEEE TSE) |
| Clojure | Doop / OPAL (JVM-level) | Same as Groovy; `invokedynamic` and reflection make bytecode analysis unsound; source-level name matching is the practical ceiling | JVM-hosted languages study (Ali et al., IEEE TSE) |
| Verilog / SystemVerilog | Qihe (PLDI 2026) | Module instantiation not emitted as call edges; task/function call sites not distinguished; no semantic elaboration | Qihe evaluation corpus (OpenCores, CVA6) |
| Terraform / HCL | Checkov graph runner (Apache-2.0) / Pulumi Converter (Apache-2.0) | No module-call, variable-flow, or data-source reference edges; 4 reference edge classes unmodeled | TerraDS (CC-BY-4.0, MSR 2025); Trivy fixtures (Apache-2.0) |

### Optional runtime dependencies

The following dependencies are needed only for specific sub-phases and should be declared as `optionalDependencies` (or `peerDependencies` with `optional: true`):

| Dependency | Sub-phase | Purpose | Size | Notes |
|-----------|-----------|---------|------|-------|
| `typescript` | 8.1 | `ts.createProgram` + type checker for TS-native resolution | ~40 MB | Already a devDependency; promote to optional runtime dep. Only loaded when analyzing `.ts`/`.tsx` projects. Users without it fall back to the existing heuristic resolver |

All other sub-phases (8.2–8.7) use only codegraph's existing tree-sitter infrastructure and require no new runtime dependencies.

---

## Phase 9 -- Runtime & Extensibility

**Goal:** Harden the runtime for large codebases and open the platform to external contributors. These items were deferred from Phase 3 -- they depend on the clean module boundaries and domain layering established there, and benefit from TypeScript's type safety (Phase 5) for safe refactoring of cross-cutting concerns like caching, streaming, and plugin contracts.

**Why after TypeScript Migration:** Several of these items introduce new internal contracts (plugin API, cache interface, streaming protocol, engine strategy). Defining those contracts in TypeScript from the start avoids a second migration pass and gives contributors type-checked extension points (Phase 5).

### 9.1 -- Event-Driven Pipeline

Replace the synchronous build/analysis pipeline with an event/streaming architecture. Enables progress reporting, cancellation tokens, and bounded memory usage on large repositories (10K+ files).

- Introduce a lightweight `EventBus` (or Node `EventEmitter` subclass) that pipeline stages publish to: `file:parsed`, `resolve:complete`, `build:progress`, `build:error`
- CLI subscribes for progress bars and cancellation (Ctrl-C gracefully stops in-flight parsing)
- MCP subscribes for streaming partial results back to the client
- Programmatic API consumers can attach custom listeners (logging, metrics, CI reporters)
- Back-pressure support: slow consumers don't block the pipeline; events are buffered up to a configurable high-water mark

**Affected files:** `src/domain/graph/builder.js`, `src/cli/`, `src/mcp/`

### 9.2 -- Unified Engine Interface (Strategy Pattern)

Replace scattered `engine.name === 'native'` / `engine === 'wasm'` branching throughout the codebase with a formal Strategy pattern. Each engine implements a common `ParsingEngine` interface with methods like `parse(file)`, `batchParse(files)`, `supports(language)`, and `capabilities()`.

- Define a `ParsingEngine` interface (TypeScript) with clear input/output contracts
- Implement `NativeEngine` and `WasmEngine` adapters behind this interface
- The `auto` strategy delegates to native first, falls back to WASM per-language based on `supports()` checks
- Remove all engine-name string comparisons from calling code -- callers interact only with the interface
- Less critical now that native is the primary path, but eliminates a class of branching bugs and simplifies adding future engines (e.g., LSP-backed parsing)

**Affected files:** `src/infrastructure/native.js`, `src/domain/parser.js`, `src/domain/graph/builder.js`

### 9.3 -- Subgraph Export Filtering

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

### 9.4 -- Transitive Import-Aware Confidence

Improve import resolution accuracy by walking the import graph before falling back to proximity heuristics. Currently the 6-level priority system uses directory proximity as a strong signal, but this can mis-resolve when a symbol is re-exported through an index file several directories away.

- Before proximity fallback, trace the transitive import chain: if file A imports from barrel B which re-exports from C, resolve directly to C
- Track re-export chains in a lightweight in-memory graph built during the resolve phase
- Confidence scores account for chain length (direct import = 1.0, one re-export hop = 0.95, two hops = 0.9, etc.)
- Handles circular re-exports gracefully (cycle detection with visited set)

**Affected files:** `src/domain/graph/resolve.js`

### 9.5 -- Query Result Caching

Add an LRU/TTL cache layer between the analysis/query functions and the SQLite repository. With 34+ MCP tools that often run overlapping queries within a session, caching eliminates redundant DB round-trips.

- Implement a `QueryCache` with configurable max entries (default: 1000) and TTL (default: 60s)
- Cache key: deterministic hash of query name + parameters
- Automatic invalidation on `build` (cache cleared when graph is rebuilt)
- Optional `--no-cache` flag for debugging and benchmarking
- Cache hit/miss stats exposed via `codegraph stats` and debug logging
- MCP sessions benefit most -- typical tool sequences (`context` → `fn-impact` → `file-deps`) share intermediate results

**Affected files:** `src/domain/analysis/`, `src/db/index.js`

### 9.6 -- Configuration Profiles

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

### 9.7 -- Pagination Standardization

Standardize SQL-level `LIMIT`/`OFFSET` pagination across all repository queries and surface it consistently through the CLI and MCP.

- All repository query methods accept `{ limit, offset }` options with sensible defaults
- CLI commands support `--limit` and `--offset` flags (or `--page` / `--per-page` for convenience)
- MCP tools accept `limit` and `offset` parameters; responses include `total` count and `hasMore` flag
- Eliminates ad-hoc in-memory slicing that currently happens in some query paths
- Large result sets are bounded by default (e.g., 100 rows) to prevent accidental memory blowups in MCP

**Affected files:** `src/shared/paginate.js`, `src/db/index.js`, `src/domain/analysis/`, `src/mcp/`

### 9.8 -- Plugin System for Custom Commands

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

### 9.9 -- Developer Experience & Onboarding

Lower the barrier to first successful use. Today codegraph requires manual install, manual config, and prior knowledge of which command to run next.

1. **`codegraph init`** -- interactive wizard that detects the project (languages, framework, monorepo), suggests `.codegraphrc.json` config, and auto-writes MCP settings for the detected editor (Claude Code, Cursor, VS Code, Zed)
2. **Surface benchmark numbers in README** -- headline performance numbers (parse time, build time, query latency) already exist internally; surface them prominently in the README so users see concrete numbers before installing
3. **`npx @optave/codegraph` support** -- zero-install path; ensure the package works correctly when invoked via `npx` without prior `npm install` (handle WASM grammar bootstrapping, native addon fallback)
4. **Pre-built editor configs** -- ship ready-to-use MCP/extension configs for Cursor, VS Code, and Zed (not just Claude Code); include in `docs/editors/` with one-command setup instructions
5. **Guided CLI output** -- after each command, suggest the logical next step (e.g. `"Next: try codegraph context <symbol> to see full context"`); suppressible via `--quiet` or config

**Affected files:** new `src/cli/commands/init.js`, `docs/benchmarks/`, `docs/editors/`, `src/presentation/result-formatter.js`

### 9.10 -- Confidence Annotations on Query Output

Every query output should communicate its known limitations. When `fn-impact` shows a blast radius of 5 functions, it should note how many method-dispatch calls may be missing.

- Add `confidence` and `resolution_stats` fields to all `*Data()` function return values
- Format: `{ resolved: N, unresolved_method_calls: M, confidence: 0.XX }`
- CLI displays as a footer line: `"5 affected functions (confidence: 82%, 3 unresolved method calls in scope)"`
- MCP tools include the fields in JSON responses

**Affected files:** `src/domain/analysis/*.js`, `src/presentation/result-formatter.js`

### 9.11 -- Shell Completion

Commander supports shell completion but it's not implemented. Basic UX gap for a CLI tool with 40+ commands.

- Generate bash/zsh/fish completion scripts via Commander's built-in support
- `codegraph completion bash|zsh|fish` outputs the script
- Document in README

**Affected files:** `src/cli/index.js`

---

## Phase 10 -- Quality, Security & Technical Debt

**Goal:** Harden the CI pipeline with supply-chain security, enforce test quality gates, and clean up technical debt identified by architectural audits. These items were originally scoped under Phase 5 (TypeScript Migration) but are independent of the migration itself.

### 10.1 -- Supply-Chain Security & Audit

**Gap:** No `npm audit` in CI pipeline. No supply-chain attestation (SLSA/SBOM). No formal security audit history.

**Deliverables:**

1. **CI `npm audit`** -- add `npm audit --omit=dev` step to CI pipeline; fail on critical/high vulnerabilities
   - ✅ npm audit CI step added (v3.9.1, [#834](https://github.com/optave/ops-codegraph-tool/pull/834))
   - ✅ WASM grammar validation — build-time integrity checks for tree-sitter grammar files (v3.9.1, [#834](https://github.com/optave/ops-codegraph-tool/pull/834))
   - ✅ Dev-dependency audit at critical severity added to CI (v3.13.0, [#1479](https://github.com/optave/ops-codegraph-tool/pull/1479))
   - ✅ Supply-chain incident resolved — malicious `tree-sitter-erlang` npm package replaced with clean source build; 3 moderate vulns fixed (v3.13.0, [#1478](https://github.com/optave/ops-codegraph-tool/pull/1478))
2. **SBOM generation** -- produce CycloneDX or SPDX SBOM on each release via `@cyclonedx/cyclonedx-npm` or similar
   - 🔲 Not yet started
3. **SLSA provenance** -- enable SLSA Level 2+ build provenance using `actions/attest-build-provenance` in the publish workflow; attach attestation to npm packages
   - 🔲 Not yet started
4. **Security audit log** -- maintain `docs/security/AUDIT_LOG.md` documenting past audits, dependency reviews, and remediation history
   - 🔲 Not yet started

**Affected files:** `.github/workflows/ci.yml`, `.github/workflows/publish.yml`, `docs/security/`

### 10.2 -- CI Test Quality & Coverage Gates

**Gaps:**

- No coverage thresholds enforced in CI (coverage report runs locally only)
- Embedding tests in separate workflow requiring HuggingFace token
- 312 `setTimeout`/`sleep` instances in tests — potential flakiness under load
- No dependency audit step in CI (see also [10.1](#101----supply-chain-security--audit))

**Deliverables:**

1. **Coverage gate** -- add `vitest --coverage` to CI with minimum threshold (e.g. 80% lines/branches); fail the pipeline when coverage drops below the threshold
2. **Unified test workflow** -- merge embedding tests into the main CI workflow using a securely stored `HF_TOKEN` secret; eliminate the separate workflow
3. **Timer cleanup** -- audit and reduce `setTimeout`/`sleep` usage in tests; replace with deterministic waits (event-based, polling with backoff, or `vi.useFakeTimers()`) to reduce flakiness
4. > _Dependency audit step is covered by [10.1](#101----supply-chain-security--audit) deliverable 1._

**Affected files:** `.github/workflows/ci.yml`, `vitest.config.js`, `tests/`

### 10.3 -- Kill List (Technical Debt Cleanup)

Items to remove or rework, identified by architectural audit:

1. **Remove Maintainability Index computation** — The 1991 Coleman-Oman formula (171 - 5.2*ln(V) - 0.23*G - 16.2*ln(LOC)) was validated on Fortran and C, not modern languages with closures, async/await, and higher-order functions. Microsoft deprecated their MI implementation in 2023. Remove from `ast-analysis/metrics.js` and `complexity` output, or replace with a validated metric
2. **Scope Halstead metrics to imperative code** — Halstead operator/operand counting is meaningless for JSX, template literals, HCL, and declarative code. Either scope to imperative code blocks or remove
3. **Migrate custom `graph/model.js` to `graphology`** — `graphology` is already a runtime dependency. The custom model reimplements `addNode`, `addEdge`, `successors`, `predecessors`, `inDegree`, `outDegree` — all available natively in `graphology`. Migrate during the TypeScript migration to avoid maintaining two graph representations
4. **Skip WASM loading on platforms with native binaries** — On supported platforms (darwin-arm64, linux-x64, win32-x64), WASM should not be loaded at all. Currently `loadNative()` is checked on every call in `resolve.js`

---

## Phase 11 -- Intelligent Embeddings

**Goal:** Dramatically improve semantic search quality by embedding natural-language descriptions instead of raw code.

> **Phase 11.3 (Hybrid Search) was completed early** during Phase 2.5 -- FTS5 BM25 + semantic search with RRF fusion is already shipped in v2.7.0.

### 11.1 -- LLM Description Generator

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

### 11.2 -- Enhanced Embedding Pipeline

- When descriptions exist, embed the description text instead of raw code
- Keep raw code as fallback when no description is available
- Add `--use-descriptions` flag to `codegraph embed` (default: true when descriptions exist)
- Store embedding source type in `embedding_meta` (code vs description)

**Expected improvement:** ~12% better semantic similarity for natural-language queries.

**Affected files:** `src/embedder.js`

### ~~11.3 -- Hybrid Search~~ ✅ Completed in Phase 2.5

Shipped in v2.7.0. FTS5 BM25 keyword search + semantic vector search with RRF fusion. Three search modes: `hybrid` (default), `semantic`, `keyword`.

### 11.4 -- Build-time Semantic Metadata

Enrich nodes with LLM-generated metadata beyond descriptions. Computed incrementally at build time (only for changed nodes), stored as columns on the `nodes` table.

| Column | Content | Example |
|--------|---------|---------|
| `side_effects` | Mutation/IO tags | `"writes DB"`, `"sends email"`, `"mutates state"` |
| `complexity_notes` | Responsibility count, cohesion rating | `"3 responsibilities, low cohesion -- consider splitting"` |
| `risk_score` | Fragility metric from graph centrality + LLM assessment | `0.82` (high fan-in + complex logic) |

- MCP tool: `assess <name>` -- returns complexity rating + specific concerns
- Cascade invalidation: when a node changes, mark dependents for re-enrichment

**Depends on:** 9.1 (LLM provider abstraction)

### 11.5 -- Module Summaries

Aggregate function descriptions + dependency direction into file-level narratives.

- `module_summaries` table -- one entry per file, re-rolled when any contained node changes
- MCP tool: `explain_module <file>` -- returns module purpose, key exports, role in the system
- `naming_conventions` metadata per module -- detected patterns (camelCase, snake_case, verb-first), flag outliers

**Depends on:** 9.1 (function-level descriptions must exist first)

> **Full spec:** See [llm-integration.md](./llm-integration.md) for detailed architecture, infrastructure table, and prompt design.

---

## Phase 12 -- Natural Language Queries

**Goal:** Allow developers to ask questions about their codebase in plain English.

### 12.1 -- Query Engine

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

### 12.2 -- Conversational Sessions

Multi-turn conversations with session memory.

```bash
codegraph ask "How does auth work?" --session my-session
codegraph ask "What about the token refresh?" --session my-session
codegraph sessions list
codegraph sessions clear
```

- Store conversation history in SQLite table `sessions`
- Include prior Q&A pairs in subsequent prompts

### 12.3 -- MCP Integration

New MCP tool: `ask_codebase` -- natural language query via MCP.

Enables AI coding agents (Claude Code, Cursor, etc.) to ask codegraph questions about the codebase.

**Affected files:** `src/mcp.js`

### 12.4 -- LLM-Narrated Graph Queries

Graph traversal + LLM narration for questions that require both structural data and natural-language explanation. Each query walks the graph first, then sends the structural result to the LLM for narration.

| Query | Graph operation | LLM adds |
|-------|----------------|----------|
| `trace_flow <entry>` | BFS from entry point to leaves | Sequential narrative: "1. handler validates -> 2. calls createOrder -> 3. writes DB" |
| `trace_upstream <name>` | Recursive caller walk | Ranked suspects: "most likely cause is X because it modifies the same state" |
| `effect_analysis <name>` | Full callee tree walk, aggregate `side_effects` | "Calling X will: write to DB (via Y), send email (via Z)" |
| `dependency_path <A> <B>` | Shortest path(s) between two symbols | Narrates each hop: "A imports X from B because A needs to validate tokens" |

Pre-computed `flow_narratives` table caches results for key entry points at build time, invalidated when any node in the chain changes.

**Depends on:** 9.4 (`side_effects` metadata), 9.1 (descriptions for narration context)

### 12.5 -- Onboarding & Navigation Tools

Help new contributors and AI agents orient in an unfamiliar codebase.

- `entry_points` query -- graph finds roots (high fan-out, low fan-in) + LLM ranks by importance
- `onboarding_guide` command -- generates a reading order based on dependency layers
- MCP tool: `get_started` -- returns ordered list: "start here, then read this, then this"
- `change_plan <description>` -- LLM reads description, graph identifies relevant modules, returns touch points and test coverage gaps

**Depends on:** 11.5 (module summaries for context), 12.1 (query engine)

---


## Phase 13 -- GitHub Integration & CI

**Goal:** Bring codegraph's analysis into pull request workflows.

> **Note:** Phase 2.5 delivered `codegraph check` (CI validation predicates with exit code 0/1), which provides the foundation for GitHub Action integration. The boundary violation, blast radius, and cycle detection predicates are already available.

### 13.1 -- Reusable GitHub Action

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

### 13.2 -- PR Review Integration

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

### 13.3 -- Visual Impact Graphs for PRs

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

**Depends on:** 13.1 (GitHub Action), 11.4 (`risk_score`, `side_effects`)

### 13.4 -- SARIF Output

> **Note:** SARIF output could be delivered as early as Phase 9 for IDE integration, since it only requires serializing existing cycle/check data into the SARIF JSON schema.

Add SARIF output format for cycle detection. SARIF integrates with GitHub Code Scanning, showing issues inline in the PR.

**Affected files:** `src/export.js`

### 13.5 -- Auto-generated Docstrings

```bash
codegraph annotate
codegraph annotate --changed-only
```

LLM-generated docstrings aware of callers, callees, and types. Diff-aware: only regenerate for functions whose code or dependencies changed. Stores in `docstrings` column on nodes table -- does not modify source files unless explicitly requested.

**Depends on:** 9.1 (LLM provider abstraction), 11.4 (side effects context)

---

## Phase 14 -- Advanced Features

### 14.1 -- Dead Code Detection

```bash
codegraph dead
codegraph dead --exclude-exports --exclude-tests
```

Find functions/methods/classes with zero incoming edges (never called). Filters for exports, test files, and entry points.

> **Note:** Phase 2.5 added role classification (`dead` role in structure.js) and Phase 2.7 added AST node storage (`ast_query` can find unreferenced exports). This extends those foundations with a dedicated command, smarter filtering, and cross-reference with `exports` command data.

**Affected files:** `src/queries.js`

### 14.2 -- Cross-Repository Support (Monorepo)

Support multi-package monorepos with cross-package edges.

- Detect workspace root (`package.json` workspaces, `pnpm-workspace.yaml`, `lerna.json`)
- Resolve internal package imports (e.g., `@myorg/utils`) to actual source files
- Add `package` column to nodes table
- `codegraph build --workspace` to scan all packages
- Impact analysis across package boundaries

### 14.3 -- Agentic Search

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

### 14.4 -- Refactoring Analysis

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

**Depends on:** 11.4 (`risk_score`, `complexity_notes`), 11.5 (module summaries)

### 14.5 -- Auto-generated Docstrings

```bash
codegraph annotate
codegraph annotate --changed-only
```

LLM-generated docstrings aware of callers, callees, and types. Diff-aware: only regenerate for functions whose code or dependencies changed. Stores in `docstrings` column on nodes table -- does not modify source files unless explicitly requested.

**Depends on:** 9.1 (LLM provider abstraction), 11.4 (side effects context)

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
| **7** | Caller coverage ≥70% on codegraph's own codebase (TS/JS); precision ≥85% on benchmark fixtures; per-technique contribution breakdown in `codegraph stats` |
| **8** | Parse sample files for each new language, verify definitions/calls/imports; dual-engine parity on all 34 languages |
| **9** | Event pipeline emits progress events; plugin system loads and executes a sample plugin; confidence annotations appear on query output |
| **10** | `npm audit` passes in CI; SBOM generated on release; coverage gate enforced |
| **11** | Compare `codegraph search` quality before/after descriptions; verify `side_effects` and `risk_score` populated for LLM-enriched builds |
| **12** | `codegraph ask "How does import resolution work?"` against codegraph itself; verify `trace_flow` and `get_started` produce coherent narration |
| **13** | Test PR in a fork, verify GitHub Action comment with Mermaid graph and risk labels is posted |
| **14** | `hotspots` returns ranked list with LLM commentary; `split_analysis` produces actionable output; dead code detection filters correctly |

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
