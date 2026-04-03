# Codegraph Roadmap

> **Current version:** 3.8.1 | **Status:** Active development | **Updated:** 2026-04-03

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
| [**8**](#phase-8--analysis-depth) | Analysis Depth | TypeScript-native resolution, inter-procedural type propagation, field-based points-to analysis, enhanced dynamic dispatch, barrel file resolution, precision/recall CI gates | Planned |
| [**9**](#phase-9--runtime--extensibility) | Runtime & Extensibility | Event-driven pipeline, unified engine strategy, subgraph export filtering, transitive confidence, query caching, configuration profiles, pagination, plugin system | Planned |
| [**10**](#phase-10--quality-security--technical-debt) | Quality, Security & Technical Debt | Supply-chain security, test quality gates, architectural debt cleanup | Planned |
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

## Phase 8 -- Analysis Depth

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

### 8.3 -- Field-Based Points-To Analysis

Implement a lightweight field-based points-to analysis inspired by [ACG](https://arxiv.org/abs/2405.07206) and [Jelly](https://github.com/cs-au-dk/jelly). This resolves higher-order function calls (callbacks, event handlers, strategy patterns) that syntactic analysis completely misses.

**What it solves:** When `app.use(authMiddleware)` or `events.on('click', handler)` passes a function reference, the current extractor sees only a variable name — not the function it points to. Points-to analysis tracks what values flow into function-typed variables.

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

### 8.5 -- Enhanced Dynamic Dispatch Resolution

Extend Phase 4.2's receiver type tracking with class hierarchy analysis (CHA) and rapid type analysis (RTA) for virtual/interface method dispatch.

**Approach:**
- **CHA (Class Hierarchy Analysis):** when a call targets an interface or abstract method, resolve to ALL concrete implementations (already partially implemented in Phase 4.3 via `implements` edges — this sub-phase wires it into the call graph builder)
- **RTA (Rapid Type Analysis):** refine CHA by only considering types that are actually instantiated in the program. If `class AdminUser extends User` is never constructed with `new AdminUser()`, exclude it from dispatch targets. Track instantiation sites during extraction
- **Dispatch type annotation:** classify each call edge as `static` (direct function call), `dynamic_resolved` (receiver type known), or `dynamic_unresolved` (receiver type unknown). Store on the edge for downstream confidence scoring
- **`this`/`self` propagation:** inside a method body, `this.method()` should resolve through the class's own method table and parent hierarchy, not through global name matching

**Expected impact:** +3–5 percentage points on caller coverage. Primarily benefits OOP-heavy codebases (Java, C#, TypeScript with class hierarchies).

**Affected files:** `src/domain/graph/builder/stages/build-edges.ts`, `src/extractors/*.ts` (instantiation tracking)

### 8.6 -- Precision/Recall CI Gate Upgrade

Upgrade the Phase 4.4 benchmark suite to enforce regression gates on the new resolution techniques and track progress toward the 70% coverage target.

**Deliverables:**
- Expand fixture projects with barrel files, callback patterns, method chains, class hierarchies, and TypeScript generics
- Add per-technique breakdown: report how many edges each resolver contributed (TS-native, type propagation, points-to, barrel, CHA/RTA)
- Add a **coverage dashboard** to `codegraph stats`: `"caller_coverage": { "total": 5122, "resolved": 3585, "percentage": 70, "by_technique": { ... } }`
- CI gate: fail if caller coverage drops below baseline (initially 29%, ratcheted upward as each sub-phase ships)
- Benchmark against Jelly and ACG on shared fixture projects for external validation

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
2. **SBOM generation** -- produce CycloneDX or SPDX SBOM on each release via `@cyclonedx/cyclonedx-npm` or similar
3. **SLSA provenance** -- enable SLSA Level 2+ build provenance using `actions/attest-build-provenance` in the publish workflow; attach attestation to npm packages
4. **Security audit log** -- maintain `docs/security/AUDIT_LOG.md` documenting past audits, dependency reviews, and remediation history

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
