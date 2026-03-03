# Competitive Deep-Dive: Codegraph vs narsil-mcp

**Date:** 2026-03-02
**Competitors:** `@optave/codegraph` v0.x (Apache-2.0) vs `postrv/narsil-mcp` v1.6.x (Apache-2.0 / MIT)
**Context:** narsil-mcp is ranked #2 in our [competitive analysis](../COMPETITIVE_ANALYSIS.md) with a score of 4.5, tied with Joern at #1. Unlike Joern (which targets security researchers), narsil-mcp competes head-to-head with codegraph — same parsing technology (tree-sitter), same delivery mechanism (MCP), same target audience (AI agents), same local-first philosophy.

---

## Executive Summary

Narsil-mcp and codegraph are the two closest competitors in the code intelligence MCP space. Both use tree-sitter for parsing, both expose tools via MCP, and both target AI coding agents. They diverge sharply in philosophy: narsil-mcp maximizes surface area (90 tools, 32 languages, security scanning, SPARQL, CCG standard), while codegraph maximizes depth-per-tool and always-current guarantees (persistent incremental graph, confidence-scored edges, compound commands, CI gates).

| Dimension | narsil-mcp | Codegraph |
|-----------|------------|-----------|
| **Primary mission** | Comprehensive code intelligence for AI agents via maximum tool coverage | Always-current structural code intelligence with scored, actionable results |
| **Target user** | AI coding agents (Claude, Cursor, Windsurf) | Developers, AI coding agents, CI pipelines |
| **Graph model** | RDF knowledge graph (Oxigraph) + in-memory symbol maps | Structural dependency graph (SQLite) with confidence-scored edges |
| **Core question answered** | "What does this code do and is it secure?" | "What breaks if I change this function?" |
| **Rebuild model** | In-memory incremental; full re-index on restart unless `--persist` | Persistent incremental (SQLite); sub-second rebuilds survive restarts |
| **Runtime** | Rust binary (~30-50 MB) | Node.js + optional native Rust addon (<100 MB working set) |

**Bottom line:** narsil-mcp casts the widest net — more languages, more tools, more analysis types. Codegraph goes deeper on the problems that matter most for iterative development — persistent incremental builds, confidence scoring, impact analysis, and CI integration. narsil-mcp is a feature-rich index; codegraph is an always-current dependency graph with actionable intelligence.

---

## Problem Alignment with FOUNDATION.md

Codegraph's foundation document defines the problem as: *"Fast local analysis with no AI, or powerful AI features that require full re-indexing through cloud APIs on every change. None of them give you an always-current graph."*

### Principle-by-principle evaluation

| # | Principle | Codegraph | narsil-mcp | Verdict |
|---|-----------|-----------|------------|---------|
| 1 | **The graph is always current** — rebuild on every commit/save/agent loop | Persistent SQLite with file-level MD5 hashing. Change 1 file in 3,000 → <500ms rebuild. Graph survives restarts, watch mode, commit hooks all practical | Merkle-tree incremental parsing within a session. But in-memory by default — full re-index on every server restart unless `--persist` is used. Persistence is opt-in, not default | **Codegraph wins.** Persistence-by-default vs. persistence-as-afterthought. An "always-current" graph that vanishes on restart isn't always current |
| 2 | **Native speed, universal reach** — dual engine (Rust + WASM) | Native napi-rs with rayon parallelism + automatic WASM fallback. `npm install` on any platform | Pure Rust with rayon parallelism. Browser WASM build available (~3 MB). 8 install methods (Homebrew, Scoop, Cargo, npm, Nix, AUR, shell script, source) | **Tie.** Both achieve native speed with WASM fallback. narsil-mcp has more install methods; codegraph has simpler auto-detection |
| 3 | **Confidence over noise** — scored results | 6-level import resolution with 0.0-1.0 confidence on every edge. False-positive filtering. Graph quality score. Node role classification | No confidence scoring on edges. Results are binary (found/not found). 147 security rules with severity levels, but no structural confidence scoring | **Codegraph wins.** Confidence-scored edges vs. binary results. This is fundamental to codegraph's value proposition |
| 4 | **Zero-cost core, LLM-enhanced when you choose** | Full pipeline local, zero API keys. Optional embeddings with user's LLM provider | Core parsing/search local. Neural search requires API keys (Voyage AI/OpenAI) or heavy ONNX build (+20 MB). Type inference and security scanning are local | **Codegraph wins.** Both are local-first, but narsil-mcp's neural search requires paid API keys by default (local ONNX is a non-default feature flag) |
| 5 | **Functional CLI, embeddable API** | 35+ CLI commands + 18-tool MCP server + full programmatic JS API + `--json` on every command | No standalone CLI — MCP-only interface. 90 MCP tools. No programmatic library API for embedding in other applications | **Codegraph wins.** Codegraph serves three interfaces (CLI + MCP + API). narsil-mcp is MCP-only — unusable without an MCP client. No CI pipeline integration, no `--json` CLI, no embeddable library |
| 6 | **One registry, one schema, no magic** | `LANGUAGE_REGISTRY` — add a language in <100 lines, 2 files. Uniform extraction across all languages | tree-sitter for all 32 languages with language-specific extractors. Adding a language requires Rust code + tree-sitter grammar. Uniform parser, but heavier per-language investment | **Codegraph wins.** Both use tree-sitter uniformly, but codegraph's JS extractors are dramatically simpler to write than narsil-mcp's Rust extractors |
| 7 | **Security-conscious defaults** — multi-repo opt-in | Single-repo MCP default. `apiKeyCommand` for secrets. `--multi-repo` opt-in | Multi-repo by default (`list_repos`, `discover_repos` always exposed). `--remote` flag enables cloning external repos. No credential isolation model | **Codegraph wins.** Single-repo default vs. multi-repo default. narsil-mcp's `discover_repos` and `add_remote_repo` tools are exposed without opt-in |
| 8 | **Honest about what we're not** | Code intelligence engine. Not an app, not a coding tool, not an agent | "Comprehensive code intelligence" — tries to be everything: search engine, security scanner, type checker, SBOM generator, license auditor, knowledge graph, visualization server | **Codegraph wins.** Codegraph has a clear boundary. narsil-mcp's 90-tool surface area spans security, compliance, visualization, type checking, and more — a breadth that risks being shallow everywhere |

**Score: Codegraph 7, narsil-mcp 0, Tie 1** — against codegraph's own principles, codegraph wins on every differentiating dimension. This is expected: the principles were designed around codegraph's value proposition. The feature comparison below examines where narsil-mcp's breadth creates genuine advantages.

---

## Feature-by-Feature Comparison

### A. Parsing & Language Support

| Feature | Codegraph | narsil-mcp | Best Approach |
|---------|-----------|------------|---------------|
| **Parser technology** | tree-sitter (WASM + native Rust) | tree-sitter (native Rust) | **Tie** — same underlying technology |
| **JavaScript** | Full extraction (functions, classes, methods, imports, exports, call sites) | Symbol extraction + call graph + type inference | **Tie** — both strong |
| **TypeScript** | First-class TS + TSX support | First-class TS support + type inference | **Tie** |
| **Python** | tree-sitter extraction | tree-sitter extraction + type inference | **narsil-mcp** — type inference adds value |
| **Go** | tree-sitter (structs, interfaces, methods) | tree-sitter extraction | **Tie** |
| **Rust** | tree-sitter (functions, structs, traits, enums, impls) | tree-sitter extraction (home language — most mature) | **narsil-mcp** — as a Rust project, Rust parsing is likely most battle-tested |
| **Java** | tree-sitter | tree-sitter | **Tie** |
| **C/C++** | tree-sitter | tree-sitter | **Tie** |
| **C#** | tree-sitter | tree-sitter | **Tie** |
| **PHP** | tree-sitter | tree-sitter | **Tie** |
| **Ruby** | tree-sitter | tree-sitter | **Tie** |
| **Terraform/HCL** | tree-sitter | Not supported | **Codegraph** |
| **Kotlin** | Not supported | tree-sitter | **narsil-mcp** |
| **Swift** | Not supported | tree-sitter | **narsil-mcp** |
| **Scala** | Not supported | tree-sitter | **narsil-mcp** |
| **Haskell** | Not supported | tree-sitter | **narsil-mcp** |
| **Elixir/Erlang** | Not supported | tree-sitter | **narsil-mcp** |
| **Dart** | Not supported | tree-sitter | **narsil-mcp** |
| **Zig** | Not supported | tree-sitter | **narsil-mcp** |
| **Lua, Julia, R, Perl, Clojure, Elm, Fortran, PowerShell, Nix, Groovy, Bash, Verilog/SystemVerilog** | Not supported | tree-sitter (14 additional languages) | **narsil-mcp** |
| **Language count** | 11 source languages | 32 source languages | **narsil-mcp** (32 vs 11) |
| **Adding a new language** | 1 registry entry + 1 JS extractor (<100 lines, 2 files) | Rust extractor module + tree-sitter grammar integration | **Codegraph** — dramatically lower barrier to contribution |
| **Incremental parsing** | File-level MD5 hash tracking in SQLite — persists across restarts | Merkle-tree file hashing in memory — lost on restart unless `--persist` | **Codegraph** — persistent by default vs. opt-in persistence |
| **Type inference** | Not available | Python, JavaScript, TypeScript (basic inference from assignments and returns) | **narsil-mcp** |

**Summary:** narsil-mcp supports 3x more languages (32 vs 11) and adds type inference for dynamic languages. Codegraph is easier to extend (JS extractors vs. Rust modules) and has persistent incremental parsing by default. For codegraph's core audience (JS/TS/Python/Go web developers), both tools cover the essential languages. narsil-mcp's long tail (Fortran, Verilog, Elm, etc.) serves niche use cases.

---

### B. Graph Model & Analysis Depth

| Feature | Codegraph | narsil-mcp | Best Approach |
|---------|-----------|------------|---------------|
| **Graph type** | Structural dependency graph (symbols + edges in SQLite) | RDF knowledge graph (Oxigraph) + in-memory symbol/call maps | **Codegraph** for queryability and persistence; **narsil-mcp** for semantic web interop |
| **Storage engine** | SQLite (always persistent, portable, universally readable) | In-memory DashMap + optional Oxigraph + optional Tantivy index | **Codegraph** — SQLite is a proven, inspectable, portable format |
| **Persistence model** | Always persistent (SQLite file) | In-memory by default; `--persist` for disk; lost on restart without it | **Codegraph** — persistence shouldn't be opt-in for a "graph" tool |
| **Node types** | 10 kinds: `function`, `method`, `class`, `interface`, `type`, `struct`, `enum`, `trait`, `record`, `module` | Language-specific symbols (functions, classes, structs, traits, modules, etc.) — count varies by language | **Tie** — similar symbol extraction granularity |
| **Edge types** | `calls`, `imports` — both with confidence scores (0.0-1.0) | `calls`, `imports` — binary (present/absent), no confidence scoring | **Codegraph** — scored edges vs. binary edges |
| **Import resolution** | 6-level priority system with confidence scoring (import-aware → same-file → directory → parent → global → method hierarchy) | Basic import graph extraction from tree-sitter AST | **Codegraph** — sophisticated multi-level resolution vs. AST-level extraction |
| **Call graph** | Import-aware resolution with qualified call filtering and confidence scoring | Call graph analysis with `--call-graph` flag (callers, callees, call paths, hotspots) | **Codegraph** for precision (confidence scoring); **narsil-mcp** for completeness (dedicated call-graph mode) |
| **Control flow graph** | Not available | CFG extraction with `get_control_flow` tool | **narsil-mcp** |
| **Data flow analysis** | Not available | Reaching definitions, dead stores, uninitialized variables via `get_data_flow` tools | **narsil-mcp** |
| **Taint analysis** | Not available | Source-to-sink taint tracking (SQL injection, XSS, command injection, path traversal) | **narsil-mcp** |
| **Dead code detection** | `roles --role dead` — unreferenced non-exported symbols | `find_dead_code` via control flow analysis | **Codegraph** for structural dead code; **narsil-mcp** for unreachable-code-path detection |
| **Complexity metrics** | Cognitive, cyclomatic, Halstead, MI, nesting depth per function | `get_complexity` (cyclomatic only, requires `--call-graph`) | **Codegraph** — 5 metrics vs. 1, always available vs. flag-gated |
| **Node role classification** | Auto-tags every symbol: `entry`/`core`/`utility`/`adapter`/`dead`/`leaf` based on fan-in/fan-out | Not available | **Codegraph** |
| **Community detection** | Louvain algorithm with drift analysis | Not available | **Codegraph** |
| **Impact analysis** | `fn-impact` (function-level), `diff-impact` (git-aware), `impact` (file-level) — all with transitive closure | Not available as a dedicated capability | **Codegraph** — first-class impact analysis is a major differentiator |
| **Shortest path** | `path <from> <to>` — BFS between any two symbols | `find_call_path` — path between functions in call graph | **Tie** — similar capability |
| **SPARQL queries** | Not available | Full SPARQL query support over RDF graph (requires `--graph` feature flag) | **narsil-mcp** — powerful for semantic web integration |
| **Code Context Graph (CCG)** | Not available | Four-layer CCG standard with manifest, architecture, index, and full detail layers | **narsil-mcp** — novel approach to publishing code intelligence |

**Summary:** Codegraph's graph is deeper where it matters for developers: confidence-scored edges, multi-level import resolution, role classification, community detection, and purpose-built impact analysis. narsil-mcp goes wider: CFG, DFG, taint analysis, SPARQL, and CCG. Codegraph's SQLite persistence is a fundamental advantage — narsil-mcp's in-memory default means the "graph" evaporates on restart.

---

### C. Query Language & Interface

| Feature | Codegraph | narsil-mcp | Best Approach |
|---------|-----------|------------|---------------|
| **Primary interface** | CLI (35+ commands) + MCP (18 tools) + JS API | MCP only (90 tools) | **Codegraph** — three interfaces vs. one |
| **Standalone CLI** | Yes — full-featured CLI with `--help`, flags, pipe-friendly output | No — MCP-only, requires an MCP client to use | **Codegraph** — usable without any AI agent |
| **MCP tool count** | 18 purpose-built tools | 90 tools (26-75 active depending on preset) | **narsil-mcp** for breadth; **Codegraph** for token efficiency |
| **Token overhead** | 18 tools ≈ ~3,600 tokens for tool schemas | 90 tools ≈ ~12,000 tokens (full preset). Acknowledged problem — Forgemax gateway created to mitigate | **Codegraph** — 3.3x less token overhead. narsil-mcp's own solution (Forgemax) validates the problem |
| **Compound commands** | `context` (source + deps + callers + tests in 1 call), `explain` (structural summary), `audit` (explain + impact + health) | No compound tools — each tool returns one thing | **Codegraph** — compound commands reduce agent round-trips by 50-80% |
| **Preset system** | Not needed (18 tools is manageable) | `minimal` (26 tools), `balanced` (51), `full` (75+), `security-focused` — category-level enable/disable | **narsil-mcp** — good solution to the breadth problem, but the problem exists because of the breadth |
| **Tool filtering** | `buildToolList(multiRepo)` — single-repo vs. multi-repo | Per-category enable/disable, individual tool overrides, `max_tool_count` | **narsil-mcp** for granularity; **Codegraph** for simplicity |
| **JSON output** | `--json` flag on every CLI command | MCP responses are always structured JSON | **Tie** |
| **Programmatic API** | Full JS API: `import { buildGraph, queryNameData } from '@optave/codegraph'` | No library API — MCP-only | **Codegraph** — embeddable in VS Code extensions, CI pipelines, custom tools |
| **Batch queries** | `batch` command for multi-target dispatch | Not available as a single call | **Codegraph** |
| **SPARQL query language** | Not available | Full SPARQL over RDF graph | **narsil-mcp** — expressive for semantic queries |
| **Visualization** | DOT, Mermaid, JSON export | Embedded web frontend with interactive graph views (call, import, symbol, CFG) — requires `--features frontend` + `--http` | **narsil-mcp** for interactive visualization; **Codegraph** for text-based export |

**Summary:** Codegraph serves three audiences (CLI users, MCP agents, API consumers). narsil-mcp serves one (MCP agents) but with 5x more tools. The 90-tool overhead is significant enough that narsil-mcp's creator built a separate project (Forgemax) to work around it. Codegraph's compound commands achieve more with fewer round-trips.

---

### D. Performance & Resource Usage

| Feature | Codegraph | narsil-mcp | Best Approach |
|---------|-----------|------------|---------------|
| **Cold index (small project, ~50 files)** | <2 seconds | ~220ms (self-benchmark: 53 files in 220ms) | **narsil-mcp** — pure Rust is faster for cold indexing |
| **Cold index (medium project, ~3,000 files)** | 5-15 seconds | ~2.1 seconds (rust-analyzer: 2,847 files in 2.1s) | **narsil-mcp** — native Rust advantage |
| **Cold index (large project, ~80,000 files)** | 30-120 seconds (native Rust engine) | ~45 seconds (Linux kernel: 78K files in 45s) | **narsil-mcp** — but both are fast enough for practical use |
| **Incremental rebuild (1 file changed)** | <500ms (persistent — survives restarts) | Fast within session; full re-index on restart without `--persist` | **Codegraph** — persistent incremental is what matters for "always current" |
| **Memory usage (small project)** | <100 MB | ~50 MB (self-benchmark) | **narsil-mcp** — leaner for small projects |
| **Memory usage (large project)** | 300 MB - 1 GB | ~2.1 GB (Linux kernel benchmark) | **Codegraph** — SQLite offloads to disk; narsil-mcp holds everything in memory |
| **Startup time** | <100ms (Node.js) | Not benchmarked (Rust binary — likely <50ms) | **Tie** — both fast |
| **Parse throughput** | Not benchmarked at this granularity | 1.98 GiB/s (278 KB Rust file in 131μs) | **narsil-mcp** — impressive raw throughput |
| **Search latency (exact match)** | SQL query (<1ms typical) | 483 nanoseconds (in-memory) | **narsil-mcp** — in-memory wins on raw latency |
| **Search latency (fuzzy)** | SQL LIKE queries | 16.5μs fuzzy, 80μs BM25 full-text, 151μs hybrid | **narsil-mcp** — Tantivy is optimized for search |
| **Storage format** | SQLite file (compact, portable, inspectable with standard tools) | In-memory data structures + optional Tantivy index + optional Oxigraph store | **Codegraph** — universally readable format vs. opaque in-memory state |
| **Disk usage** | <10 MB for medium projects | Minimal (in-memory by default); Tantivy/Oxigraph indexes when persisted | **Tie** — both lightweight on disk |
| **Watch mode** | Built-in `watch` command for live incremental rebuilds | `--watch` flag for auto-reindex on file changes | **Tie** — both support it |
| **Background indexing** | Not available (fast enough to block) | MCP server starts before indexing completes; tools available progressively | **narsil-mcp** — useful for very large repos |

**Summary:** narsil-mcp is faster at cold indexing (pure Rust advantage) and raw search (in-memory Tantivy). Codegraph wins on what matters for iterative development: persistent incremental rebuilds that survive restarts. A tool that's 10x faster at cold indexing but re-indexes from scratch on every restart is slower in practice than one that rebuilds incrementally from a persistent store.

---

### E. Installation & Deployment

| Feature | Codegraph | narsil-mcp | Best Approach |
|---------|-----------|------------|---------------|
| **Primary install** | `npm install @optave/codegraph` | 8 methods: Homebrew, Scoop, Cargo, npm, Nix, AUR, shell script, source | **narsil-mcp** for platform coverage; **Codegraph** for simplicity |
| **Runtime dependency** | Node.js >= 20 | None (static Rust binary) | **narsil-mcp** — zero runtime dependencies |
| **npm install** | Yes (first-party) | Yes (`npm install -g narsil-mcp`) | **Tie** |
| **Platform binaries** | Auto-resolved per platform (`@optave/codegraph-{platform}-{arch}`) | Pre-built for major platforms via GitHub releases + package managers | **Tie** |
| **Binary size** | ~50 MB (with WASM grammars) | ~30-50 MB (varies by feature flags) | **Tie** |
| **Feature flags** | None — all features included | 6 compile-time flags (`native`, `graph`, `frontend`, `neural`, `neural-onnx`, `wasm`) + 6 runtime flags (`--git`, `--graph`, `--neural`, `--call-graph`, `--lsp`, `--remote`) | **Codegraph** — everything works out of the box vs. feature flag maze |
| **Configuration** | `.codegraphrc.json` + env vars + `apiKeyCommand` | `.narsil.yaml` + `~/.config/narsil-mcp/config.yaml` + env vars + CLI flags | **Tie** — similar layered config |
| **Offline capability** | Full functionality offline | Core functionality offline; neural search requires API keys (unless ONNX build) | **Codegraph** — fully offline by default |
| **Docker** | Not needed | Not needed | **Tie** |
| **Browser WASM** | WASM grammars for parsing (not a full browser build) | Full browser-compatible WASM build (~3 MB) via npm `@narsil-mcp/wasm` | **narsil-mcp** — browser deployment is unique |

**Summary:** narsil-mcp has more installation options and zero runtime dependencies (static Rust binary). Codegraph is simpler — no feature flags, no compile-time decisions, everything works on `npm install`. narsil-mcp's feature flag system means the "90 tools" headline requires specific build flags + runtime flags to achieve.

---

### F. AI Agent & MCP Integration

| Feature | Codegraph | narsil-mcp | Best Approach |
|---------|-----------|------------|---------------|
| **MCP server** | First-party, 18 tools, single-repo default | First-party, 90 tools (26-75 active by preset) | **Codegraph** for efficiency; **narsil-mcp** for breadth |
| **Token overhead** | ~3,600 tokens (18 tools) | ~4,700-12,000 tokens (26-75 tools by preset) | **Codegraph** — 1.3-3.3x less overhead |
| **Token overhead mitigation** | Not needed | Forgemax gateway collapses 90 tools → 2 tools (~1,100 tokens) | **narsil-mcp** has the problem; Forgemax is an acknowledgment, not a solution |
| **Compound commands** | `context`, `explain`, `audit` — multi-faceted answers in 1 call | Each tool returns one thing — agents must orchestrate multiple calls | **Codegraph** — fewer round-trips, less agent complexity |
| **Single-repo isolation** | Default — `--multi-repo` opt-in | Multi-repo default — `list_repos` and `discover_repos` always available | **Codegraph** — security-conscious default |
| **Multi-repo support** | Registry-based, opt-in via `--multi-repo` or `--repos` | Built-in with `list_repos`, `discover_repos`, `add_remote_repo` | **narsil-mcp** for multi-repo out of the box; **Codegraph** for security |
| **Remote repository support** | Not available | `--remote` flag enables cloning and analyzing external repos | **narsil-mcp** — unique feature |
| **Structured JSON output** | Every command supports `--json` | All MCP responses are structured JSON | **Tie** |
| **Pagination** | Built-in pagination helpers with configurable limits | Not documented | **Codegraph** |
| **Semantic search** | `search` command with optional embeddings (user's LLM provider) | `semantic_search`, `neural_search`, `hybrid_search` with Voyage AI/OpenAI/ONNX backends | **narsil-mcp** for search variety; **Codegraph** for bring-your-own-provider |
| **AST-aware chunking** | Not available | `get_chunks` — AST-boundary-aware code chunking for embedding | **narsil-mcp** — useful for RAG pipelines |
| **Programmatic embedding** | Full JS API: `import { buildGraph } from '@optave/codegraph'` | No library API | **Codegraph** — embeddable in custom tooling |

**Summary:** Codegraph is optimized for the AI agent interaction model: fewer tools, compound commands, less token overhead, security-conscious defaults. narsil-mcp offers more tools but at a significant token cost — a cost its creator acknowledged by building Forgemax. For token-constrained AI agents (which is all of them), codegraph's approach is more practical.

---

### G. Security Analysis

| Feature | Codegraph | narsil-mcp | Best Approach |
|---------|-----------|------------|---------------|
| **Taint analysis** | Not available | Source-to-sink tracking (SQL injection, XSS, command injection, path traversal) | **narsil-mcp** |
| **OWASP Top 10** | Not available | `check_owasp_top10` tool with detection rules | **narsil-mcp** |
| **CWE Top 25** | Not available | `check_cwe_top25` tool with detection rules | **narsil-mcp** |
| **Security rules engine** | Not available | 147 bundled rules with language-specific rule sets (Rust: 18, Elixir: 18, Go, Java, C#, Kotlin, Bash, IaC) | **narsil-mcp** |
| **Custom security rules** | Not available | `--ruleset` flag for loading custom rules | **narsil-mcp** |
| **Vulnerability explanation** | Not available | `explain_vulnerability` and `suggest_fix` tools | **narsil-mcp** |
| **SBOM generation** | Not available | CycloneDX, SPDX, JSON formats via `generate_sbom` | **narsil-mcp** |
| **Dependency vulnerability checking** | Not available | OSV database checking via `check_dependencies` | **narsil-mcp** |
| **License compliance** | Not available | `check_licenses` tool | **narsil-mcp** |
| **Secrets detection** | Not available | API keys, passwords, tokens in security rules | **narsil-mcp** |
| **Crypto weakness detection** | Not available | Weak algorithms, hardcoded keys detection | **narsil-mcp** |
| **Security summary** | Not available | `get_security_summary` — aggregated security posture | **narsil-mcp** |

**Summary:** narsil-mcp dominates security analysis completely. Codegraph has no security features today. This is by design — FOUNDATION.md Principle 8 says "we are not a security tool." narsil-mcp's 147-rule engine with OWASP/CWE coverage is impressive, though the depth of its taint analysis (tree-sitter-based, no type system) should be evaluated against dedicated SAST tools.

---

### H. Developer Productivity Features

| Feature | Codegraph | narsil-mcp | Best Approach |
|---------|-----------|------------|---------------|
| **Impact analysis (function-level)** | `fn-impact <name>` — transitive callers + downstream impact with scored edges | Not available | **Codegraph** |
| **Impact analysis (git-aware)** | `diff-impact --staged` / `diff-impact main` — shows what functions break from git changes | Not available | **Codegraph** |
| **CI gate** | `check --staged` — exit code 0/1 (cycles, complexity, blast radius, boundaries) | Not available (MCP-only, no CI interface) | **Codegraph** |
| **Manifesto rules engine** | `manifesto` — configurable warn/fail thresholds for code health | Not available | **Codegraph** |
| **Architecture boundaries** | `boundaries` — onion architecture preset, custom boundary rules | Not available | **Codegraph** |
| **Complexity metrics** | `complexity` — cognitive, cyclomatic, Halstead, MI, nesting depth per function | `get_complexity` — cyclomatic only (requires `--call-graph`) | **Codegraph** — 5 metrics vs. 1 |
| **Code health / structure** | `structure` — directory hierarchy with cohesion scores + per-file metrics | `get_project_structure` — file tree only | **Codegraph** — structural analysis vs. file listing |
| **Hotspot detection** | `hotspots` — files/dirs with extreme fan-in/fan-out/density | `get_function_hotspots` — most-called functions (requires `--call-graph`) | **Codegraph** — multi-dimensional hotspots vs. single-metric |
| **Co-change analysis** | `co-change` — git history analysis for files that change together | Not available | **Codegraph** |
| **Branch comparison** | `branch-compare` — structural diff between branches | Not available | **Codegraph** |
| **Triage / risk ranking** | `triage` — ranked audit queue by composite risk score | Not available | **Codegraph** |
| **Audit command** | `audit <target>` — combined explain + impact + health in one call | Not available | **Codegraph** |
| **CODEOWNERS integration** | `owners` — maps functions to code owners | Not available | **Codegraph** |
| **Cycle detection** | `cycles` — circular dependency detection | `find_circular_imports` — import-level cycle detection | **Tie** — similar capability |
| **Git integration** | `diff-impact` (git-aware impact analysis), `co-change` (history analysis) | 9 git tools: blame, history, hotspots, contributors, diffs, symbol history (requires `--git`) | **narsil-mcp** for git data exposure; **Codegraph** for git-aware analysis |
| **Execution flow tracing** | `flow` — traces from entry points through callees to leaves | Not available | **Codegraph** |
| **Module overview** | `map` — high-level module map with most-connected nodes | Not available | **Codegraph** |
| **Export formats** | DOT, Mermaid, JSON | RDF/N-Quads, JSON-LD, CCG layers | **Codegraph** for developer formats; **narsil-mcp** for semantic web formats |

**Summary:** Codegraph has 15+ purpose-built developer productivity commands that narsil-mcp lacks entirely. Impact analysis, CI gates, manifesto rules, architecture boundaries, co-change analysis, triage — these are codegraph's core value proposition. narsil-mcp exposes raw data (git blame, file history) but doesn't synthesize it into actionable intelligence.

---

### I. Ecosystem & Community

| Feature | Codegraph | narsil-mcp | Best Approach |
|---------|-----------|------------|---------------|
| **GitHub stars** | New project (growing) | ~120 | **narsil-mcp** — slightly more visible |
| **Contributors** | Small team | 3 (postrv, ask4fusora, Cognitohazard) | **Tie** — both small teams |
| **Age** | 2026 | December 2024 (~15 months) | **Tie** — both young |
| **Release cadence** | As needed | 10+ releases in 2 months (v1.1.4 → v1.6.1) | **narsil-mcp** — rapid iteration |
| **Tests** | vitest suite with integration, parser, and search tests | 1,763+ passing tests | **narsil-mcp** — impressive test count for a young project |
| **Documentation** | CLAUDE.md + CLI `--help` + programmatic API docs | README + inline comments. No dedicated docs site | **Codegraph** — more structured, though both could improve |
| **Companion projects** | None | Forgemax (MCP gateway), CCG standard/registry | **narsil-mcp** — broader ecosystem vision |
| **Language** | JavaScript (ES modules) + optional Rust native addon | Pure Rust (56K SLoC) | **narsil-mcp** — type-safe, memory-safe codebase |
| **License** | Apache-2.0 | Apache-2.0 / MIT (dual) | **narsil-mcp** — dual license is more permissive |
| **npm package** | `@optave/codegraph` | `narsil-mcp` + `@narsil-mcp/wasm` | **Tie** |
| **Commercial backing** | Optave AI Solutions Inc. | None (solo project) | **Codegraph** — company backing provides stability |

**Summary:** Both are young, small-team projects. narsil-mcp iterates rapidly (10+ releases in 2 months) with impressive test coverage. Codegraph has commercial backing (Optave). narsil-mcp's companion projects (Forgemax, CCG standard) show ambition, but the 3-contributor base is a bus-factor risk.

---

## Where Each Tool is the Better Choice

### Choose Codegraph when:

1. **You need the graph to survive restarts** — codegraph's SQLite persistence is always-on. narsil-mcp loses its index on restart unless you opt into `--persist`.
2. **You're building CI/CD pipelines** — `check --staged` returns exit code 0/1 in seconds. narsil-mcp has no CLI, no CI interface, no exit codes.
3. **Token overhead matters** — 18 tools (~3,600 tokens) vs. 26-75 tools (~4,700-12,000 tokens). In agent loops where every token counts, codegraph is 1.3-3.3x more efficient.
4. **You need impact analysis** — "what breaks if I change this?" is codegraph's core question. `fn-impact`, `diff-impact`, `audit` — none of these exist in narsil-mcp.
5. **You want scored, confidence-ranked results** — every edge has a 0.0-1.0 confidence score. narsil-mcp returns binary found/not-found.
6. **You need compound answers** — `context` returns source + deps + callers + tests in one call. narsil-mcp requires 4+ separate tool invocations.
7. **You want to embed in other tools** — codegraph has a full JS API for VS Code extensions, CI pipelines, and custom tooling. narsil-mcp is MCP-only.
8. **You need code health governance** — manifesto rules, architecture boundaries, complexity thresholds, triage queues. narsil-mcp has none of this.

### Choose narsil-mcp when:

1. **You need security scanning** — taint analysis, OWASP Top 10, CWE Top 25, SBOM generation, license compliance. Codegraph has zero security features.
2. **You work with many languages** — 32 languages vs. 11. If your codebase includes Kotlin, Swift, Scala, Haskell, Elixir, Dart, or Zig, narsil-mcp covers them.
3. **You need CFG/DFG analysis** — control flow graphs, data flow analysis, reaching definitions, dead stores. Codegraph's structural graph doesn't capture these.
4. **You want semantic search with neural embeddings** — narsil-mcp has Voyage AI, OpenAI, and local ONNX backends with BM25 hybrid search. Codegraph's semantic search is simpler.
5. **You need SPARQL/RDF integration** — for knowledge graph queries, semantic web interop, or CCG standard compliance.
6. **You want browser-based code intelligence** — narsil-mcp has a 3 MB WASM build and an embedded web frontend with interactive graph visualization.
7. **You need type inference** — basic type inference for Python, JavaScript, and TypeScript adds value for dynamic language analysis.
8. **You want maximum tool variety** — 90 tools covering search, navigation, security, git, LSP, remote repos, visualization, and more.

### Use both together when:

- **Security + productivity pipeline**: Codegraph for structural intelligence in agent loops (impact analysis, CI gates, code health), narsil-mcp for security scanning (taint analysis, OWASP/CWE checks, SBOM).
- **Multi-language monorepo**: Codegraph for core languages (JS/TS/Python/Go) with deep graph intelligence, narsil-mcp for additional languages (Kotlin, Swift, Scala) with broad coverage.
- **Agent + CI workflow**: narsil-mcp for real-time agent exploration (90 tools via MCP), codegraph for CI gates and governance (`check --staged`, `manifesto`, `boundaries`).

---

## Gap Analysis: What Codegraph Could Learn from narsil-mcp

### Worth adopting (adapted to codegraph's model)

| narsil-mcp Feature | Adaptation for Codegraph | FOUNDATION.md Alignment | Effort | Priority |
|---------------------|--------------------------|------------------------|--------|----------|
| **More languages** | Add Kotlin, Swift, Scala, Dart via tree-sitter — same registry pattern. Prioritize by user demand | Principle 6 (one registry) — perfect fit, each language is 1 entry + 1 extractor | Low per language | High — closes the gap from 11 to 15+ without changing architecture |
| **Preset/filtering system** | Allow `.codegraphrc.json` to specify which MCP tools to expose per project. Useful as tool count grows | Principle 7 (security-conscious defaults) — fine-grained control | Low | Medium — not urgent at 18 tools, but good to have before reaching 30+ |
| **BM25 full-text search** | Add Tantivy-like full-text search alongside semantic search for zero-config code search without embeddings | Principle 4 (zero-cost core) — no API keys needed | Medium | Medium — improves search without requiring LLM setup |
| **AST-aware chunking** | Export AST-boundary-aware code chunks for RAG pipelines via programmatic API | Principle 5 (embeddable API) — enhances API for downstream consumers | Medium | Medium — useful for RAG integration |
| **Background indexing** | Allow MCP server to start before indexing completes, exposing tools progressively | Principle 1 (always current) — reduces perceived build time for large repos | Medium | Low — codegraph's builds are fast enough that this rarely matters |
| **Interactive visualization** | Browser-based graph explorer (call graph, import graph, community map) via `export --format html` | Principle 5 (functional CLI) — extends output formats | High | Medium — already on roadmap |

### Not worth adopting (violates FOUNDATION.md or marginal value)

| narsil-mcp Feature | Why Not |
|---------------------|---------|
| **90 MCP tools** | Breadth-over-depth approach creates token overhead that narsil-mcp itself had to solve with Forgemax. Codegraph's compound commands are the right answer — more value per tool, not more tools |
| **RDF/SPARQL/CCG** | Solves a different problem (semantic web interop, not developer productivity). Would add complexity without serving codegraph's target users. If CCG gains adoption, implement as an export format, not a core graph model |
| **Taint analysis** | Requires CFG/DFG infrastructure we don't have. Adding it would slow builds (violating Principle 1) and expand scope (violating Principle 8). Dedicated SAST tools do this better |
| **In-memory graph model** | narsil-mcp's in-memory approach is faster for cold indexing but fundamentally incompatible with Principle 1 (always current). SQLite persistence is non-negotiable |
| **Type inference** | Tree-sitter-based type inference for dynamic languages is inherently limited. Better to invest in confidence scoring and LLM-enhanced analysis (Principle 4) than build a partial type system |
| **Forgemax gateway** | Solves a problem we don't have. 18 tools at ~3,600 tokens doesn't need a gateway. If we grow beyond 30 tools, presets are the simpler answer |
| **Feature flags (compile-time)** | Codegraph's "everything works out of the box" is a feature. Requiring users to choose build variants (graph? neural? frontend?) adds friction that violates Principle 2 (universal reach) |
| **MCP-only interface** | Limiting. Codegraph's three-interface approach (CLI + MCP + API) serves developers, agents, and CI pipelines. Removing the CLI would lose two audiences |

---

## Competitive Positioning Statement

> **narsil-mcp is the widest code intelligence MCP server** — 90 tools, 32 languages, security scanning, SPARQL, neural search, browser WASM. It's an impressive feat of engineering for a 15-month-old solo project.
>
> **But width isn't depth.** narsil-mcp's graph vanishes on restart unless you opt into persistence. Its 90 tools cost 3.3x more tokens than codegraph's 18 — a problem its creator acknowledged by building an entire separate project (Forgemax) to work around it. Its security scanning is tree-sitter-based, not compiler-grade. Its MCP-only interface means no CI integration, no standalone CLI, no embeddable library.
>
> **Codegraph occupies a fundamentally different position:** always-current structural intelligence with persistent incremental builds, confidence-scored edges, and purpose-built compound commands. Where narsil-mcp answers "here's everything about your code," codegraph answers "here's what breaks if you change this function" — and answers it with scored confidence, in under 500ms, from a graph that never needs rebuilding from scratch.
>
> For AI agents that need fast, reliable, token-efficient code intelligence in iterative development loops, codegraph is the better tool. For agents that need broad coverage across 32 languages with security scanning, narsil-mcp fills gaps codegraph intentionally doesn't. They can coexist — codegraph for the inner loop, narsil-mcp for the outer loop.

---

## Key Metrics Summary

| Metric | Codegraph | narsil-mcp | Winner |
|--------|-----------|------------|--------|
| Persistent incremental builds | Yes (SQLite, always-on) | In-memory; opt-in `--persist` | Codegraph |
| Cold indexing speed | Seconds | Sub-seconds to seconds | narsil-mcp |
| Memory usage (large repos) | 300 MB - 1 GB (SQLite offload) | 2+ GB (in-memory) | Codegraph |
| MCP token overhead | ~3,600 tokens (18 tools) | ~4,700-12,000 tokens (26-75 tools) | Codegraph |
| Language support | 11 | 32 | narsil-mcp |
| Security analysis | None | Taint + OWASP + CWE + SBOM | narsil-mcp |
| Confidence scoring | 0.0-1.0 on every edge | None | Codegraph |
| Developer productivity commands | 35+ built-in | ~5 relevant (complexity, hotspots, dead code) | Codegraph |
| CI/CD integration | `check --staged` (exit code 0/1) | None (MCP-only) | Codegraph |
| Programmatic API | Full JS API | None | Codegraph |
| Standalone CLI | 35+ commands | None | Codegraph |
| Impact analysis | fn-impact, diff-impact, audit | None | Codegraph |
| Search capabilities | SQL + semantic | BM25 + TF-IDF + neural + hybrid | narsil-mcp |
| Interactive visualization | Export only (DOT/Mermaid) | Embedded web frontend | narsil-mcp |
| Community maturity | Company-backed, small team | 3 contributors, 120 stars | Tie |

**Final score against FOUNDATION.md principles: Codegraph 7, narsil-mcp 0, Tie 1.**
narsil-mcp competes on breadth (more languages, more tools, more analysis types) rather than on the principles codegraph was built around. Its strengths — security scanning, language count, search variety — are real but orthogonal to codegraph's core value proposition of always-current, confidence-scored, developer-focused structural intelligence.
