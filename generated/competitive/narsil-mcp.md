# Competitive Deep-Dive: Codegraph vs Narsil-MCP

**Date:** 2026-03-21
**Competitors:** `@optave/codegraph` v3.2.0 (Apache-2.0) vs `postrv/narsil-mcp` v1.6.1 (Apache-2.0 OR MIT)
**Context:** Both are Apache-2.0-licensed code analysis tools with MCP interfaces. Narsil-MCP is ranked #3 in our [competitive analysis](./COMPETITIVE_ANALYSIS.md) with a score of 4.5 vs codegraph's 4.5 at #4.

---

## Executive Summary

Narsil-MCP and codegraph share more DNA than any other pair in the competitive landscape — both use tree-sitter, both serve AI agents via MCP, both are local-first. But they diverge sharply in philosophy:

| Dimension | Narsil-MCP | Codegraph |
|-----------|------------|-----------|
| **Primary mission** | Maximum-breadth code intelligence in a single binary | Always-current structural intelligence with qualified names/scope/visibility graph model and sub-second rebuilds |
| **Target user** | AI agents needing comprehensive analysis (security, types, dataflow) | Developers, AI coding agents, CI pipelines needing fast feedback |
| **Architecture** | MCP-first, no standalone CLI queries | Full CLI + MCP server + programmatic JS API |
| **Core question answered** | "Tell me everything about this code" (90 tools) | "What breaks if I change this function?" (41 commands, 32 MCP tools) |
| **Rebuild model** | In-memory index, opt-in persistence, file watcher | SQLite-persisted, incremental hash-based rebuilds |
| **Runtime** | Single Rust binary (~30 MB) | Node.js + optional native Rust addon |

**Bottom line:** Narsil-MCP is broader (90 tools, 32 languages, security scanning, taint analysis, SBOM, type inference). Codegraph is deeper on developer productivity (impact analysis, complexity metrics, community detection, architecture boundaries, manifesto rules, sequence diagrams) and faster for iterative workflows (incremental rebuilds, CI gates). Where they overlap (call graphs, dead code, search, MCP), narsil has more tools while codegraph has more purpose-built commands. They are the closest competitors in the landscape.

---

## Problem Alignment with FOUNDATION.md

Codegraph's foundation document defines the problem as: *"Fast local analysis with no AI, or powerful AI features that require full re-indexing through cloud APIs on every change. None of them give you an always-current graph."*

### Principle-by-principle evaluation

| # | Principle | Codegraph | Narsil-MCP | Verdict |
|---|-----------|-----------|------------|---------|
| 1 | **The graph is always current** — rebuild on every commit/save/agent loop | 3-tier change detection (journal → mtime+size → hash), SQLite persistence. Change 1 file → <500ms rebuild. Watch mode, commit hooks, agent loops all practical | In-memory by default. `--watch` flag for auto-reindex. `--persist` for disk saves. Indexing is fast (2.1s for 50K symbols) but full re-index, not incremental | **Codegraph wins.** Narsil is fast but re-indexes everything. Codegraph only re-parses changed files — orders of magnitude faster for single-file changes in large repos |
| 2 | **Native speed, universal reach** — dual engine (Rust + WASM) | Native napi-rs with rayon parallelism + automatic WASM fallback. `npm install` on any platform | Pure Rust binary. Prebuilt for macOS/Linux/Windows. Also has WASM build (~3 MB) for browsers | **Tie.** Different approaches, both effective. Narsil is a single binary; codegraph is an npm package with native addon. Both have WASM stories |
| 3 | **Confidence over noise** — scored results | 6-level import resolution with 0.0-1.0 confidence on every edge. Graph quality score. Relevance-ranked search | BM25 ranking on search. No confidence scores on call graph edges. No graph quality metric | **Codegraph wins.** Every edge has a trust score; narsil's call graph edges are unscored |
| 4 | **Zero-cost core, LLM-enhanced when you choose** | Full pipeline local, zero API keys. Optional embeddings with user's LLM provider | Core is local. Neural search requires `--neural` flag + API key (Voyage AI/OpenAI) or local ONNX model | **Tie.** Both are local-first with optional AI enhancement. Narsil offers more backend choices (Voyage AI, OpenAI, ONNX); codegraph uses HuggingFace Transformers locally |
| 5 | **Functional CLI, embeddable API** | 41 CLI commands + 32-tool MCP server + full programmatic JS API | MCP-first with 90 tools. `narsil-mcp config/tools` management commands but no standalone query CLI. No programmatic library API | **Codegraph wins.** Full CLI experience + embeddable API. Narsil is MCP-only for queries — useless without an MCP client |
| 6 | **One registry, one schema, no magic** | `LANGUAGE_REGISTRY` — add a language in <100 lines, 2 files | Tree-sitter for all 32 languages. Unified parser, but extractors are in compiled Rust — harder to contribute | **Codegraph wins slightly.** Both use tree-sitter uniformly. Codegraph's JS extractors are more accessible to contributors than narsil's compiled Rust |
| 7 | **Security-conscious defaults** — multi-repo opt-in | Single-repo MCP default. `apiKeyCommand` for secrets. `--multi-repo` opt-in | Multi-repo by default (`--repos` accepts multiple paths). `discover_repos` auto-finds repos. No sandboxing concept | **Codegraph wins.** Single-repo isolation by default vs. multi-repo by default |
| 8 | **Honest about what we're not** | Code intelligence engine. Not an app, not a coding tool, not an agent | Code intelligence MCP server. Also not an agent — but the open-core model adds commercial cloud features (narsil-cloud) | **Tie.** Both are honest about scope. Narsil's commercial layer is a legitimate business model |

**Score: Codegraph 4, Narsil 0, Tie 4** — codegraph wins on its own principles but the gap is much smaller than vs. Joern. Narsil is the closest philosophical competitor.

---

## Feature-by-Feature Comparison

### A. Parsing & Language Support

| Feature | Codegraph | Narsil-MCP | Best Approach |
|---------|-----------|------------|---------------|
| **Parser technology** | tree-sitter (WASM + native Rust) | tree-sitter (compiled Rust) | **Tie** — same parser, different build strategies |
| **JavaScript/TypeScript/TSX** | First-class, separate grammars | Supported (JS + TS) | **Codegraph** — explicit TSX support |
| **Python** | tree-sitter | tree-sitter | **Tie** |
| **Go** | tree-sitter | tree-sitter | **Tie** |
| **Rust** | tree-sitter | tree-sitter | **Tie** |
| **Java** | tree-sitter | tree-sitter | **Tie** |
| **C/C++** | tree-sitter | tree-sitter | **Tie** |
| **C#** | tree-sitter | tree-sitter | **Tie** |
| **PHP** | tree-sitter | tree-sitter | **Tie** |
| **Ruby** | tree-sitter | tree-sitter | **Tie** |
| **Terraform/HCL** | tree-sitter | Not listed | **Codegraph** |
| **Kotlin** | Not supported | tree-sitter | **Narsil** |
| **Swift** | Not supported | tree-sitter | **Narsil** |
| **Scala** | Not supported | tree-sitter | **Narsil** |
| **Lua** | Not supported | tree-sitter | **Narsil** |
| **Haskell** | Not supported | tree-sitter | **Narsil** |
| **Elixir/Erlang** | Not supported | tree-sitter | **Narsil** |
| **Dart** | Not supported | tree-sitter | **Narsil** |
| **Julia/R/Perl** | Not supported | tree-sitter | **Narsil** |
| **Zig** | Not supported | tree-sitter | **Narsil** |
| **Verilog/SystemVerilog** | Not supported | tree-sitter | **Narsil** |
| **Fortran/PowerShell/Nix** | Not supported | tree-sitter | **Narsil** |
| **Bash** | Not supported | tree-sitter | **Narsil** |
| **Language count** | 11 | 32 | **Narsil** (3x more languages) |
| **Adding a new language** | 1 registry entry + 1 JS extractor (<100 lines, 2 files) | Rust code + recompile binary | **Codegraph** — dramatically lower barrier for contributors |
| **Incremental parsing** | 3-tier change detection (journal → mtime+size → hash) — only changed files re-parsed | Full re-index (fast but complete) | **Codegraph** — orders of magnitude faster for single-file changes |
| **Callback pattern extraction** | Commander `.command().action()`, Express routes, event handlers | Not documented | **Codegraph** — framework-aware symbol extraction |

**Summary:** Narsil covers 3x more languages (32 vs 11) using the same parser technology (tree-sitter). Codegraph has better incremental parsing, easier extensibility, and unique framework callback extraction. For codegraph's target users (JS/TS/Python/Go developers), codegraph's coverage is sufficient. Narsil's breadth matters for polyglot enterprises.

---

### B. Graph Model & Analysis Depth

| Feature | Codegraph | Narsil-MCP | Best Approach |
|---------|-----------|------------|---------------|
| **Graph type** | Structural dependency graph (symbols + edges) in SQLite | In-memory symbol/file caches (DashMap) + optional RDF knowledge graph | **Codegraph** for persistence; **Narsil** for RDF expressiveness |
| **Node types** | 13 kinds: `function`, `method`, `class`, `interface`, `type`, `struct`, `enum`, `trait`, `record`, `module`, `parameter`, `property`, `constant` — each with `qualified_name`, `scope`, `visibility` metadata | Functions, classes, methods, variables, imports, exports + more | **Narsil** — still more granular, but gap narrowed with codegraph's richer per-node metadata |
| **Edge types** | 10 structural edge types (`calls`, `imports`, `contains`, `parameter_of`, `receiver`, `type_of`, `implements`, `decorates`, `overloads`, `exports`) + 3 dataflow edge types (`flows_to`, `returns`, `mutates`), with confidence scores on call/import edges | Calls, imports, data flow, control flow, type relationships | **Codegraph** — 13 total edge types with confidence scoring vs. narsil's unscored edges |
| **Call graph** | Import-aware resolution with 6-level confidence scoring, qualified call filtering | `get_call_graph`, `get_callers`, `get_callees`, `find_call_path` | **Codegraph** for precision (confidence scoring); **Narsil** for completeness |
| **Control flow graph** | Intraprocedural CFG for all 11 languages via `cfg` command / `cfg` MCP tool | `get_control_flow` — basic blocks + branch conditions | **Tie** — both have intraprocedural CFG |
| **Data flow analysis** | `flows_to`/`returns`/`mutates` edges via `dataflow` command / `dataflow` MCP tool (all 11 languages) | `get_data_flow`, `get_reaching_definitions`, `find_uninitialized`, `find_dead_stores` | **Tie** — narsil has 4 dedicated tools (reaching defs, dead stores); codegraph covers all 11 languages with unified dataflow edges |
| **Type inference** | No full type inference, but `qualified_name`, `scope`, `visibility` metadata on all symbols + receiver type tracking with graded confidence | `infer_types`, `check_type_errors` for Python/JS/TS | **Narsil** — full type inference vs. codegraph's metadata-level type tracking. Gap narrowed |
| **Dead code detection** | `roles --role dead` — unreferenced non-exported symbols | `find_dead_code` — unreachable code paths via CFG | **Both** — complementary approaches (structural vs. control-flow) |
| **Complexity metrics** | Cognitive, cyclomatic, Halstead, MI, nesting depth per function | Cyclomatic complexity only | **Codegraph** — 5 metrics vs 1 |
| **Node role classification** | Auto-tags: `entry`/`core`/`utility`/`adapter`/`dead`/`leaf` | Not available | **Codegraph** |
| **Community detection** | Louvain algorithm with drift analysis | Not available | **Codegraph** |
| **Impact analysis** | `fn-impact`, `diff-impact` (git-aware), `impact` (file-level) | Not purpose-built | **Codegraph** — first-class impact commands |
| **Sequence diagrams** | `sequence` command — generates Mermaid sequence diagrams from call chains | Not available | **Codegraph** |
| **Shortest path** | `path <from> <to>` — BFS between symbols | `find_call_path` — between functions | **Tie** |
| **SPARQL / Knowledge graph** | Not available | RDF graph via Oxigraph, SPARQL queries, predefined templates | **Narsil** — unique capability |
| **Code Context Graph (CCG)** | Not available | 4-layer hierarchical context (L0-L3) with JSON-LD/N-Quads export | **Narsil** — unique capability |

**Summary:** Narsil has broader analysis (type inference, SPARQL, CCG). Codegraph now matches on dataflow (all 11 languages) and is deeper on developer-facing metrics (5 complexity metrics, node roles, community detection, Louvain drift, sequence diagrams) with unique impact analysis commands and 13 edge types with confidence scoring. Narsil's knowledge graph and CCG layering are genuinely novel features with no codegraph equivalent.

---

### C. Search & Retrieval

| Feature | Codegraph | Narsil-MCP | Best Approach |
|---------|-----------|------------|---------------|
| **Keyword search** | BM25 via SQLite FTS5 | BM25 via Tantivy | **Tie** — different engines, same algorithm |
| **Semantic search** | HuggingFace Transformers (local, ~500 MB model) | TF-IDF (local) or neural (Voyage AI/OpenAI/ONNX) | **Narsil** — more backend choices |
| **Hybrid search** | BM25 + semantic with Reciprocal Rank Fusion | BM25 + TF-IDF hybrid | **Codegraph** — RRF fusion with full embeddings is higher quality |
| **Code similarity** | Not available | `find_similar_code`, `find_similar_to_symbol` | **Narsil** |
| **Semantic clone detection** | Not available | `find_semantic_clones` (Type-3/4 clones) | **Narsil** |
| **AST-aware chunking** | Not available | `get_chunks`, `get_chunk_stats` — respects AST boundaries | **Narsil** |
| **Symbol search** | `where` with name, kind, file, role filters | `find_symbols`, `workspace_symbol_search`, `find_references`, `find_symbol_usages` | **Narsil** — more search modes |
| **Export map** | `list-functions` with filters | `get_export_map` — all exported symbols per module | **Tie** — different interfaces, similar data |
| **Search latency** | Depends on FTS5/embedding model | <1μs exact, 16μs fuzzy, 80μs BM25, 130μs TF-IDF, 151μs hybrid | **Narsil** — published sub-millisecond benchmarks |

**Summary:** Narsil has more search tools (similarity, clone detection, AST chunking) and more embedding backends. Codegraph has higher-quality hybrid search (RRF with full transformer embeddings vs. TF-IDF). For AI agent context preparation, narsil's AST-aware chunking is a notable gap.

---

### D. Security Analysis

| Feature | Codegraph | Narsil-MCP | Best Approach |
|---------|-----------|------------|---------------|
| **Taint analysis** | Not available | `trace_taint`, `get_taint_sources`, `get_typed_taint_flow` | **Narsil** |
| **Vulnerability scanning** | Not available | `scan_security` with 147 built-in YAML rules | **Narsil** |
| **OWASP Top 10** | Not available | `check_owasp_top10` — dedicated compliance check | **Narsil** |
| **CWE Top 25** | Not available | `check_cwe_top25` — dedicated compliance check | **Narsil** |
| **Secret scanning** | Not available | Rules in `secrets.yaml` | **Narsil** |
| **SBOM generation** | Not available | `generate_sbom` — Software Bill of Materials | **Narsil** |
| **License compliance** | Not available | `check_licenses` | **Narsil** |
| **Dependency vulnerabilities** | Not available | `check_dependencies` — CVE checking | **Narsil** |
| **Vulnerability explanation** | Not available | `explain_vulnerability`, `suggest_fix` | **Narsil** |
| **Crypto misuse detection** | Not available | Rules in `crypto.yaml` | **Narsil** |
| **IaC security** | Not available | Rules in `iac.yaml` | **Narsil** |
| **Language-specific rules** | Not available | Rust, Elixir, Go, Java, C#, Kotlin, Bash rule files (+36 rules: 18 Rust + 18 Elixir) | **Narsil** |

**Summary:** Narsil dominates security analysis completely with 147+ rules across 12+ rule files (including +36 language-specific rules for Rust and Elixir). Codegraph has zero security features today — by design (FOUNDATION.md P8). OWASP pattern detection is on the roadmap as lightweight AST-based checks (BACKLOG ID 7), not taint analysis.

---

### E. Query Language & Interface

| Feature | Codegraph | Narsil-MCP | Best Approach |
|---------|-----------|------------|---------------|
| **Primary interface** | Full CLI with 41 commands + MCP server | MCP server (primary) + config management CLI | **Codegraph** — usable without MCP client |
| **Standalone CLI queries** | `where`, `query`, `audit --quick`, `context`, `deps`, `exports`, `impact`, `map`, `dataflow`, `cfg`, `ast`, etc. | Not available — all queries via MCP tools | **Codegraph** — narsil requires an MCP client for any query |
| **MCP tools count** | 32 purpose-built tools | 90 tools across 14 categories | **Narsil** — ~3x more tools |
| **Compound queries** | `context` (source + deps + callers + tests), `explain`, `audit` | No compound tools — each tool is atomic | **Codegraph** — purpose-built for agent token efficiency |
| **Batch queries** | `batch` command for multi-target dispatch | No batch mechanism | **Codegraph** |
| **JSON output** | `--json` flag on every command | MCP JSON responses | **Tie** |
| **NDJSON streaming** | `--ndjson` with `--limit`/`--offset` on ~14 commands | `--streaming` flag for large results | **Tie** |
| **Pagination** | Universal `limit`/`offset` on all 32 MCP tools with per-tool defaults | Not documented | **Codegraph** |
| **SPARQL queries** | Not available | `sparql_query`, predefined templates | **Narsil** — unique expressiveness |
| **Configuration presets** | Not available | Minimal (~26 tools), Balanced (~51), Full (75+), Security-focused | **Narsil** — manages token cost per preset |
| **Visualization** | DOT, Mermaid, JSON, GraphML, GraphSON, Neo4j CSV export + interactive HTML viewer (`codegraph plot`) | Built-in web UI (Cytoscape.js) with interactive graphs + full SPA frontend (v1.6.0): file tree sidebar, syntax-highlighted code viewer, dashboard, per-repo overview, CFG visualization | **Narsil** — SPA frontend with file browser and dashboard is significantly richer than codegraph's interactive HTML viewer |
| **Programmatic API** | Full JS API: `import { buildGraph, queryNameData } from '@optave/codegraph'` | No library API | **Codegraph** — embeddable in JS/TS projects |

**Summary:** Codegraph is more accessible (full CLI + API + MCP). Narsil has more MCP tools (90 vs 32) but no standalone query interface — completely dependent on MCP clients. Narsil's new SPA frontend (v1.6.0) with file tree, syntax viewer, and dashboard is a significant UI advantage. Codegraph's compound commands (`context`, `explain`, `audit`) reduce agent round-trips; narsil requires multiple atomic tool calls for equivalent context. Narsil's configuration presets are a smart approach to managing MCP tool token costs.

---

### F. Performance & Resource Usage

| Feature | Codegraph | Narsil-MCP | Best Approach |
|---------|-----------|------------|---------------|
| **Cold build (small, ~50 files)** | <2 seconds | ~220ms | **Narsil** (faster cold start) |
| **Cold build (medium, ~3,000 files)** | 5-15 seconds | ~2 seconds (50K symbols) | **Narsil** (faster cold start) |
| **Incremental rebuild (1 file changed)** | <500ms | Full re-index | **Codegraph** (100-1,000x faster for incremental) |
| **Memory usage** | <100 MB typical (SQLite-backed) | In-memory — grows with codebase size | **Codegraph** — predictable, bounded by SQLite |
| **Persistence** | SQLite by default — always persisted | In-memory by default. `--persist` opt-in | **Codegraph** — survives restarts without flag |
| **Startup time** | <100ms (Node.js, reads existing DB) | Index from scratch unless persisted | **Codegraph** — always has a warm DB |
| **Storage format** | SQLite file (compact, portable, universally readable) | Custom binary format (Tantivy + DashMap serialization) | **Codegraph** — SQLite is universally inspectable |
| **Symbol lookup** | SQL query on indexed column | <1μs (DashMap in-memory) | **Narsil** — in-memory is faster for hot lookups |
| **Search latency** | FTS5/embedding dependent | 80μs BM25, 130μs TF-IDF | **Narsil** — published sub-ms benchmarks |
| **Binary size** | ~50 MB (with WASM grammars) | ~30 MB (native feature set) | **Narsil** (smaller) |
| **Watch mode** | Built-in `watch` command | `--watch` flag | **Tie** |
| **Commit hook viability** | Yes — <500ms incremental rebuilds | Possible but re-indexes fully | **Codegraph** — incremental makes hooks invisible |
| **CI pipeline viability** | `check --staged` returns exit code 0/1 | No CI-specific tooling | **Codegraph** |

**Summary:** Narsil is faster for cold starts and hot lookups (pure Rust + in-memory). Codegraph is vastly faster for incremental workflows — the 1-file-changed scenario that defines developer loops, commit hooks, and agent iterations. Codegraph's SQLite persistence means no re-indexing on restart; narsil defaults to in-memory and loses state.

---

### G. Installation & Deployment

| Feature | Codegraph | Narsil-MCP | Best Approach |
|---------|-----------|------------|---------------|
| **Install method** | `npm install @optave/codegraph` | brew, scoop, cargo, npm, AUR, nix, install scripts | **Narsil** — more package managers |
| **Runtime dependency** | Node.js >= 20 | None (single binary) | **Narsil** — zero runtime deps |
| **Docker** | Not required | Not required | **Tie** |
| **Platform binaries** | npm auto-resolves `@optave/codegraph-{platform}-{arch}` | Prebuilt for macOS/Linux/Windows | **Tie** |
| **Browser build** | Not available | WASM package `@narsil-mcp/wasm` (~3 MB) | **Narsil** |
| **Configuration** | `.codegraphrc.json` + env vars + `apiKeyCommand` | `.narsil.yaml` + env vars + presets + interactive wizard | **Narsil** — more options including wizard |
| **Config management** | Manual file editing | `narsil-mcp config init/show/validate` | **Narsil** — built-in config tooling |
| **Editor integration** | Claude Code MCP config | Pre-built configs for Claude Code, Cursor, VS Code, Zed, JetBrains | **Narsil** — more pre-built editor configs |
| **Uninstall** | `npm uninstall` | Package manager dependent | **Tie** |

**Summary:** Narsil is easier to install (single binary, more package managers, no Node.js required) and has better editor integration configs. Codegraph's npm-based install is simpler for Node.js developers but requires Node.js. Narsil's interactive config wizard and preset system lower the barrier to entry.

---

### H. AI Agent & MCP Integration

| Feature | Codegraph | Narsil-MCP | Best Approach |
|---------|-----------|------------|---------------|
| **MCP tools** | 32 purpose-built tools | 90 tools across 14 categories | **Narsil** (~3x more tools) |
| **Token efficiency** | `context`/`explain`/`audit` compound commands reduce round-trips 50-80% | Atomic tools only. Forgemax integration collapses 90 → 2 tools (~1,000 vs ~12,000 tokens) | **Codegraph** natively; **Narsil** via Forgemax |
| **Tool token cost** | ~6,000 tokens for 32 tool definitions | ~12,000 tokens for full set. Presets: Minimal ~4,600, Balanced ~8,900 | **Codegraph** — lower base cost. Narsil presets help |
| **Pagination** | Universal `limit`/`offset` on all 32 tools with per-tool defaults, hard cap 1,000 | `--streaming` for large results | **Codegraph** — structured pagination metadata |
| **Multi-repo support** | Registry-based, opt-in via `--multi-repo` or `--repos` | Multi-repo by default, `discover_repos` auto-detection | **Narsil** for convenience; **Codegraph** for security |
| **Single-repo isolation** | Default — tools have no `repo` property unless `--multi-repo` | Not default — multi-repo access is always available | **Codegraph** — security-conscious default |
| **Programmatic embedding** | Full JS API for VS Code extensions, CI pipelines, other MCP servers | No library API | **Codegraph** |
| **CCG context layers** | Not available | L0-L3 hierarchical context for progressive disclosure | **Narsil** — novel approach to context management |
| **Remote repo indexing** | Not available | `add_remote_repo` clones and indexes GitHub repos | **Narsil** |

**Summary:** Narsil has ~3x more MCP tools but higher token overhead. Codegraph's compound commands are more token-efficient per query. Narsil's CCG layering and configuration presets are innovative approaches to managing AI agent context budgets. Codegraph's programmatic API enables embedding scenarios narsil cannot serve.

---

### I. Developer Productivity Features

| Feature | Codegraph | Narsil-MCP | Best Approach |
|---------|-----------|------------|---------------|
| **Impact analysis (function-level)** | `fn-impact <name>` — transitive callers + downstream | Not purpose-built | **Codegraph** |
| **Impact analysis (git-aware)** | `diff-impact --staged` / `diff-impact main` | Not available | **Codegraph** |
| **CI gate** | `check --staged` — exit code 0/1 (cycles, complexity, blast radius, boundaries) | Not available | **Codegraph** |
| **Complexity metrics** | Cognitive, cyclomatic, Halstead, MI, nesting depth per function | Cyclomatic only (`get_complexity`) | **Codegraph** (5 metrics vs 1) |
| **Code health manifesto** | Configurable rule engine with warn/fail thresholds | Not available | **Codegraph** |
| **Structure analysis** | `structure` — directory hierarchy with cohesion scores | `get_project_structure` — directory tree only | **Codegraph** — includes cohesion metrics |
| **Hotspot detection** | `hotspots` — files/dirs with extreme fan-in/fan-out/density | `get_function_hotspots` — most-called/most-complex + git churn hotspots | **Tie** — different hotspot types |
| **Co-change analysis** | `co-change` — git history for files that change together | Not available | **Codegraph** |
| **Branch comparison** | `branch-compare` — structural diff between branches | Not available | **Codegraph** |
| **Triage/risk ranking** | `triage` — ranked audit queue by composite risk score | Not available | **Codegraph** |
| **CODEOWNERS integration** | `owners` — maps functions to code owners | Not available | **Codegraph** |
| **Semantic search** | `search` — BM25 + semantic with RRF | `semantic_search`, `hybrid_search` | **Tie** |
| **Watch mode** | `watch` — live incremental rebuilds | `--watch` flag for auto-reindex | **Tie** |
| **Snapshot management** | `snapshot save/restore` — DB backup/restore | Not available | **Codegraph** |
| **Execution flow tracing** | `flow` — from entry points through callees | `get_control_flow` — within a function | **Codegraph** for cross-function; **Narsil** for intraprocedural |
| **Module overview** | `map` — high-level module map with most-connected nodes | Not purpose-built | **Codegraph** |
| **Cycle detection** | `cycles` — circular dependency detection | `find_circular_imports` — circular import chains | **Tie** |
| **Architecture boundaries** | Configurable rules with onion preset | Not available | **Codegraph** |
| **Sequence diagrams** | `sequence` command — Mermaid sequence diagrams from call chains | Not available | **Codegraph** |
| **Dead export detection** | `exports --unused` — finds exported symbols with no consumers | Not available | **Codegraph** |
| **Node role classification** | `entry`/`core`/`utility`/`adapter`/`dead`/`leaf` per symbol | Not available | **Codegraph** |
| **Audit command** | `audit` — explain + impact + health in one call | Not available | **Codegraph** |
| **Git integration** | `diff-impact`, `co-change`, `branch-compare` | `get_blame`, `get_file_history`, `get_recent_changes`, `get_symbol_history`, `get_contributors`, `get_hotspots` | **Narsil** for git data breadth; **Codegraph** for git-aware analysis |
| **Export formats** | DOT, Mermaid, JSON, GraphML, GraphSON, Neo4j CSV + interactive HTML viewer | Cytoscape.js interactive UI, JSON-LD, N-Quads, RDF | **Tie** — both have interactive visualization and rich export formats |

**Summary:** Codegraph has 17+ purpose-built developer productivity commands that narsil lacks (impact analysis, manifesto, triage, boundaries, co-change, branch-compare, audit, structure, CODEOWNERS). Narsil has richer git integration tools (blame, contributors, symbol history) and interactive visualization. For the "what breaks if I change this?" workflow, codegraph is the clear choice.

---

### J. Ecosystem & Community

| Feature | Codegraph | Narsil-MCP | Best Approach |
|---------|-----------|------------|---------------|
| **GitHub stars** | Growing | 129 | **Narsil** (slightly) |
| **License** | Apache-2.0 | Apache-2.0 OR MIT (dual) | **Narsil** — dual license is more permissive |
| **Release cadence** | As needed | v1.6.1 (Feb 2026); no activity since Feb 25 (24+ day gap) | **Codegraph** — narsil's development appears stalled |
| **Test suite** | Vitest | 1,763+ tests + criterion benchmarks | **Narsil** — more tests, published benchmarks |
| **Documentation** | CLAUDE.md + CLI `--help` | narsilmcp.com + README + editor configs | **Narsil** — dedicated docs site |
| **Commercial backing** | Optave AI Solutions Inc. | Open-core model (narsil-cloud private repo) | **Both** — different business models |
| **Integration ecosystem** | MCP + programmatic API | Forgemax, Ralph, Claude Code plugin | **Narsil** — more third-party integrations |
| **Browser story** | Not available | WASM package for browser-based analysis | **Narsil** |
| **SPA frontend** | Not available | Full SPA (v1.6.0): file tree sidebar, syntax-highlighted code viewer, dashboard, per-repo overview, CFG visualization | **Narsil** — full web application vs. codegraph's interactive HTML viewer |
| **Security rules** | Not available | 147+ built-in YAML rules including +36 language-specific rules (18 Rust + 18 Elixir) | **Narsil** |
| **CCG standard** | Not available | Code Context Graph — a proposed standard for AI code context | **Narsil** — potential industry standard |

**Summary:** Narsil has a more developed ecosystem (docs site, editor configs, third-party integrations, browser build, SPA frontend, CCG standard). Both are commercially backed. Narsil's open-core model (commercial cloud features in private repo) is a viable business approach. However, narsil has had no activity since Feb 25 (24+ day gap as of this writing), which raises questions about development momentum.

---

## Where Each Tool is the Better Choice

### Choose Codegraph when:

1. **You need the graph to stay current in tight feedback loops** — commit hooks, watch mode, AI agent loops. Codegraph's incremental <500ms rebuilds vs. narsil's full re-index.
2. **You need a standalone CLI** — `codegraph where`, `codegraph explain`, `codegraph context` work without any MCP client. Narsil requires an MCP client for all queries.
3. **You need impact analysis** — `diff-impact --staged` tells you what breaks before committing. Narsil has no equivalent.
4. **You need CI gates** — `check --staged` returns exit 0/1 for cycles, complexity, blast radius, boundaries. Narsil has no CI tooling.
5. **You need developer productivity features** — complexity metrics (5 types), manifesto rules, architecture boundaries, co-change analysis, triage. These don't exist in narsil.
6. **You want confidence-scored results** — every call edge has a 0.0-1.0 confidence score. Narsil's edges are unscored.
7. **You're embedding in a JS/TS project** — full programmatic API. Narsil has no library API.
8. **You want single-repo security by default** — codegraph's MCP exposes only one repo unless you opt in to multi-repo.

### Choose Narsil-MCP when:

1. **You need security analysis** — taint tracking, OWASP/CWE compliance, SBOM, license scanning, 147 built-in rules. Codegraph has zero security features.
2. **You need broad language coverage** — 32 languages vs 11. Critical for polyglot enterprises.
3. **You need advanced data flow analysis** — reaching definitions, dead stores, uninitialized variables. Codegraph now has dataflow across all 11 languages, but narsil has 4 specialized tools (reaching defs, dead stores, uninitialized, taint).
4. **You need type inference** — infer types for untyped Python/JS/TS code. Codegraph has no type analysis.
5. **You want richer interactive visualization** — built-in Cytoscape.js web UI with drill-down, overlays, and clustering. Codegraph now has `codegraph plot` with interactive HTML, but narsil's UI is more feature-rich.
6. **You need a single binary with no runtime deps** — `brew install narsil-mcp` and done. No Node.js required.
7. **You're building an MCP-first agent pipeline** — 90 tools cover nearly every code analysis need. One server, one config.
8. **You want a browser-based analysis tool** — narsil's WASM build runs analysis in the browser.
9. **You need SPARQL/RDF knowledge graph** — unique capability for semantic code querying.
10. **You need code similarity / clone detection** — `find_similar_code`, `find_semantic_clones`. Codegraph has no similarity tools.

### Use both together when:

- **CI pipeline**: Codegraph for fast structural checks on every commit (`check --staged`), narsil for periodic security scans.
- **AI agent workflow**: Codegraph's compound commands for fast structural context; narsil's security tools for vulnerability assessment.
- **Pre-commit + periodic audit**: Codegraph in commit hooks (fast, incremental), narsil for weekly security/compliance reports.

---

## Key Metrics Summary

| Metric | Codegraph | Narsil-MCP | Winner |
|--------|-----------|------------|--------|
| Incremental rebuild speed | <500ms | N/A (full re-index) | Codegraph |
| Cold build speed | Seconds | Sub-seconds to seconds | Narsil |
| Memory usage | <100 MB typical | Grows with codebase (in-memory) | Codegraph |
| Install complexity | `npm install` (requires Node.js) | Single binary (brew/scoop/cargo) | Narsil |
| Analysis depth (structural) | High (impact, complexity, roles, CFG, dataflow) | High (CFG, DFG, type inference) | Tie |
| Analysis depth (security) | None | Best in class (147 rules, taint) | Narsil |
| AI agent integration | 32-tool MCP + compound commands | 90-tool MCP + presets + CCG | Narsil for breadth; Codegraph for efficiency |
| Developer productivity | 41+ commands | Git tools only | Codegraph |
| Language support | 11 | 32 | Narsil |
| Standalone CLI | 41 commands | Config/tools management only | Codegraph |
| Programmatic API | Full JS API | None | Codegraph |
| Community & maturity | New | Newer (Dec 2025); no activity since Feb 25 | Codegraph |
| CI/CD readiness | Yes (`check --staged`) | No CI tooling | Codegraph |
| Visualization | DOT/Mermaid/JSON/GraphML/GraphSON/Neo4j CSV + interactive HTML | Interactive Cytoscape.js web UI | Tie |
| Search backends | FTS5 + HuggingFace local | Tantivy + TF-IDF + Voyage/OpenAI/ONNX | Narsil |

**Final score against FOUNDATION.md principles: Codegraph 4, Narsil 0, Tie 4.**
Narsil competes much more closely on codegraph's principles than Joern does. The gap is in incremental rebuilds (P1), confidence scoring (P3), CLI + API (P5), and single-repo isolation (P7).

---

## Narsil-Inspired Feature Candidates

Features extracted from **all comparison sections** above, assessed using the [BACKLOG.md](../../docs/roadmap/BACKLOG.md) tier and grading system. See the [Scoring Guide](../../docs/roadmap/BACKLOG.md#scoring-guide) for column definitions.

### Tier 1 — Zero-dep + Foundation-aligned (build these first)

Non-breaking, ordered by problem-fit:

| ID | Title | Description | Source | Category | Benefit | Zero-dep | Foundation-aligned | Problem-fit (1-5) | Breaking |
|----|-------|-------------|--------|----------|---------|----------|-------------------|-------------------|----------|
| N1 | MCP tool presets | Configurable MCP tool subsets (minimal/balanced/full/custom) that control which tools are registered. Reduces tool-definition token cost from ~4,000 to ~2,000 for minimal sets. Inspired by narsil's preset system (Minimal ~4,600 tokens, Balanced ~8,900, Full ~12,000). | E, H | Embeddability | Agents with small context windows get only the tools they need — directly reduces token waste on tool definitions | ✓ | ✓ | 5 | No |
| N2 | AST-aware code chunking | Split files into semantic chunks that respect AST boundaries (functions, classes, blocks) instead of naive line splits. Expose as MCP tool and CLI command. Inspired by narsil's `get_chunks`/`get_chunk_stats`. | C | Navigation | Agents get correctly-bounded code snippets for context windows — no more mid-function splits that confuse LLMs | ✓ | ✓ | 5 | No |
| N3 | Code similarity search | Find code structurally similar to a given snippet or symbol using AST fingerprinting or embedding cosine similarity on existing search infrastructure. Inspired by narsil's `find_similar_code`/`find_similar_to_symbol`. | C | Search | Agents can find related implementations for refactoring, deduplication, and pattern learning — reduces re-invention and catches copy-paste drift | ✓ | ✓ | 4 | No |
| N4 | Git blame & symbol history | Surface `git blame` data per function and track how symbols change over commits. Complement existing `co-change` with per-symbol history. Inspired by narsil's `get_blame`/`get_symbol_history`/`get_contributors`. | I | Analysis | Agents know who last touched a function and how it evolved — critical context for review, ownership, and understanding intent behind changes | ✓ | ✓ | 4 | No |
| N5 | Remote repo indexing | Allow `codegraph build <github-url>` to clone and index a remote repository. Useful for comparing dependencies, upstream libraries, or reviewing PRs on forks. Inspired by narsil's `add_remote_repo`. | H | Developer Experience | Agents can analyze dependencies and upstream repos without manual cloning — enables cross-repo context gathering in one command | ✓ | ✓ | 3 | No |
| N6 | Configuration wizard | Interactive `codegraph init` that detects project structure, suggests `.codegraphrc.json` settings, and auto-configures MCP for the user's editor. Inspired by narsil's `config init` wizard and pre-built editor configs. | G | Developer Experience | Reduces setup friction — new users get a working config in seconds instead of reading docs | ✓ | ✓ | 2 | No |
| N7 | Kotlin language support | Add tree-sitter-kotlin to `LANGUAGE_REGISTRY`. 1 registry entry + 1 extractor. Narsil covers 32 languages; Kotlin is the highest-value gap for codegraph's target audience (Android/KMP). | A | Parsing | Extends coverage to Android/KMP — closes the most impactful language gap vs. narsil | ✓ | ✓ | 2 | No |
| N8 | Swift language support | Add tree-sitter-swift to `LANGUAGE_REGISTRY`. 1 registry entry + 1 extractor. Narsil covers Swift; codegraph does not. | A | Parsing | Extends coverage to Apple/iOS — closes a visible language gap | ✓ | ✓ | 2 | No |
| N9 | Bash language support | Add tree-sitter-bash to `LANGUAGE_REGISTRY`. 1 registry entry + 1 extractor. Bash scripts are ubiquitous in CI/CD and developer tooling. | A | Parsing | Covers CI scripts, Dockerfiles, and developer tooling — commonly co-located with source code | ✓ | ✓ | 2 | No |
| N10 | Scala language support | Add tree-sitter-scala to `LANGUAGE_REGISTRY`. 1 registry entry + 1 extractor. Relevant for JVM ecosystem coverage. | A | Parsing | Closes language gap for JVM polyglot codebases | ✓ | ✓ | 2 | No |

Breaking — **completed in v3.0.0:**

| ID | Title | Status | Description |
|----|-------|--------|-------------|
| N11 | Export map per module | **DONE v3.0.0** | `codegraph exports <file>` command / `file_exports` MCP tool — lists all exported symbols with per-symbol consumers. |

### Tier 2 — Foundation-aligned, needs dependencies

Ordered by problem-fit:

| ID | Title | Description | Source | Category | Benefit | Zero-dep | Foundation-aligned | Problem-fit (1-5) | Breaking |
|----|-------|-------------|--------|----------|---------|----------|-------------------|-------------------|----------|
| N12 | Interactive HTML visualization | **DONE v3.0.0** | `codegraph plot` opens interactive HTML viewer. |
| N13 | Multiple embedding backends | Support Voyage AI, OpenAI, and ONNX as alternative embedding providers alongside existing HuggingFace Transformers. Inspired by narsil's `--neural-backend api\|onnx` with model selection. Already partially on roadmap (BACKLOG ID 8). | C | Search | Users who already pay for an LLM provider get better embeddings at no extra cost — and local ONNX gives a lighter alternative to the 500MB transformer model | ✗ | ✓ | 3 | No |

### Tier 3 — Not foundation-aligned (needs deliberate exception)

| ID | Title | Description | Source | Category | Benefit | Zero-dep | Foundation-aligned | Problem-fit (1-5) | Breaking |
|----|-------|-------------|--------|----------|---------|----------|-------------------|-------------------|----------|
| N14 | OWASP/CWE pattern detection | Lightweight AST-based security scanning using YAML rule files. Not taint analysis — pattern matching on AST nodes (e.g. `eval()`, hardcoded secrets, SQL string concatenation). Inspired by narsil's 147-rule security engine. Already on roadmap (BACKLOG ID 7). | D | Security | Catches low-hanging security issues during `diff-impact`; agents flag risky patterns before they're committed | ✓ | ✗ | 1 | No |
| N15 | SBOM generation | Generate a Software Bill of Materials from `package.json`/`requirements.txt`/`go.mod`. Lightweight — parse manifest files already in scope. Inspired by narsil's `generate_sbom`. | D | Security | Supply chain visibility without external tools — useful for compliance audits | ✓ | ✗ | 1 | No |

### Not adopted (violates FOUNDATION.md)

These narsil-mcp features were evaluated and deliberately excluded:

| Narsil Feature | Section | Why Not |
|----------------|---------|---------|
| **Taint analysis** | D | Requires control-flow and data-dependence infrastructure. Would 10-100x build time, violating P1. Narsil's tree-sitter-based taint is impressive but trades performance for depth |
| **Type inference engine** | B | Requires language-specific type solvers beyond tree-sitter AST. Violates P6 (one registry, no magic). Lightweight type annotation extraction (Joern-inspired J2) is the pragmatic alternative |
| **SPARQL / RDF knowledge graph** | B, E | Requires Oxigraph dependency. SQLite + existing query commands serve our use case. RDF/SPARQL is overkill for structural code intelligence — powerful but orthogonal to our goals |
| **Code Context Graph (CCG) standard** | B, H | Interesting concept but tightly coupled to narsil's architecture and commercial model. Our MCP pagination + compound commands solve the progressive-disclosure problem differently |
| **In-memory-first architecture** | F | Violates P1 (graph must survive restarts to stay always-current). SQLite persistence is a deliberate choice — narsil's opt-in persistence means state loss on every restart by default |
| **90-tool MCP surface** | E, H | More tools = more token overhead per agent session. Our 32 purpose-built tools + compound commands are more token-efficient. Narsil compensates with presets; we compensate with fewer, smarter tools |
| **Browser WASM build** | G, J | Different product category. We're a CLI/MCP engine, not a browser tool (P8). Narsil's WASM build is a legitimate capability, but building a browser runtime is outside our scope |
| **Forgemax-style tool collapsing** | H | Collapses 90 tools to 2 (`search`/`execute`). We don't need this because we already have 32 tools — small enough that collapsing adds complexity without meaningful savings |
| **LSP integration** | B | Requires running language servers alongside codegraph. Violates zero-dependency goal. Tree-sitter + confidence scoring is our approach; LSP is a different architectural bet |
| **License compliance scanning** | D | Tangential to code intelligence. Better served by dedicated tools (FOSSA, Snyk, etc.) |

### Cross-references to existing BACKLOG items

These narsil-inspired capabilities are already tracked in [BACKLOG.md](../../docs/roadmap/BACKLOG.md):

| BACKLOG ID | Title | Narsil Equivalent | Relationship |
|------------|-------|-------------------|--------------|
| 7 | OWASP/CWE pattern detection | `scan_security` with 147 rules | Lightweight AST-based alternative to narsil's full rule engine. N14 above. Still Tier 3. Unblocked by stored AST (v3.0.0). |
| 8 | Optional LLM provider integration | `--neural-backend api\|onnx` | Multiple embedding providers. N13 above. Still Tier 2. |
| 10 | Interactive HTML visualization | Built-in Cytoscape.js frontend | **DONE v3.0.0.** `codegraph plot` opens interactive HTML viewer. N12 above. |
| 14 | Dataflow analysis | `get_data_flow`, `get_reaching_definitions` | **DONE v3.2.0.** Intraprocedural dataflow with `flows_to`/`returns`/`mutates` edges. All 11 languages. CLI: `codegraph dataflow`. MCP: `dataflow` tool. |

### Cross-references to Joern-inspired candidates

Some features identified in this analysis overlap with [Joern-inspired candidates](./joern.md#joern-inspired-feature-candidates):

| Joern ID | Title | Narsil Equivalent | Note |
|----------|-------|-------------------|------|
| J4 | Kotlin language support | Narsil's 32-language coverage | Same feature, dual motivation. Listed here as N7 |
| J5 | Swift language support | Narsil's 32-language coverage | Same feature, dual motivation. Listed here as N8 |
| J8 | Intraprocedural CFG | `get_control_flow` | **DONE v3.0.0.** `codegraph cfg` / `cfg` MCP tool. All 11 languages. |
| J9 | Stored queryable AST | AST-aware chunking + pattern matching | **DONE v3.0.0.** `codegraph ast` / `ast_query` MCP tool. Stored calls, new, string, regex, throw, await. |
