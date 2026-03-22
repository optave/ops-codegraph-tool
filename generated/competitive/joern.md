# Competitive Deep-Dive: Codegraph vs Joern

**Date:** 2026-03-21
**Competitors:** `@optave/codegraph` v3.2.0 (Apache-2.0) vs `joernio/joern` v4.x (Apache-2.0)
**Context:** Both are Apache-2.0-licensed code analysis tools with CLI interfaces. Joern is ranked #2 in our [competitive analysis](./COMPETITIVE_ANALYSIS.md) with a score of 4.5 vs codegraph's 4.5 at #5.

---

## Executive Summary

Joern and codegraph solve fundamentally **different problems** using code graphs as a shared substrate:

| Dimension | Joern | Codegraph |
|-----------|-------|-----------|
| **Primary mission** | Vulnerability discovery & security research | Always-current structural code intelligence for developers and AI agents |
| **Target user** | Security researchers, pentesters, auditors | Developers, AI coding agents, CI pipelines |
| **Graph model** | Code Property Graph (AST + CFG + PDG + DDG) | Structural dependency graph (symbols + call/import/dataflow/CFG edges + stored AST + qualified names/scope/visibility) |
| **Core question answered** | "Can attacker-controlled data reach this dangerous sink?" | "What breaks if I change this function?" |
| **Rebuild model** | Full re-import on every change (minutes) | Incremental sub-second rebuilds (milliseconds) |
| **Runtime** | JVM (Scala) — 4-100 GB heap | Node.js — <100 MB typical |

**Bottom line:** Joern is deeper (taint analysis, control flow, data dependence). Codegraph is faster, lighter, and purpose-built for the developer/AI-agent loop. They are complementary tools, not direct substitutes. Where they overlap (structural queries, call graphs, language support), codegraph wins on speed and simplicity; Joern wins on analysis depth.

---

## Problem Alignment with FOUNDATION.md

Codegraph's foundation document defines the problem as: *"Fast local analysis with no AI, or powerful AI features that require full re-indexing through cloud APIs on every change. None of them give you an always-current graph."*

### Principle-by-principle evaluation

| # | Principle | Codegraph | Joern | Verdict |
|---|-----------|-----------|-------|---------|
| 1 | **The graph is always current** — rebuild on every commit/save/agent loop | 3-tier change detection (journal → mtime+size → hash). Change 1 file in 3,000 → <500ms rebuild. Watch mode, commit hooks, agent loops all practical | Full re-import always. Small project: 19-30s. Linux kernel: 6+ hours. No incremental mode. Unusable in tight feedback loops | **Codegraph wins decisively.** This is the single most important differentiator. Joern cannot participate in commit hooks or agent-driven loops |
| 2 | **Native speed, universal reach** — dual engine (Rust + WASM) | Native napi-rs with rayon parallelism + automatic WASM fallback. `npm install` on any platform | JVM/Scala. Requires JDK 19+. Pre-built binaries or Docker. No cross-platform auto-detection | **Codegraph wins.** Automatic platform detection with native performance + universal fallback vs. manual JVM setup |
| 3 | **Confidence over noise** — scored results | 6-level import resolution with 0.0-1.0 confidence on every edge. False-positive filtering. Graph quality score | Overapproximation by default (assumes full taint propagation for unresolved methods). Requires manual semantic definitions to reduce false positives | **Codegraph wins.** Scored results by default vs. noise-by-default requiring manual tuning |
| 4 | **Zero-cost core, LLM-enhanced when you choose** | Full pipeline local, zero API keys. Optional embeddings with user's LLM provider | Fully local, zero API keys. No LLM enhancement path | **Codegraph wins.** Both are local-first, but codegraph adds optional AI enhancement that Joern lacks entirely |
| 5 | **Functional CLI, embeddable API** | 41 CLI commands + 32-tool MCP server + full programmatic JS API | Interactive Scala REPL + server mode + script execution. No MCP. Python client library | **Codegraph wins.** Purpose-built MCP for AI agents + embeddable npm package vs. Scala REPL that requires JVM expertise |
| 6 | **One registry, one schema, no magic** | `LANGUAGE_REGISTRY` — add a language in <100 lines, 2 files | Each language has a separate frontend (Eclipse CDT, JavaParser, GraalVM, etc.) — fundamentally different parsers per language | **Codegraph wins.** Uniform tree-sitter extraction vs. heterogeneous parser zoo |
| 7 | **Security-conscious defaults** — multi-repo opt-in | Single-repo MCP default. `apiKeyCommand` for secrets. `--multi-repo` opt-in | Server mode has no sandboxing (docs explicitly warn: "raw interpreter access"). No MCP isolation concept | **Codegraph wins.** Security-by-default vs. "trust the user" |
| 8 | **Honest about what we're not** | Code intelligence engine. Not an app, not a coding tool, not an agent | Code analysis platform for security research. Not a CI tool, not a developer productivity tool | **Tie.** Both are honest about scope. Different scopes |

**Score: Codegraph 6, Joern 0, Tie 2** — against codegraph's own principles, codegraph wins overwhelmingly. This is expected: the principles were designed around codegraph's unique value proposition. The comparison below examines where Joern's strengths matter despite these principle misalignments.

---

## Feature-by-Feature Comparison

### A. Parsing & Language Support

| Feature | Codegraph | Joern | Best Approach |
|---------|-----------|-------|---------------|
| **Parser technology** | tree-sitter (WASM + native Rust) | Language-specific frontends (Eclipse CDT, JavaParser, GraalVM JS, etc.) | **Joern** for depth per language (type-aware); **Codegraph** for uniformity and extensibility |
| **JavaScript** | tree-sitter (native + WASM) | GraalVM JS parser | **Codegraph** — native Rust speed + uniform extraction |
| **TypeScript** | tree-sitter (native + WASM) | GraalVM JS parser (TS via JS) | **Codegraph** — first-class TS + TSX support |
| **Python** | tree-sitter | JavaCC-based parser | **Tie** — both handle standard Python |
| **Go** | tree-sitter | go.parser | **Tie** |
| **Rust** | tree-sitter | Not directly supported (LLVM bitcode only) | **Codegraph** — direct source parsing vs. requiring LLVM compilation |
| **Java** | tree-sitter | JavaParser + Soot (bytecode) | **Joern** — bytecode analysis + type-aware parsing |
| **C/C++** | tree-sitter | Eclipse CDT (fuzzy parsing) | **Joern** — fuzzy parsing handles macros and incomplete code better |
| **C#** | tree-sitter | Roslyn (.NET) | **Joern** — compiler-grade .NET analysis |
| **PHP** | tree-sitter | PHP-Parser | **Tie** |
| **Ruby** | tree-sitter | ANTLR | **Tie** |
| **Kotlin** | Not supported | IntelliJ PSI | **Joern** |
| **Swift** | Not supported | SwiftSyntax | **Joern** |
| **Terraform/HCL** | tree-sitter | Not supported | **Codegraph** |
| **Binary analysis (x86/x64)** | Not supported | Ghidra disassembler | **Joern** |
| **JVM bytecode** | Not supported | Soot framework | **Joern** |
| **LLVM bitcode** | Not supported | LLVM frontend | **Joern** |
| **Language count** | 11 source languages | 13 source + 3 binary/bytecode/IR | **Joern** (16 vs 11) |
| **Adding a new language** | 1 registry entry + 1 extractor (<100 lines, 2 files) | New frontend module (thousands of lines, custom parser integration) | **Codegraph** — dramatically lower barrier |
| **Incomplete/non-compilable code** | Requires syntactically valid input (tree-sitter) | Fuzzy parsing handles partial/broken code | **Joern** — critical for security audits of partial codebases |
| **Incremental parsing** | 3-tier change detection (journal → mtime+size → hash) — only changed files re-parsed | Full re-import always | **Codegraph** — orders of magnitude faster for iterative work |

**Summary:** Joern covers more languages and handles edge cases (binaries, bytecode, broken code) that codegraph cannot. Codegraph is faster, simpler to extend, and has better support for modern web languages (TSX, Terraform). For codegraph's target users (developers, AI agents), codegraph's coverage is sufficient. For security researchers auditing compiled artifacts, Joern is essential.

---

### B. Graph Model & Analysis Depth

| Feature | Codegraph | Joern | Best Approach |
|---------|-----------|-------|---------------|
| **Graph type** | Structural dependency graph (symbols + edges) | Code Property Graph (AST + CFG + PDG merged) | **Joern** for depth; **Codegraph** for speed |
| **Node types** | 13 kinds: `function`, `method`, `class`, `interface`, `type`, `struct`, `enum`, `trait`, `record`, `module`, `parameter`, `property`, `constant` + `qualified_name`, `scope`, `visibility` metadata columns | 45+ node types across 18 layers (METHOD, CALL, IDENTIFIER, LITERAL, CONTROL_STRUCTURE, BLOCK, LOCAL, etc.) | **Joern** — still more granular, but gap narrowed from 4x to ~3x |
| **Edge types** | 10 structural: `calls`, `imports`, `imports-type`, `dynamic-imports`, `reexports`, `extends`, `implements`, `contains`, `parameter_of`, `receiver` + 3 dataflow: `flows_to`, `returns`, `mutates` (with confidence scores on call/import edges) | 20+ types: AST, CFG, CDG, REACHING_DEF, CALL, ARGUMENT, RECEIVER, CONTAINS, EVAL_TYPE, REF, BINDS, DOMINATE, POST_DOMINATE, etc. | **Joern** — still more edge types, but codegraph now covers structural containment, dataflow, and receiver relationships |
| **Abstract Syntax Tree** | Stored AST nodes (calls, new, string, regex, throw, await) queryable via `ast` command/`ast_query` MCP tool | Full AST stored and queryable | **Joern** for completeness; **Codegraph** now has stored AST for the most useful node kinds |
| **Control Flow Graph** | Intraprocedural CFG for all 11 languages via `cfg` command/MCP tool. Basic blocks + branches. Cyclomatic complexity derived from CFG structure (E - N + 2). No dominator trees | Full CFG with dominator/post-dominator trees | **Joern** for depth (dominator trees); **Codegraph** now has basic CFG with complexity metrics |
| **Data Dependence Graph** | Intraprocedural dataflow: `flows_to`, `returns`, `mutates` edges via `dataflow` command/MCP tool (all 11 languages) | Reaching definitions (def-use chains) across procedures | **Joern** — interprocedural vs. codegraph's intraprocedural. But codegraph now has lightweight dataflow across all supported languages |
| **Program Dependence Graph** | Not available | Combined control + data dependence | **Joern** |
| **Taint analysis** | Not available | Full interprocedural taint tracking (sources → sinks) | **Joern** — Joern's killer feature |
| **Call graph** | Import-aware resolution with 6-level confidence scoring, qualified call filtering | Pre-computed CALL edges, caller/callee traversal | **Codegraph** for precision (confidence scoring, false-positive filtering); **Joern** for completeness (type-aware resolution) |
| **Import resolution** | 6-level priority system with confidence scoring (import-aware → same-file → directory → parent → global → method hierarchy) | Type-based resolution via language frontends | **Codegraph** for transparency (scores); **Joern** for accuracy (type information) |
| **Dead code detection** | Node role classification: `roles --role dead` lists unreferenced non-exported symbols | No built-in dead code command (queryable via CPG traversals) | **Codegraph** — built-in command vs. manual query writing |
| **Complexity metrics** | Cognitive, cyclomatic, Halstead, MI, nesting depth per function | Not built-in (would require custom CPG queries) | **Codegraph** |
| **Node role classification** | Auto-tags every symbol: `entry`/`core`/`utility`/`adapter`/`dead`/`leaf` based on fan-in/fan-out | Not available | **Codegraph** |
| **Community detection** | Louvain algorithm with drift analysis | Not built-in | **Codegraph** |
| **Impact analysis** | `fn-impact` (function-level), `diff-impact` (git-aware), `impact` (file-level) | Not purpose-built (achievable via CPG traversals) | **Codegraph** — first-class impact commands vs. manual graph traversal |
| **Shortest path** | `path <from> <to>` — BFS between any two symbols | Not purpose-built (achievable via CPG traversals) | **Codegraph** — built-in command |
| **Custom data-flow semantics** | Not applicable | User-defined taint propagation rules for external methods | **Joern** |
| **Binary analysis** | Not available | Ghidra frontend: disassembly → CPG | **Joern** |
| **Execution flow tracing** | `flow` — traces from entry points (routes, commands, events) through callees to leaves | Achievable via CFG + call graph traversals | **Codegraph** — purpose-built command; **Joern** — more precise with CFG |
| **Sequence diagrams** | `sequence <name>` — Mermaid sequence diagram generation from call graph | Not purpose-built (achievable via manual CFG/call graph traversal) | **Codegraph** — built-in command for visualizing call sequences |

**Summary:** Joern's CPG is fundamentally deeper — it captures control flow, data dependence, and taint propagation that codegraph's structural graph cannot represent. Codegraph compensates with purpose-built commands (impact analysis, complexity, roles, communities) that would require expert CPG query writing in Joern. For vulnerability discovery, Joern is irreplaceable. For developer productivity and AI agent consumption, codegraph's pre-built commands are more accessible.

---

### C. Query Language & Interface

| Feature | Codegraph | Joern | Best Approach |
|---------|-----------|-------|---------------|
| **Query interface** | Fixed CLI commands with flags + SQL under the hood | Interactive Scala REPL with tab completion + arbitrary graph traversals | **Depends on user.** Codegraph for instant answers; Joern for exploratory research |
| **Query language** | CLI flags (`--kind`, `--file`, `--role`, `--json`) | CPGQL (Scala-based DSL): `cpg.method.name("foo").callee.name.l` | **Joern** for expressiveness; **Codegraph** for accessibility |
| **Learning curve** | Zero — standard CLI with `--help` | Steep — requires Scala/FP knowledge + graph theory | **Codegraph** |
| **AI agent interface** | 32-tool MCP server with structured JSON responses | Community MCP server (mcp-joern). REST/WebSocket server mode | **Codegraph** — first-party MCP vs. community add-on |
| **Compound queries** | `context` (source + deps + callers + tests in 1 call), `explain` (structural summary), `audit` (explain + impact + health in one call) | Must compose via CPGQL chaining | **Codegraph** — purpose-built for agent token efficiency |
| **Batch queries** | `batch` command for multi-target dispatch | Script mode (`--script`) for batch execution | **Tie** — different approaches, both work |
| **JSON output** | `--json` flag on every command | `.toJsonPretty` method on query results | **Tie** |
| **Syntax-highlighted output** | Colored terminal output | `.dump` for syntax-highlighted code display | **Tie** |
| **Visualization** | DOT, Mermaid, JSON, GraphML, GraphSON, Neo4j CSV export + interactive HTML viewer (`codegraph plot`) | DOT, GraphML, GraphSON, Neo4j CSV export + interactive `.plotDotCfg` | **Tie** — both have interactive plotting and comparable export formats |
| **Script execution** | Not available (but full programmatic JS API) | `--script test.sc` with params and imports | **Joern** for scripting; **Codegraph** for API embedding |
| **Plugin system** | Not available | JVM plugins (ZIP/JAR), DiffGraph API, schema extension | **Joern** |
| **Regex in queries** | Glob-style filtering on names | Full regex in all query steps + semantic definitions | **Joern** |

**Summary:** Joern's CPGQL is vastly more expressive — you can write arbitrary graph traversals that codegraph simply cannot express. But this power comes with a steep learning curve (Scala + graph theory). Codegraph's fixed commands with flags are instantly usable by any developer or AI agent. For the target users defined in FOUNDATION.md (developers and AI agents, not security researchers), codegraph's approach is better.

---

### D. Performance & Resource Usage

| Feature | Codegraph | Joern | Best Approach |
|---------|-----------|-------|---------------|
| **Cold build (small project, ~100 files)** | <2 seconds | 19-30 seconds | **Codegraph** (10-15x faster) |
| **Cold build (medium project, ~1,000 files)** | 5-15 seconds | 1-5 minutes | **Codegraph** (10-20x faster) |
| **Cold build (large project, ~50,000 files)** | 30-120 seconds (native Rust) | 30 minutes to hours | **Codegraph** (10-60x faster) |
| **Cold build (Linux kernel, ~30M LOC)** | Not benchmarked (estimated: minutes) | 6+ hours, 30-100 GB heap | **Codegraph** (estimated orders of magnitude faster) |
| **Incremental rebuild (1 file changed)** | <500ms | Full re-import (same as cold build) | **Codegraph** (100-10,000x faster) |
| **Memory usage (small project)** | <100 MB | 4-8 GB heap recommended | **Codegraph** (40-80x less memory) |
| **Memory usage (medium project)** | 100-300 MB | 8-16 GB heap | **Codegraph** (30-50x less memory) |
| **Memory usage (large project)** | 300 MB - 1 GB | 30-100 GB heap | **Codegraph** (30-100x less memory) |
| **Startup time** | <100ms (Node.js) | 5-15 seconds (JVM cold start) | **Codegraph** (50-150x faster) |
| **Storage format** | SQLite file (compact, portable) | Flatgraph binary (columnar, in-memory) | **Codegraph** — SQLite is universally readable; flatgraph is opaque |
| **Disk usage** | Typically <10 MB for medium projects | Linux kernel: 625 MB (flatgraph) | **Codegraph** (60x+ smaller) |
| **Overflow to disk** | SQLite handles this natively | Flatgraph has no overflow — entire graph must fit in memory | **Codegraph** — can handle repos larger than available RAM |
| **Parallel parsing** | Native Rust engine uses rayon for parallel tree-sitter | Language frontends may parallelize internally | **Codegraph** — explicit parallel architecture |
| **Watch mode** | Built-in `watch` command for live incremental rebuilds | Not available | **Codegraph** |
| **Commit hook viability** | Yes — <500ms rebuilds are invisible to developers | No — 19+ second minimum makes hooks impractical | **Codegraph** |
| **CI pipeline viability** | Yes — full build in seconds, `check` command returns exit code 0/1 | Possible but slow — Joern itself is "not yet well-suited as a CI/CD SAST tool" (per comparative analysis) | **Codegraph** |

**Summary:** Codegraph is 10-10,000x faster than Joern depending on scenario. Joern's JVM overhead, full re-import model, and in-memory graph requirement make it unsuitable for tight feedback loops. This is codegraph's single most important competitive advantage (FOUNDATION.md Principle 1).

---

### E. Installation & Deployment

| Feature | Codegraph | Joern | Best Approach |
|---------|-----------|-------|---------------|
| **Install method** | `npm install @optave/codegraph` | Shell script (`joern-install.sh`) or Docker or build from source (sbt) | **Codegraph** — one command vs. multi-step |
| **Runtime dependency** | Node.js >= 20 | JDK 19+ (JDK 21 recommended) | **Codegraph** — Node.js is more ubiquitous in developer environments |
| **External database** | None (SQLite embedded) | None (flatgraph embedded) | **Tie** |
| **Docker required** | No | No (but Docker images available) | **Tie** |
| **Platform binaries** | Auto-resolved per platform (`@optave/codegraph-{platform}-{arch}`) | Pre-built binaries for major platforms | **Codegraph** — npm handles platform resolution automatically |
| **Disk footprint (tool itself)** | ~50 MB (with WASM grammars) | ~500 MB+ (JVM + all frontends) | **Codegraph** (10x smaller) |
| **Offline capability** | Full functionality offline | Full functionality offline | **Tie** |
| **Configuration** | `.codegraphrc.json` + env vars + `apiKeyCommand` | JVM flags (`-Xmx`), workspace settings | **Codegraph** — simpler, declarative |
| **Uninstall** | `npm uninstall` | Manual removal of install directory | **Codegraph** |

**Summary:** Codegraph is dramatically simpler to install and manage. `npm install` vs. downloading a shell script and ensuring JDK compatibility. For the FOUNDATION.md goal of "`npm install` and done" (Principle 2, 5), codegraph is the clear winner.

---

### F. AI Agent & MCP Integration

| Feature | Codegraph | Joern | Best Approach |
|---------|-----------|-------|---------------|
| **MCP server** | First-party, 32 tools, single-repo default, `--multi-repo` opt-in | 4 community MCP wrappers (sfncat/mcp-joern, caohaotiantian/joern_mcp, BlockSecCA/joern-mcp, effortlessdevsec/joern-mcp-server). No first-party MCP | **Codegraph** — first-party, security-conscious, production-ready |
| **MCP tools count** | 32 purpose-built tools | ~10 tools (community MCP) | **Codegraph** |
| **Token efficiency** | `context`/`explain`/`audit` compound commands reduce agent round-trips by 50-80% | Raw query results, no compound optimization | **Codegraph** |
| **Structured JSON output** | Every command supports `--json` | `.toJsonPretty` on query results | **Tie** |
| **Pagination** | Built-in pagination helpers with configurable limits | Not built-in | **Codegraph** |
| **REST API** | Not available (MCP + programmatic API) | Server mode with REST + WebSocket | **Joern** for HTTP integration; **Codegraph** for MCP |
| **Python client** | Not available | `cpgqls-client-python` | **Joern** for Python ecosystems |
| **Programmatic embedding** | Full JS API: `import { buildGraph, queryNameData } from '@optave/codegraph'` | JVM-only: Scala/Java library | **Codegraph** for JS/TS ecosystems; **Joern** for JVM ecosystems |
| **Multi-repo support** | Registry-based, opt-in via `--multi-repo` or `--repos` | Workspace with multiple projects | **Tie** — different approaches |

**Summary:** Codegraph is purpose-built for AI agent consumption (FOUNDATION.md Principle 5). Joern's community MCP exists but is a wrapper, not a first-class integration. For the AI-agent-driven development workflow that codegraph targets, codegraph is the clear choice.

---

### G. Security Analysis

| Feature | Codegraph | Joern | Best Approach |
|---------|-----------|-------|---------------|
| **Taint analysis** | Not available | Full interprocedural source-to-sink tracking | **Joern** — this is Joern's raison d'etre |
| **Vulnerability scanning** | Not available | `joern-scan` with predefined query bundles, tag-based selection | **Joern** |
| **Data-flow tracking** | Intraprocedural dataflow (`flows_to`/`returns`/`mutates`), all 11 languages | Reaching definitions, def-use chains across procedures | **Joern** — interprocedural vs. intraprocedural |
| **Control-flow analysis** | Intraprocedural CFG (basic blocks + branches, all 11 languages) | Full CFG with dominator trees | **Joern** — dominator trees and post-dominators; codegraph has basic CFG |
| **Custom security rules** | Not available | CPGQL-based custom queries + data-flow semantics | **Joern** |
| **Binary vulnerability analysis** | Not available | Ghidra integration for x86/x64 | **Joern** |
| **OWASP/CWE detection** | Not available (roadmap) | Achievable via custom CPGQL queries | **Joern** |
| **Secret scanning** | Not available | Not built-in | **Tie** — neither has it built-in |
| **CPG slicing** | Not available | `joern-slice` with data-flow and usages modes | **Joern** |

**Summary:** Joern dominates security analysis completely. Codegraph has no security features today. This is by design — FOUNDATION.md Principle 8 says "we are not a security tool." OWASP pattern detection is on the roadmap as lightweight AST-based checks, not full taint analysis.

---

### H. Developer Productivity Features

| Feature | Codegraph | Joern | Best Approach |
|---------|-----------|-------|---------------|
| **Impact analysis (function-level)** | `fn-impact <name>` — transitive callers + downstream impact | Achievable via CPGQL (not purpose-built) | **Codegraph** |
| **Impact analysis (git-aware)** | `diff-impact --staged` / `diff-impact main` — shows what functions break from git changes | Not available | **Codegraph** |
| **CI gate** | `check --staged` — exit code 0/1 for CI pipelines (cycles, complexity, blast radius, boundaries) | Not purpose-built for CI | **Codegraph** |
| **Complexity metrics** | `complexity` — cognitive, cyclomatic, Halstead, MI per function | Not built-in | **Codegraph** |
| **Code health manifesto** | `manifesto` — configurable rule engine with warn/fail thresholds | Not available | **Codegraph** |
| **Structure analysis** | `structure` — directory hierarchy with cohesion scores + per-file metrics | Not available | **Codegraph** |
| **Hotspot detection** | `hotspots` — files/dirs with extreme fan-in/fan-out/density | Not available | **Codegraph** |
| **Co-change analysis** | `co-change` — git history analysis for files that change together | Not available | **Codegraph** |
| **Branch comparison** | `branch-compare` — structural diff between branches | Not available | **Codegraph** |
| **Triage/risk ranking** | `triage` — ranked audit queue by composite risk score | Not available | **Codegraph** |
| **CODEOWNERS integration** | `owners` — maps functions to code owners | Not available | **Codegraph** |
| **Semantic search** | `search` — natural language function search with optional embeddings | Not available | **Codegraph** |
| **Watch mode** | `watch` — live incremental rebuilds on file changes | Not available | **Codegraph** |
| **Snapshot management** | `snapshot save/restore` — DB backup and restore | Workspace save/undo | **Tie** |
| **Execution flow tracing** | `flow` — traces from entry points through callees | Achievable via CFG traversals (more precise) | **Codegraph** for convenience; **Joern** for precision |
| **Module overview** | `map` — high-level module map with most-connected nodes | Not purpose-built | **Codegraph** |
| **Cycle detection** | `cycles` — circular dependency detection | Achievable via CPGQL | **Codegraph** — built-in command |
| **Sequence diagrams** | `sequence <name>` — Mermaid sequence diagrams from call graph | Not purpose-built | **Codegraph** |
| **Dead export detection** | `exports --unused` — identifies unused exports across the codebase | Not purpose-built (achievable via CPGQL) | **Codegraph** — built-in flag |
| **Export formats** | DOT, Mermaid, Mermaid sequence diagrams, JSON, GraphML, GraphSON, Neo4j CSV + interactive HTML viewer | DOT, GraphML, GraphSON, Neo4j CSV | **Codegraph** — now matches Joern's formats plus Mermaid (flowchart + sequence) and interactive viewer |

**Summary:** Codegraph has 17+ purpose-built developer productivity commands that Joern either lacks entirely or requires expert CPGQL queries to achieve. This is where codegraph's value proposition is strongest for its target audience.

---

### I. Ecosystem & Community

| Feature | Codegraph | Joern | Best Approach |
|---------|-----------|-------|---------------|
| **GitHub stars** | 32 (growing) | ~3,021 | **Joern** |
| **Contributors** | Small team | 75 | **Joern** |
| **Release cadence** | As needed | **Daily automated releases** | **Joern** — impressive automation |
| **Academic backing** | None | IEEE S&P 2014 paper (Test-of-Time Award 2024), TU Braunschweig, Stellenbosch University | **Joern** |
| **Commercial backing** | Optave AI Solutions Inc. | Qwiet AI (formerly ShiftLeft), Privado, Whirly Labs | **Joern** — multiple sponsors |
| **Documentation** | CLAUDE.md + CLI `--help` + programmatic API docs | docs.joern.io + cpg.joern.io + blog + query database | **Joern** — comprehensive docs site |
| **Community channels** | GitHub Issues | Discord + GitHub Issues + Twitter | **Joern** — more channels |
| **Plugin ecosystem** | Not available | JVM plugin system with sample plugin | **Joern** |
| **Client libraries** | JS/TS (first-party) | Python client (first-party), any language via REST | **Tie** — different language ecosystems |
| **License** | Apache-2.0 | Apache-2.0 | **Tie** |

**Summary:** Joern has a massive head start — 7 years of development, academic foundation, commercial backing, and a mature community. Codegraph is a new entrant competing on a different value proposition.

---

## Where Each Tool is the Better Choice

### Choose Codegraph when:

1. **You need the graph to stay current in tight feedback loops** — commit hooks, watch mode, AI agent loops. Joern's 19+ second minimum rebuild makes this impossible.
2. **You're building AI-agent-driven workflows** — MCP server, compound commands, structured JSON, token-efficient responses. Codegraph is purpose-built for this.
3. **You want zero-configuration setup** — `npm install` vs. JDK + shell script + heap tuning.
4. **Memory is constrained** — <100 MB vs. 4-100 GB. Codegraph runs on any developer machine; Joern may require dedicated infrastructure for large repos.
5. **You need developer productivity features** — impact analysis, complexity metrics, code health rules, co-change analysis, hotspots, structure analysis. These don't exist in Joern.
6. **You're working with modern web stacks** — TSX, Terraform, and tree-sitter's broad but uniform coverage. Joern's web language support is secondary to its C/C++/Java strength.
7. **You want scored, confidence-ranked results** — every edge has a confidence score. Joern overapproximates by default.
8. **You're integrating into CI/CD** — `check --staged` returns exit code 0/1 in seconds. Joern is "not yet well-suited" for CI/CD.

### Choose Joern when:

1. **You're doing security research or vulnerability discovery** — taint analysis, CPG traversals, binary analysis. Codegraph has zero security analysis features.
2. **You need control-flow or data-dependence analysis** — CFG, PDG, DDG, dominator trees. Codegraph's structural graph doesn't capture these.
3. **You're analyzing compiled artifacts** — JVM bytecode, LLVM bitcode, x86/x64 binaries. Codegraph is source-only.
4. **You need exploratory graph queries** — CPGQL lets you write arbitrary traversals. Codegraph's fixed commands can't express ad-hoc queries.
5. **You're auditing C/C++ code** — Eclipse CDT's fuzzy parsing handles macros, `#ifdef`, and incomplete code that tree-sitter cannot.
6. **You need to analyze non-compilable code** — partial codebases, broken builds, code fragments. Joern's fuzzy parsing handles these; tree-sitter requires syntactically valid input.
7. **You want academic-grade analysis** — Joern is backed by published research with IEEE recognition. Its CPG model is formally specified.
8. **You're in a JVM ecosystem** — Scala/Java/Kotlin interop, Soot bytecode analysis, plugin system.

### Use both together when:

- **CI pipeline**: Codegraph for fast structural checks on every commit (`check --staged`), Joern for periodic deep security scans (weekly/release-gated).
- **AI agent workflow**: Codegraph's MCP provides structural context in agent loops; Joern's server mode provides deep analysis for security-focused queries.
- **Pre-commit + pre-release**: Codegraph in commit hooks (fast), Joern in release gates (thorough).

---

## Gap Analysis: What Codegraph Could Learn from Joern

### Worth adopting (adapted to codegraph's model)

| Joern Feature | Adaptation for Codegraph | Effort | Priority |
|---------------|--------------------------|--------|----------|
| **CPG slicing** | Lightweight call-chain slicing — extract a subgraph around a function (callers + callees to depth N) as standalone JSON. Not full PDG slicing, but useful for AI context windows | Medium | High — directly serves AI agent use case |
| **More export formats** | ~~Add GraphML and Neo4j CSV to `export` command~~ | ~~Low~~ | **DONE in v3.0.0** — GraphML, GraphSON, Neo4j CSV added |
| **Interactive plotting** | ~~`plotDotCfg`-style browser-based visualization~~ | ~~Medium~~ | **DONE in v3.0.0** — `codegraph plot` opens interactive HTML viewer |
| **Script/batch automation** | Already have `batch` command. Could add a simple query script format for CI pipelines | Low | Low |
| **Custom query language** | Not worth building a DSL. Instead, expand `--filter` expressions on existing commands (e.g. `where --filter "fanIn > 5 AND kind = function"`) | Medium | Medium |

### Not worth adopting (violates FOUNDATION.md)

| Joern Feature | Why Not |
|---------------|---------|
| **Full CPG (AST + CFG + PDG)** | Would require fundamentally different parsing — we'd be rebuilding Joern. Violates Principle 1 (rebuild speed) and Principle 6 (one registry). Tree-sitter + lightweight dataflow is the pragmatic path |
| **Taint analysis** | Requires control-flow and data-dependence graphs we don't have. Adding these would 10-100x our build time, violating Principle 1 |
| **Scala DSL** | Our users are developers and AI agents, not security researchers. Fixed commands with flags serve them better (Principle 5) |
| **JVM binary analysis** | Violates Principle 8 (honest about what we're not) — we're a source code tool |
| **Plugin system** | Premature complexity. Programmatic API + MCP tools are sufficient interfaces today |
| **Workspace with multiple loaded CPGs** | Our registry + `--multi-repo` achieves this without loading multiple graphs into memory simultaneously |

---

## Competitive Positioning Statement

> **Joern is the gold standard for security-focused code analysis** — if you need taint tracking, control-flow analysis, or binary vulnerability discovery, nothing else comes close. But its JVM overhead (4-100 GB heap), full re-import model (minutes to hours), and Scala learning curve make it impractical for the fast-feedback, AI-agent-driven development workflows that modern teams need.
>
> **Codegraph occupies a different niche entirely:** always-current structural intelligence that rebuilds in milliseconds, runs with zero configuration, and serves AI agents via purpose-built MCP tools. Where Joern answers "can attacker data reach this sink?", codegraph answers "what breaks if I change this function?" — and answers it 1,000x faster.
>
> They are not substitutes. They are complements. The team that uses codegraph in their commit hooks and Joern in their release gates gets the best of both worlds.

---

## Key Metrics Summary

| Metric | Codegraph | Joern | Winner |
|--------|-----------|-------|--------|
| Incremental rebuild speed | <500ms | N/A (full re-import) | Codegraph |
| Cold build speed | Seconds | Minutes to hours | Codegraph |
| Memory usage | <100 MB typical | 4-100 GB | Codegraph |
| Install complexity | `npm install` | JDK + shell script | Codegraph |
| Analysis depth (structural) | High | Very High | Joern |
| Analysis depth (security) | None | Best in class | Joern |
| AI agent integration | 32-tool MCP (first-party) | Community MCP wrappers (4) | Codegraph |
| Developer productivity commands | 41 built-in | ~5 built-in + custom CPGQL | Codegraph |
| Language support | 11 | 16 (incl. binary/bytecode) | Joern |
| Query expressiveness | Fixed commands | Arbitrary graph traversals | Joern |
| Community & maturity | 32 stars, growing | 7 years, IEEE award, 3,021 stars, 75 contributors | Joern |
| CI/CD readiness | Yes (`check --staged`) | Limited | Codegraph |

**Final score against FOUNDATION.md principles: Codegraph 6, Joern 0, Tie 2.**
Joern doesn't compete on codegraph's principles — it competes on analysis depth and security research, which are outside codegraph's stated scope.

---

## Joern-Inspired Feature Candidates

Features extracted from sections **A. Parsing & Language Support**, **B. Graph Model & Analysis Depth**, and **C. Query Language & Interface** above, assessed using the [BACKLOG.md](../../docs/roadmap/BACKLOG.md) tier and grading system. See the [Scoring Guide](../../docs/roadmap/BACKLOG.md#scoring-guide) for column definitions.

### Tier 1 — Zero-dep + Foundation-aligned (build these first)

Non-breaking, ordered by problem-fit:

| ID | Title | Description | Category | Benefit | Zero-dep | Foundation-aligned | Problem-fit (1-5) | Breaking |
|----|-------|-------------|----------|---------|----------|-------------------|-------------------|----------|
| J1 | Lightweight call-chain slicing | Extract a bounded subgraph around a function (callers + callees to depth N) as standalone JSON/DOT/Mermaid. Not full PDG slicing — structural BFS on existing edges, exported as a self-contained artifact. Inspired by Joern's `joern-slice`. | Navigation | Agents get precisely-scoped subgraphs that fit context windows instead of full graph dumps — directly reduces token waste | ✓ | ✓ | 4 | No |
| J2 | Type-informed call resolution | **PARTIALLY DONE (v3.2.0):** `qualified_name`, `scope`, `visibility` metadata columns and receiver type tracking with graded confidence (Phase 4.2). Remaining: full type annotation extraction from tree-sitter AST (TypeScript types, Java types, Go types, Python type hints) to disambiguate call targets during import resolution. Inspired by Joern's type-aware language frontends. | Analysis | Call graphs become more precise — fewer false edges means less noise in `fn-impact` and agents don't chase phantom dependencies | ✓ | ✓ | 4 | No |
| J3 | Error-tolerant partial parsing | Leverage tree-sitter's built-in error recovery to extract symbols from syntactically incomplete or broken files instead of skipping them entirely. Surface partial results with a quality indicator per file. Currently codegraph requires syntactically valid input; Joern's fuzzy parsing handles partial/broken code. | Parsing | Agents can analyze WIP branches, partial checkouts, and code mid-refactor — essential for real-world AI-agent loops where code is often in a broken state | ✓ | ✓ | 3 | No |
| J4 | Kotlin language support | Add tree-sitter-kotlin to `LANGUAGE_REGISTRY`. 1 registry entry + 1 extractor function (<100 lines, 2 files). Covers functions, classes, interfaces, objects, data classes, companion objects, call sites. Kotlin is one of Joern's strongest languages (via IntelliJ PSI). | Parsing | Extends coverage to Android/KMP ecosystem — one of the most-requested missing languages and a gap vs. Joern | ✓ | ✓ | 2 | No |
| J5 | Swift language support | Add tree-sitter-swift to `LANGUAGE_REGISTRY`. 1 registry entry + 1 extractor function (<100 lines, 2 files). Covers functions, classes, structs, protocols, enums, extensions, call sites. Joern supports Swift via SwiftSyntax. | Parsing | Extends coverage to Apple/iOS ecosystem — currently a gap vs. Joern. tree-sitter-swift is mature enough for production use | ✓ | ✓ | 2 | No |
| J10 | Regex filtering in queries | Upgrade name filtering from glob-style to full regex on `where`, `list-functions`, `roles`, and other symbol-listing commands. Add `--regex` flag alongside existing glob behavior. Joern supports full regex in all CPGQL query steps. | Query | Agents and power users can express precise symbol patterns (e.g. `--regex "^(get\|set)[A-Z]"`) — reduces result noise and round-trips for targeted queries | ✓ | ✓ | 3 | No |
| J11 | Query script execution | Simple `.codegraph` script format: a sequence of CLI commands executed in order, with variable substitution and JSON piping between steps. Not a DSL — just a thin automation layer over existing commands. Inspired by Joern's `--script test.sc` with params and imports. | Automation | CI pipelines and agent orchestrators can run multi-step analysis sequences in one invocation instead of chaining shell commands — reduces boilerplate and ensures consistent execution | ✓ | ✓ | 2 | No |

Breaking — **all completed in v3.0.0:**

| ID | Title | Status | Description |
|----|-------|--------|-------------|
| J6 | Expanded node types | **DONE v3.0.0** | Added `parameter`, `property`, `constant` to `SYMBOL_KINDS` (10 → 13). Queryable via `children` command / `symbol_children` MCP tool. |
| J7 | Expanded edge types | **DONE v3.0.0** | Added `contains`, `parameter_of`, `receiver`, `flows_to`, `returns`, `mutates` edges (2 → 8 edge types). |
| J8 | Intraprocedural control flow graph | **DONE v3.0.0** | CFG for all 11 languages via `cfg` command / `cfg` MCP tool. Basic blocks + branches from tree-sitter AST. |
| J9 | Stored queryable AST | **DONE v3.0.0** | AST nodes (calls, new, string, regex, throw, await) stored in `ast_nodes` table. Queryable via `ast` command / `ast_query` MCP tool. |

### Not adopted (violates FOUNDATION.md)

These Joern features were evaluated and deliberately excluded:

| Joern Feature | Section | Why Not |
|---------------|---------|---------|
| **Full CPG (AST + CFG + PDG merged)** | B | Would require fundamentally different parsing — we'd be rebuilding Joern. Violates P1 (rebuild speed) and P6 (one registry). Tree-sitter + lightweight dataflow is the pragmatic path |
| **Interprocedural taint analysis** | B | Requires control-flow and data-dependence graphs we don't have. Adding these would 10-100x build time, violating P1. Joern's killer feature, but outside our scope |
| **Program Dependence Graph (PDG)** | B | Combined control + data dependence requires full CFG + DDG. The lightweight CFG in J8 is a deliberate subset — full PDG is Joern territory |
| **Custom data-flow semantics** | B | User-defined taint propagation rules require the taint infrastructure we've chosen not to build. Joern's `Semantics` DSL is powerful but orthogonal to our goals |
| **JVM bytecode analysis** | A | Violates P8 (honest about what we're not) — we're a source code tool. Requires Soot or equivalent JVM dependency |
| **LLVM bitcode analysis** | A | Violates P8 — requires LLVM toolchain. We analyze source, not compiler intermediate representations |
| **Binary analysis (x86/x64)** | A | Violates P8 — requires Ghidra or equivalent disassembler. Fundamentally different problem domain |
| **Language-specific compiler frontends** | A | Violates P6 (one registry, one schema, no magic). Joern uses Eclipse CDT for C/C++, JavaParser for Java, Roslyn for C#, IntelliJ PSI for Kotlin — each is a separate, heavyweight parser. Tree-sitter uniformity is a deliberate advantage worth preserving |
| **Plugin system (JVM plugins, DiffGraph API)** | C | Premature complexity. Programmatic JS API + MCP tools are sufficient extension interfaces today. JVM-style plugin architecture (ZIP/JAR, schema extension) adds maintenance burden without clear user demand. Revisit if extension points become a bottleneck |

### Cross-references to existing BACKLOG items

These Joern-inspired capabilities are already tracked in [BACKLOG.md](../../docs/roadmap/BACKLOG.md):

| BACKLOG ID | Title | Joern Equivalent | Relationship |
|------------|-------|------------------|--------------|
| 14 | Dataflow analysis | Data Dependence Graph (def-use chains) | **DONE v3.0.0, expanded v3.2.0.** Lightweight intraprocedural dataflow with `flows_to`/`returns`/`mutates` edges. Now all 11 languages (was JS/TS only). CLI: `codegraph dataflow`. MCP: `dataflow` tool. |
| 7 | OWASP/CWE pattern detection | Vulnerability scanning (`joern-scan`) | Lightweight AST-based security checks — the codegraph-appropriate alternative to Joern's taint-based vulnerability scanning. Still Tier 3. J9 (stored AST) is now complete — this is unblocked. |
