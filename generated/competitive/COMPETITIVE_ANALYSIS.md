# Competitive Analysis — Code Graph / Code Intelligence Tools

**Date:** 2026-03-21 (updated from 2026-02-25)
**Scope:** 140+ code analysis tools evaluated, 85+ ranked against `@optave/codegraph`

---

## Overall Ranking

Ranked by weighted score across 6 dimensions (each 1–5):

### Tier 1: Direct Competitors (score ≥ 3.0)

| # | Score | Project | Stars | Lang | License | Summary |
|---|-------|---------|-------|------|---------|---------|
| 1 | 4.7 | [abhigyanpatwari/GitNexus](https://github.com/abhigyanpatwari/GitNexus) | 18,453 | TS/JS | PolyForm NC | Zero-server knowledge graph engine with Graph RAG Agent, CLI + MCP + Web UI, tree-sitter native + WASM, LadybugDB (custom graph DB), multi-editor support (Claude Code hooks, Cursor, Codex, Windsurf, OpenCode), auto-generated AGENTS.md/CLAUDE.md. **Non-commercial license. Viral growth (18k stars in ~8 months)** |
| 2 | 4.5 | [joernio/joern](https://github.com/joernio/joern) | 3,021 | Scala | Apache-2.0 | Full CPG analysis platform for vulnerability discovery, Scala query DSL, multi-language, daily releases (v4.0.508), 75 contributors |
| 3 | 4.5 | [postrv/narsil-mcp](https://github.com/postrv/narsil-mcp) | 129 | Rust | Apache-2.0 | 90 MCP tools, 32 languages, taint analysis, SBOM, dead code, neural semantic search, single ~30MB binary, SPA web frontend (v1.6.1) |
| 4 | 4.5 | [vitali87/code-graph-rag](https://github.com/vitali87/code-graph-rag) | 2,168 | Python | MIT | Graph RAG with Memgraph, multi-provider AI, code editing, semantic search, MCP server (added 2026) |
| **5** | **4.5** | **[@optave/codegraph](https://github.com/optave/codegraph)** | **32** | **JS/Rust** | **Apache-2.0** | **Sub-second incremental rebuilds (3-tier change detection), dual engine (native Rust + WASM), 11 languages, 32-tool MCP, 41 CLI commands, qualified call resolution with receiver type tracking, `context`/`audit`/`where` AI-optimized commands, dataflow + CFG + stored AST across all languages, sequence diagrams, structure/hotspot analysis, node role classification, dead code/export detection, architecture boundary enforcement, unified graph model with qualified names/scope/visibility, zero-cost core + optional LLM enhancement** |
| 6 | 4.3 | [DeusData/codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) | 793 | C | MIT | Single static C binary, 64 languages (tree-sitter), 14 MCP tools, Cypher-like query language, persistent SQLite knowledge graph, 10-agent auto-installer, 3D graph visualization, HTTP route analysis. **25 days old — fastest-growing new entrant** |
| 7 | 4.2 | [Fraunhofer-AISEC/cpg](https://github.com/Fraunhofer-AISEC/cpg) | 424 | Kotlin | Apache-2.0 | CPG library for 8+ languages with MCP module, Neo4j visualization, formal specs, LLVM IR support |
| 8 | 4.0 | [SimplyLiz/CodeMCP (CKB)](https://github.com/SimplyLiz/CodeMCP) | 77 | Go | Custom | SCIP-based indexing, compound operations (83% token savings), CODEOWNERS, secret scanning, impact analysis, architecture mapping (v8.1.0) |
| 9 | 4.0 | [harshkedia177/axon](https://github.com/harshkedia177/axon) | 577 | Python | MIT | 11-phase pipeline, KuzuDB, Leiden community detection, dead code, change coupling, MCP + CLI, hit v1.0 milestone |
| 10 | 3.8 | [seatedro/glimpse](https://github.com/seatedro/glimpse) | 349 | Rust | MIT | Clipboard-first codebase-to-LLM tool with call graphs, token counting, LSP resolution. **Stagnant since Jan 2026** |
| 11 | 3.8 | [ShiftLeftSecurity/codepropertygraph](https://github.com/ShiftLeftSecurity/codepropertygraph) | 564 | Scala | Apache-2.0 | CPG specification + Tinkergraph library, Scala query DSL, protobuf serialization (Joern foundation) |
| 12 | 3.8 | [Jakedismo/codegraph-rust](https://github.com/Jakedismo/codegraph-rust) | 142 | Rust | None | 100% Rust GraphRAG, SurrealDB, LSP-powered dataflow analysis, architecture boundary enforcement |
| 13 | 3.7 | [Anandb71/arbor](https://github.com/Anandb71/arbor) | 85 | Rust | MIT | Native GUI, confidence scoring, architectural role classification, fuzzy search, MCP |
| 14 | 3.7 | [JudiniLabs/mcp-code-graph](https://github.com/JudiniLabs/mcp-code-graph) | 380 | JavaScript | MIT | Cloud-hosted MCP server by CodeGPT, semantic search, dependency links (requires account) |
| 15 | 3.7 | [entrepeneur4lyf/code-graph-mcp](https://github.com/entrepeneur4lyf/code-graph-mcp) | 83 | Python | MIT | ast-grep for 25+ languages, complexity metrics, code smells, circular dependency detection. **Stagnant since Jul 2025** |
| 16 | 3.7 | [cs-au-dk/jelly](https://github.com/cs-au-dk/jelly) | 423 | TypeScript | BSD-3 | Academic-grade JS/TS points-to analysis, call graphs, vulnerability exposure, 5 published papers |
| 17 | 3.6 | [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) | 308 | TypeScript | MIT | tree-sitter + SQLite + MCP, Claude Code token reduction benchmarks, npx installer. **Nearly doubled since Feb — naming competitor** |
| 18 | 3.5 | [er77/code-graph-rag-mcp](https://github.com/er77/code-graph-rag-mcp) | 89 | TypeScript | MIT | 26 MCP methods, 11 languages, tree-sitter, semantic search, hotspot analysis, clone detection |
| 19 | 3.5 | [MikeRecognex/mcp-codebase-index](https://github.com/MikeRecognex/mcp-codebase-index) | 25 | Python | AGPL-3.0 | 18 MCP tools, zero runtime deps, auto-incremental reindexing via git diff |
| 20 | 3.5 | [nahisaho/CodeGraphMCPServer](https://github.com/nahisaho/CodeGraphMCPServer) | 7 | Python | MIT | GraphRAG with Louvain community detection, 16 languages, 14 MCP tools, 334 tests |
| 21 | 3.5 | [dundalek/stratify](https://github.com/dundalek/stratify) | 102 | Clojure | MIT | Multi-backend extraction (LSP/SCIP/Joern), 10 languages, DGML/CodeCharta output, architecture linting |
| 22 | 3.5 | [kraklabs/cie](https://github.com/kraklabs/cie) | 9 | Go | AGPL-3.0 | Code Intelligence Engine: 20+ MCP tools, tree-sitter, semantic search (Ollama), Homebrew, single Go binary |
| 23 | 3.4 | [anrgct/autodev-codebase](https://github.com/anrgct/autodev-codebase) | 111 | TypeScript | None | 40+ languages, 7 embedding providers, Cytoscape.js visualization, LLM reranking. **Stagnant since Jan 2026** |
| 24 | 3.4 | [Durafen/Claude-code-memory](https://github.com/Durafen/Claude-code-memory) | 72 | Python | None | Memory Guard quality gate, persistent codebase memory, Voyage AI + Qdrant |
| 25 | 3.3 | [NeuralRays/codexray](https://github.com/NeuralRays/codexray) | 2 | TypeScript | MIT | 16 MCP tools, TF-IDF semantic search (~50MB), dead code, complexity, path finding |
| 26 | 3.3 | [DucPhamNgoc08/CodeVisualizer](https://github.com/DucPhamNgoc08/CodeVisualizer) | 475 | TypeScript | MIT | VS Code extension, tree-sitter WASM, flowcharts + dependency graphs, 5 AI providers, 9 themes |
| 27 | 3.3 | [helabenkhalfallah/code-health-meter](https://github.com/helabenkhalfallah/code-health-meter) | 34 | JavaScript | MIT | Formal health metrics (MI, CC, Louvain modularity), published in ACM TOSEM 2025 |
| 28 | 3.3 | [JohT/code-graph-analysis-pipeline](https://github.com/JohT/code-graph-analysis-pipeline) | 27 | Cypher | GPL-3.0 | 200+ CSV reports, ML anomaly detection, Leiden/HashGNN, jQAssistant + Neo4j for Java |
| 29 | 3.3 | [Lekssays/codebadger](https://github.com/Lekssays/codebadger) | 43 | Python | GPL-3.0 | Containerized MCP server using Joern CPG, 12+ languages |
| 30 | 3.2 | [al1-nasir/codegraph-cli](https://github.com/al1-nasir/codegraph-cli) | 11 | Python | MIT | CrewAI multi-agent system, 6 LLM providers, browser explorer, DOCX export |
| 31 | 3.1 | [anasdayeh/claude-context-local](https://github.com/anasdayeh/claude-context-local) | 0 | Python | None | 100% local, Merkle DAG incremental indexing, sharded FAISS, hybrid BM25+vector, GPU accel |
| 32 | 3.0 | [Vasu014/loregrep](https://github.com/Vasu014/loregrep) | 12 | Rust | Apache-2.0 | In-memory index library, Rust + Python bindings, AI-tool-ready schemas |
| 33 | 3.0 | [xnuinside/codegraph](https://github.com/xnuinside/codegraph) | 438 | Python | MIT | Python-only interactive HTML dependency diagrams with zoom/pan/search |
| 34 | 3.0 | [Adrninistrator/java-all-call-graph](https://github.com/Adrninistrator/java-all-call-graph) | 551 | Java | Apache-2.0 | Complete Java bytecode call graphs, Spring/MyBatis-aware, SQL-queryable DB |
| 35 | 3.0 | [Technologicat/pyan](https://github.com/Technologicat/pyan) | 395 | Python | GPL-2.0 | Python 3 call graph generator, module import analysis, cycle detection, interactive HTML |
| 36 | 3.0 | [GaloisInc/MATE](https://github.com/GaloisInc/MATE) | 194 | Python | BSD-3 | DARPA-funded interactive CPG-based bug hunting for C/C++ via LLVM |
| 37 | 3.0 | [clouditor/cloud-property-graph](https://github.com/clouditor/cloud-property-graph) | 28 | Kotlin | Apache-2.0 | Connects code property graphs with cloud runtime security assessment |

### Tier 2: Niche & Single-Language Tools (score 2.0–2.9)

| # | Score | Project | Stars | Lang | License | Summary |
|---|-------|---------|-------|------|---------|---------|
| 37 | 2.9 | [rahulvgmail/CodeInteliMCP](https://github.com/rahulvgmail/CodeInteliMCP) | 8 | Python | None | DuckDB + ChromaDB (zero Docker), multi-repo, lightweight embedded DBs |
| 38 | 2.8 | [Aider-AI/aider](https://github.com/Aider-AI/aider) | 42,198 | Python | Apache-2.0 | AI pair programming CLI; tree-sitter repo map with PageRank-style graph ranking for LLM context selection, 100+ languages, multi-provider LLM support, git-integrated auto-commits. Moved to Aider-AI org |
| 39 | 2.8 | [scottrogowski/code2flow](https://github.com/scottrogowski/code2flow) | 4,528 | Python | MIT | Call graphs for Python/JS/Ruby/PHP via AST, DOT output, 100% test coverage |
| 40 | 2.8 | [ysk8hori/typescript-graph](https://github.com/ysk8hori/typescript-graph) | 200 | TypeScript | None | TypeScript file-level dependency Mermaid diagrams, code metrics (MI, CC), watch mode |
| 41 | 2.8 | [nuanced-dev/nuanced-py](https://github.com/nuanced-dev/nuanced-py) | 126 | Python | MIT | Python call graph enrichment designed for AI agent consumption |
| 42 | 2.8 | [sdsrss/code-graph-mcp](https://github.com/sdsrss/code-graph-mcp) | 16 | TypeScript | MIT | AST knowledge graph MCP server with tree-sitter, 10 languages. New entrant |
| 43 | 2.8 | [Bikach/codeGraph](https://github.com/Bikach/codeGraph) | 6 | TypeScript | MIT | Neo4j graph, Claude Code slash commands, Kotlin support, 40-50% cost reduction |
| 43 | 2.8 | [ChrisRoyse/CodeGraph](https://github.com/ChrisRoyse/CodeGraph) | 65 | TypeScript | None | Neo4j + MCP, multi-language, framework detection (React, Tailwind, Supabase) |
| 44 | 2.8 | [Symbolk/Code2Graph](https://github.com/Symbolk/Code2Graph) | 48 | Java | None | Multilingual code → language-agnostic graph representation |
| 45 | 2.7 | [yumeiriowl/repo-graphrag-mcp](https://github.com/yumeiriowl/repo-graphrag-mcp) | 3 | Python | MIT | LightRAG + tree-sitter, entity merge (code ↔ docs), implementation planning tool |
| 46 | 2.7 | [davidfraser/pyan](https://github.com/davidfraser/pyan) | 712 | Python | GPL-2.0 | Python call graph generator (stable fork), DOT/SVG/HTML output, Sphinx integration |
| 47 | 2.7 | [mamuz/PhpDependencyAnalysis](https://github.com/mamuz/PhpDependencyAnalysis) | 572 | PHP | MIT | PHP dependency graphs, cycle detection, architecture verification against defined layers |
| 48 | 2.7 | [faraazahmad/graphsense](https://github.com/faraazahmad/graphsense) | 35 | TypeScript | MIT | MCP server providing code intelligence via static analysis |
| 49 | 2.7 | [JonnoC/CodeRAG](https://github.com/JonnoC/CodeRAG) | 14 | TypeScript | MIT | Enterprise code intelligence with CK metrics, Neo4j, 23 analysis tools, MCP server |
| 50 | 2.6 | [0xjcf/MCP_CodeAnalysis](https://github.com/0xjcf/MCP_CodeAnalysis) | 7 | Python/TS | None | Stateful tools (XState), Redis sessions, socio-technical analysis, dual language impl |
| 51 | 2.5 | [koknat/callGraph](https://github.com/koknat/callGraph) | 325 | Perl | GPL-3.0 | Multi-language (22+) call graph generator via regex, GraphViz output |
| 52 | 2.5 | [RaheesAhmed/code-context-mcp](https://github.com/RaheesAhmed/code-context-mcp) | 0 | Python | MIT | Security pattern detection, auto architecture diagrams, code flow tracing |
| 53 | 2.5 | [league1991/CodeAtlasVsix](https://github.com/league1991/CodeAtlasVsix) | 265 | C# | GPL-2.0 | Visual Studio plugin, Doxygen-based call graph navigation (VS 2010-2015 era) |
| 54 | 2.5 | [beicause/call-graph](https://github.com/beicause/call-graph) | 105 | TypeScript | Apache-2.0 | VS Code extension generating call graphs via LSP call hierarchy API |
| 55 | 2.5 | [Thibault-Knobloch/codebase-intelligence](https://github.com/Thibault-Knobloch/codebase-intelligence) | 44 | Python | None | Code indexing + call graph + vector DB + natural language queries (requires OpenAI) |
| 56 | 2.5 | [darkmacheken/wasmati](https://github.com/darkmacheken/wasmati) | 31 | C++ | Apache-2.0 | CPG infrastructure for scanning vulnerabilities in WebAssembly |
| 57 | 2.5 | [sutragraph/sutracli](https://github.com/sutragraph/sutracli) | 28 | Python | GPL-3.0 | AI-powered cross-repo dependency graphs for coding agents |
| 58 | 2.5 | [julianjensen/ast-flow-graph](https://github.com/julianjensen/ast-flow-graph) | 69 | JavaScript | Other | JavaScript control flow graphs from AST analysis |
| 59 | 2.5 | [yoanbernabeu/grepai-skills](https://github.com/yoanbernabeu/grepai-skills) | 14 | — | MIT | 27 AI agent skills for semantic code search and call graph analysis |
| 60 | 2.4 | [shantham/codegraph](https://github.com/shantham/codegraph) | 0 | TypeScript | MIT | Polished `npx` one-command installer, sqlite-vss, 7 MCP tools |
| 61 | 2.3 | [ozyyshr/RepoGraph](https://github.com/ozyyshr/RepoGraph) | 251 | Python | Apache-2.0 | SWE-bench code graph research (ctags + networkx for LLM context) |
| 62 | 2.3 | [emad-elsaid/rubrowser](https://github.com/emad-elsaid/rubrowser) | 644 | Ruby | MIT | Ruby-only interactive D3 force-directed dependency graph |
| 63 | 2.3 | [Chentai-Kao/call-graph-plugin](https://github.com/Chentai-Kao/call-graph-plugin) | 87 | Kotlin | None | IntelliJ plugin for visualizing call graphs in IDE |
| 64 | 2.3 | [ehabterra/apispec](https://github.com/ehabterra/apispec) | 72 | Go | Apache-2.0 | OpenAPI 3.1 spec generator from Go code via call graph analysis |
| 65 | 2.3 | [huoyo/ko-time](https://github.com/huoyo/ko-time) | 61 | Java | LGPL-2.1 | Spring Boot call graph with runtime durations |
| 66 | 2.3 | [Fraunhofer-AISEC/codyze](https://github.com/Fraunhofer-AISEC/codyze) | 91 | Kotlin | None | CPG-based analyzer for cryptographic API misuse (archived, merged into cpg repo) |
| 67 | 2.3 | [CartographAI/mcp-server-codegraph](https://github.com/CartographAI/mcp-server-codegraph) | 17 | JavaScript | MIT | Lightweight MCP code graph (3 tools only, Python/JS/Rust) |
| 68 | 2.3 | [YounesBensafia/DevLens](https://github.com/YounesBensafia/DevLens) | 21 | Python | None | Repo scanner with AI summaries, dead code detection (dep graph not yet implemented) |
| 69 | 2.3 | [0xd219b/codegraph](https://github.com/0xd219b/codegraph) | 0 | Rust | None | Pure Rust, HTTP server mode, Java + Go support |
| 70 | 2.3 | [aryx/codegraph](https://github.com/aryx/codegraph) | 6 | OCaml | Other | Multi-language source code dependency visualizer (the original "codegraph" name) |
| 71 | 2.2 | [jmarkowski/codeviz](https://github.com/jmarkowski/codeviz) | 144 | Python | MIT | C/C++ `#include` header dependency graph visualization |
| 72 | 2.2 | [juanallo/vscode-dependency-cruiser](https://github.com/juanallo/vscode-dependency-cruiser) | 76 | JavaScript | MIT | VS Code wrapper for dependency-cruiser (JS/TS) |
| 73 | 2.2 | [hidva/as2cfg](https://github.com/hidva/as2cfg) | 63 | Rust | GPL-3.0 | Intel assembly → control flow graph |
| 74 | 2.2 | [microsoft/cmd-call-graph](https://github.com/microsoft/cmd-call-graph) | 55 | Python | MIT | Call graphs for Windows CMD batch files |
| 75 | 2.2 | [siggy/gographs](https://github.com/siggy/gographs) | 52 | Go | MIT | Go package dependency graph generator |
| 76 | 2.2 | [henryhale/depgraph](https://github.com/henryhale/depgraph) | 33 | Go | MIT | Go-focused codebase dependency analysis |
| 77 | 2.2 | [2015xli/clangd-graph-rag](https://github.com/2015xli/clangd-graph-rag) | 28 | Python | Apache-2.0 | C/C++ Neo4j GraphRAG via clangd (scales to Linux kernel) |
| 78 | 2.1 | [floydw1234/badger-graph](https://github.com/floydw1234/badger-graph) | 0 | Python | None | Dgraph backend (Docker), C struct field access tracking |
| 79 | 2.0 | [crubier/code-to-graph](https://github.com/crubier/code-to-graph) | 382 | JavaScript | None | JS code → Mermaid flowchart (single-function, web demo) |
| 80 | 2.0 | [khushil/code-graph-rag](https://github.com/khushil/code-graph-rag) | 0 | Python | MIT | Fork of vitali87/code-graph-rag with no modifications |
| 81 | 2.0 | [FalkorDB/code-graph-backend](https://github.com/FalkorDB/code-graph-backend) | 26 | Python | MIT | FalkorDB (Redis-based graph) code analysis demo |
| 82 | 2.0 | [jillesvangurp/spring-depend](https://github.com/jillesvangurp/spring-depend) | 46 | Java | MIT | Spring bean dependency graph extraction |
| 83 | 2.0 | [ivan-m/SourceGraph](https://github.com/ivan-m/SourceGraph) | 27 | Haskell | GPL-3.0 | Haskell graph-theoretic code analysis (last updated 2022) |
| 84 | 2.0 | [brutski/go-code-graph](https://github.com/brutski/go-code-graph) | 13 | Go | MIT | Go codebase analyzer with MCP integration |

### Tier 3: Minimal or Inactive (score < 2.0)

| Score | Project | Stars | Summary |
|-------|---------|-------|---------|
| 1.8 | [m3et/CodeRAG](https://github.com/m3et/CodeRAG) | 0 | Iterative RAG with self-reflection, ChromaDB, Azure OpenAI dependent |
| 1.8 | [getyourguide/spmgraph](https://github.com/getyourguide/spmgraph) | 239 | Swift Package Manager dependency graph + architecture linting |
| 1.8 | [mvidner/code-explorer](https://github.com/mvidner/code-explorer) | 53 | Ruby call graph and class dependency browser |
| 1.8 | [ytsutano/jitana](https://github.com/ytsutano/jitana) | 41 | Android DEX static+dynamic hybrid analysis |
| 1.8 | [ShiftLeftSecurity/fuzzyc2cpg](https://github.com/ShiftLeftSecurity/fuzzyc2cpg) | 37 | [ARCHIVED] Fuzzy C/C++ parser to CPG (Joern ecosystem) |
| 1.8 | [mufasadb/code-grapher](https://github.com/mufasadb/code-grapher) | 10 | MCP code graph server (early stage) |
| 1.8 | [dtsbourg/codegraph-fmt](https://github.com/dtsbourg/codegraph-fmt) | 7 | Annotated AST graph representations from Python |
| 1.8 | [mloncode/codegraph](https://github.com/mloncode/codegraph) | 5 | Git/UAST graph experiments |
| 1.7 | [ashishb/python_dep_generator](https://github.com/ashishb/python_dep_generator) | 22 | Python dependency graph generator |
| 1.7 | [LaurEars/codegrapher](https://github.com/LaurEars/codegrapher) | 15 | Python call graph visualizer |
| 1.7 | [AdilZouitine/ouakha.rs](https://github.com/AdilZouitine/ouakha.rs) | 7 | LLM-based Rust code analysis for suspicious code |
| 1.7 | [ensozos/geneci](https://github.com/ensozos/geneci) | 6 | UML diagrams and call graphs from source |
| 1.7 | [spullara/codegraph](https://github.com/spullara/codegraph) | 5 | Java JARs → Neo4j loader |
| 1.5 | [z7zmey/codegraph](https://github.com/z7zmey/codegraph) | 10 | PHP code visualization (last updated 2020) |
| 1.5 | [marcusva/cflow](https://github.com/marcusva/cflow) | 10 | C/assembler call graph generator |
| 1.5 | [beacoder/call-graph](https://github.com/beacoder/call-graph) | 5 | Emacs-based C/C++ call graph |

---

## Scoring Breakdown (Tier 1)

| # | Project | Features | Analysis Depth | Deploy Simplicity | Lang Support | Code Quality | Community |
|---|---------|----------|---------------|-------------------|-------------|-------------|-----------|
| 1 | GitNexus | 5 | 5 | 4 | 4 | 4 | 5 |
| 2 | joern | 5 | 5 | 3 | 4 | 5 | 5 |
| 3 | narsil-mcp | 5 | 5 | 5 | 5 | 4 | 3 |
| 4 | code-graph-rag | 5 | 4 | 3 | 4 | 4 | 5 |
| **5** | **codegraph (us)** | **5** | **5** | **5** | **4** | **5** | **3** |
| 6 | codebase-memory-mcp | 4 | 4 | 5 | 5 | 4 | 4 |
| 7 | cpg | 5 | 5 | 2 | 5 | 5 | 3 |
| 8 | CKB | 5 | 5 | 4 | 3 | 4 | 3 |
| 9 | axon | 5 | 5 | 4 | 2 | 4 | 3 |
| 10 | glimpse | 4 | 4 | 5 | 3 | 5 | 4 |
| 11 | codepropertygraph | 4 | 5 | 2 | 4 | 5 | 3 |
| 12 | codegraph-rust | 5 | 5 | 2 | 4 | 4 | 3 |
| 13 | arbor | 4 | 4 | 5 | 4 | 5 | 3 |
| 14 | mcp-code-graph | 4 | 3 | 4 | 4 | 3 | 4 |
| 15 | code-graph-mcp | 4 | 4 | 4 | 5 | 3 | 2 |
| 16 | jelly | 4 | 5 | 4 | 1 | 5 | 3 |
| 17 | colbymchenry/codegraph | 4 | 3 | 5 | 3 | 3 | 4 |
| 18 | code-graph-rag-mcp | 5 | 4 | 3 | 4 | 3 | 2 |
| 19 | mcp-codebase-index | 4 | 3 | 5 | 3 | 4 | 2 |
| 20 | CodeGraphMCPServer | 4 | 4 | 4 | 5 | 3 | 1 |
| 21 | stratify | 4 | 4 | 2 | 5 | 4 | 2 |
| 22 | cie | 5 | 4 | 4 | 3 | 4 | 1 |
| 23 | autodev-codebase | 5 | 3 | 3 | 5 | 3 | 3 |
| 24 | Claude-code-memory | 4 | 3 | 3 | 3 | 4 | 3 |
| 25 | codexray | 5 | 4 | 4 | 4 | 3 | 1 |
| 26 | CodeVisualizer | 4 | 3 | 5 | 3 | 3 | 2 |
| 27 | code-health-meter | 3 | 5 | 5 | 1 | 4 | 2 |
| 28 | code-graph-analysis-pipeline | 5 | 5 | 1 | 2 | 5 | 2 |
| 29 | codebadger | 4 | 4 | 3 | 5 | 3 | 1 |
| 30 | codegraph-cli | 5 | 3 | 3 | 2 | 3 | 2 |
| 31 | claude-context-local | 4 | 3 | 3 | 4 | 4 | 1 |
| 32 | loregrep | 3 | 3 | 4 | 3 | 5 | 2 |
| 33 | xnuinside/codegraph | 3 | 2 | 5 | 1 | 3 | 4 |
| 34 | java-all-call-graph | 4 | 4 | 3 | 1 | 3 | 3 |
| 35 | pyan | 3 | 3 | 5 | 1 | 4 | 2 |
| 36 | MATE | 3 | 5 | 1 | 1 | 3 | 2 |
| 37 | cloud-property-graph | 4 | 4 | 2 | 2 | 4 | 2 |

**Scoring criteria:**
- **Features** (1-5): breadth of tools, MCP integration, search, visualization, export
- **Analysis Depth** (1-5): how deep the code analysis goes (dead code, complexity, flow tracing, coupling)
- **Deploy Simplicity** (1-5): ease of setup — zero Docker = 5, requires Docker = 3, complex multi-service = 1
- **Lang Support** (1-5): number of well-supported programming languages
- **Code Quality** (1-5): architecture, performance characteristics, engineering rigor
- **Community** (1-5): stars, contributors, activity, documentation quality

---

## Where Codegraph Wins

| Strength | Details |
|----------|---------|
| **Always-fresh graph (incremental rebuilds)** | Three-tier change detection (journal → mtime+size → hash) means only changed files are re-parsed. Change 1 file in a 3,000-file project → rebuild in under a second. No other tool in this space offers true incremental rebuilds. Competitors re-index everything from scratch — making them unusable in commit hooks, watch mode, or agent-driven loops. Native Rust engine achieves ~4-6 ms/file on cold builds |
| **Qualified call resolution** | Import-aware resolution distinguishes method calls (`obj.method()`) from standalone function calls, filters 28+ built-in receivers (`console`, `Math`, `JSON`, `Array`, `Promise`, etc.), deduplicates edges, and respects import scope. A call to `foo()` only resolves to functions actually imported or in-scope — eliminating the false positives that plague tree-sitter-based tools. Confidence scoring (1.0 → 0.5) on every edge lets agents trust the graph |
| **AI-optimized compound commands** | `context` returns source + deps + callers + signature + related tests for a function in one call. `explain` gives structural summaries of files (public API, internals, data flow) or functions without reading the source. These save AI agents 50-80% of the token budget they'd otherwise spend navigating code. No competitor offers purpose-built compound context commands |
| **Zero-cost core, LLM-enhanced when you choose** | The full graph pipeline (parse, resolve, query, impact analysis) runs with no API keys, no cloud, no cost. LLM features (richer embeddings, semantic search) are an optional layer on top — using whichever provider the user already works with. Competitors either require cloud APIs for core features (code-graph-rag, autodev-codebase, mcp-code-graph) or offer no AI enhancement at all (CKB, axon). Nobody else offers both modes in one tool |
| **Data goes only where you send it** | Your code reaches exactly one place: the AI agent you already chose (via MCP). No additional third-party services, no surprise cloud calls. Competitors like code-graph-rag, autodev-codebase, mcp-code-graph, and Claude-code-memory send your code to additional AI providers beyond the agent you're using |
| **Dual engine architecture** | Only project with native Rust (napi-rs) + automatic WASM fallback. Others are pure Rust (narsil-mcp, codegraph-rust, codebase-memory-mcp) OR pure JS/Python — never both |
| **Standalone CLI + MCP** | Full 41-command CLI experience (`context`, `audit`, `where`, `fn-impact`, `diff-impact`, `map`, `deps`, `search`, `structure`, `sequence`, `roles`, `dataflow`, `cfg`, `ast`) alongside 32-tool MCP server. Many competitors are MCP-only (narsil-mcp, codebase-memory-mcp, code-graph-mcp, CodeGraphMCPServer) with no standalone query interface |
| **Single-repo MCP isolation** | Security-conscious default: tools have no `repo` property unless `--multi-repo` is explicitly enabled. Most competitors default to exposing everything |
| **Zero-dependency deployment** | `npm install` and done. No Docker, no external databases, no Python, no SCIP toolchains, no JVM. Published platform-specific binaries (`@optave/codegraph-{platform}-{arch}`) resolve automatically. Joern requires JDK 21, cpg requires Gradle + language-specific deps, codegraph-rust requires SurrealDB + LSP servers |
| **Structure & quality analysis** | `structure` shows directory cohesion scores, `hotspots` finds files with extreme fan-in/fan-out/density, `stats` includes a graph quality score (0-100) with false-positive warnings. These give agents architectural awareness without requiring external tools |
| **Node role classification** | Every symbol is auto-tagged as `entry`/`core`/`utility`/`adapter`/`dead`/`leaf` based on fan-in/fan-out patterns with adaptive median thresholds. Agents instantly know a function's architectural role without reading surrounding code. Inspired by arbor's role classification — but we compute roles automatically during graph build rather than requiring manual tagging, and we surface roles across all query commands (`where`, `explain`, `context`, `stats`, `list-functions`). Dead code detection comes free as a byproduct |
| **Callback pattern extraction** | Extracts symbols from Commander `.command().action()` (as `command:build`), Express route handlers (as `route:GET /api/users`), and event emitter listeners (as `event:data`). No competitor extracts symbols from framework callback patterns |

---

## Where Codegraph Loses

### vs GitNexus (#1, 18,453 stars)
- **Viral growth**: 18,453 stars in ~8 months — orders of magnitude more traction. Discord community, TrendShift badge, npm package (`gitnexus`)
- **Multi-editor integration**: Auto-configures Claude Code (with hooks), Cursor, Codex, Windsurf, OpenCode via `gitnexus setup`. We only support Claude Code MCP config
- **Auto-generated context files**: Creates AGENTS.md/CLAUDE.md from the knowledge graph — agents get codebase context automatically
- **Web UI + CLI + MCP**: Three access modes including a hosted web explorer at gitnexus.vercel.app. We have CLI + MCP + interactive HTML viewer but no hosted web UI
- **Bridge mode**: `gitnexus serve` connects CLI-indexed repos to the web UI — seamless local-to-browser workflow
- **Where we win**: Non-commercial license (PolyForm NC) blocks enterprise adoption. No incremental rebuilds (full re-index). LadybugDB is custom/unproven vs our SQLite. We have deeper analysis (complexity, dataflow, CFG, architecture boundaries, manifesto rules, CI gates) and confidence-scored edges. Their graph is broader but shallower

### vs joern (#2, 3,021 stars)
- **Full Code Property Graph**: AST + CFG + PDG combined for deep vulnerability analysis; our tree-sitter extraction captures structure but not interprocedural control/data flow
- **Scala query DSL**: purpose-built query language for arbitrary graph traversals vs our fixed CLI commands
- **Binary analysis**: Ghidra frontend can analyze compiled binaries — we're source-only
- **Enterprise backing**: ShiftLeft/Fraunhofer support, daily automated releases (v4.0.508), 75 contributors, professional documentation at joern.io
- **Community**: 3,021 stars, 400 forks — massive traction. 4 community MCP wrappers now available

### vs narsil-mcp (#3, 129 stars)
- **Feature breadth**: 90 MCP tools vs our 32; covers taint analysis, SBOM, license compliance, control flow graphs, data flow analysis
- **Language count**: 32 languages (including Verilog, Fortran, PowerShell, Nix) vs our 11
- **Security analysis**: vulnerability scanning with OWASP/CWE coverage, 147+ rules (added 36 Rust/Elixir rules in v1.6.0) — we have no security features
- **SPA web frontend**: Full web UI with file tree sidebar, syntax-highlighted code viewer, dashboard, per-repo overview, CFG visualization (added v1.6.0)
- **Single-binary deployment**: ~30MB Rust binary via brew/scoop/cargo/npm — as easy as ours
- **Note**: No activity since Feb 25 (24+ day gap) — development may have paused

### vs code-graph-rag (#4, 2,168 stars)
- **Graph query expressiveness**: Memgraph + Cypher enables arbitrary graph traversals; our CLI commands are more rigid
- **AI-powered code editing**: they can surgically edit functions via AST targeting with visual diffs
- **Provider flexibility**: they support Gemini/OpenAI/Claude/Ollama and can mix providers per task
- **MCP server**: now added MCP support, expanding from pure RAG into the AI agent ecosystem
- **Community**: 2,168 stars — significant traction

### vs codebase-memory-mcp (#6, 793 stars — NEW)
- **Explosive growth**: 793 stars in 25 days — fastest-growing new entrant in the space. Single-developer C project
- **Zero-dependency binary**: Single static C binary (~30MB), no Node.js/JVM/runtime. Auto-installer configures 10 different AI agents in one command
- **64 languages**: 3x our language coverage via vendored tree-sitter grammars compiled into the binary
- **Cypher-like query language**: Hand-built Cypher subset in C for arbitrary graph traversals — we have no query DSL
- **HTTP route analysis**: First-class Route nodes and cross-service HTTP call linking with confidence scoring — unique capability
- **3D graph visualization**: Built-in web-based 3D graph viewer
- **Where we win**: MCP-only (no standalone CLI), no semantic search/embeddings, no complexity metrics, no cycle detection, no export formats (DOT/Mermaid/GraphML), no architecture boundaries, no CI gates, no programmatic API, limited Cypher subset (no WITH/COLLECT/OPTIONAL MATCH). Very immature (v0.5.x, 25 days old, solo developer). Our analysis depth is significantly greater

### vs cpg (#7, 424 stars)
- **Formal CPG specification**: academic-grade graph representation (AST + CFG + PDG + DFG) with published specs
- **MCP module**: built-in MCP support now, matching our integration
- **LLVM IR support**: extends language coverage to any LLVM-compiled language (Rust, Swift, etc.)
- **Type inference**: can analyze incomplete/partial code — our tree-sitter requires syntactically valid input

### vs glimpse (#10, 349 stars — stagnant)
- **LLM workflow optimization**: clipboard-first output + token counting + XML output mode — purpose-built for "code → LLM context"
- **LSP-based call resolution**: compiler-grade accuracy vs our tree-sitter heuristic approach
- **Web content processing**: can fetch URLs and convert HTML to markdown for context

### vs CKB (#8, 77 stars)
- **Indexing accuracy**: SCIP provides compiler-grade cross-file references (type-aware), fundamentally more accurate than tree-sitter for supported languages
- **Compound operations**: `explore`/`understand`/`prepareChange` batch multiple queries into one call — 83% token reduction. *(Gap closed: our `context`, `audit`, and `batch` commands now serve the same purpose)*
- **Now claims impact analysis and architecture mapping**: Feature convergence with v8.1.0 — they're moving into our territory
- **Secret scanning**: enterprise feature we lack

### vs axon (#9, 577 stars)
- **Hit v1.0 milestone**: Now a stable release with tree-sitter + KuzuDB + CLI + MCP. Growing fast (+156 stars since Feb)
- **Leiden community detection**: More sophisticated clustering than our Louvain
- **KuzuDB with native Cypher**: More expressive for complex graph queries than our SQLite
- **Git change coupling**: Co-change analysis — *(Gap closed: we now have `co-change` command)*
- **Branch structural diff**: *(Gap closed: we now have `branch-compare`)*

### vs codegraph-rust (#12, 142 stars)
- **LSP-powered analysis**: compiler-grade cross-file references via rust-analyzer, pyright, gopls vs our tree-sitter heuristics
- **Dataflow edges**: defines/uses/flows_to/returns/mutates relationships — *(Gap closed: we now have `flows_to`/`returns`/`mutates` across all 11 languages)*
- **Architecture boundary enforcement**: *(Gap closed: we now have `boundaries` command with onion/hexagonal/layered/clean presets)*
- **Tiered indexing**: fast/balanced/full modes for different use cases — we have one mode

### vs jelly (#16, 417 stars)
- **Points-to analysis**: flow-insensitive analysis with access paths for JS/TS — fundamentally more precise than our tree-sitter-based call resolution
- **Academic rigor**: 5 published papers backing the methodology (Aarhus University)
- **Vulnerability exposure analysis**: library usage pattern matching specific to the JS/TS ecosystem

### vs aider (#38, 42,198 stars — now Aider-AI/aider)
- **Different product category**: Aider is an AI pair programming CLI, not a code graph tool — but its tree-sitter repo map with PageRank-style graph ranking is a lightweight alternative to our full graph for LLM context selection
- **Massive community**: 42,198 stars, 4,054 forks — orders of magnitude more traction than any tool in this space. Aider *is* the category leader for AI-assisted coding in the terminal. Moved to Aider-AI org
- **100+ languages**: tree-sitter parsing covers far more languages than our 11, though only for identifier extraction (not full symbol/call resolution)
- **Multi-provider LLM**: works with Claude, GPT-4, Gemini, DeepSeek, Ollama, and virtually any LLM out of the box
- **Built-in code editing**: Aider's core loop is "understand code → edit code → commit." We provide the understanding layer but don't edit
- **Where we win**: Aider's repo map is shallow — file-level dependency graph with identifier ranking, no function-level call resolution, no impact analysis, no dead code detection, no complexity metrics, no MCP server, no standalone queryable graph. It answers "what's relevant?" but not "what breaks if I change this?" Our graph is deeper and persistent; Aider rebuilds its map per-request

### vs colbymchenry/codegraph (#17, 308 stars — nearly doubled)
- **Fastest-growing naming competitor**: 165 → 308 stars since Feb. Same name, same tech stack (tree-sitter + SQLite + MCP + Node.js) — marketplace confusion is increasing
- **Published benchmarks**: 67% fewer tool calls and measurable Claude Code token reduction — compelling marketing. *(Gap closed: our `context`, `audit`, and `batch` compound commands provide equivalent or better token savings)*
- **One-liner setup**: `npx @colbymchenry/codegraph` with interactive installer auto-configures Claude Code
- **Where we win**: We have 41 CLI commands vs their MCP-only approach, confidence-scored edges, dataflow/CFG/AST analysis, complexity metrics, architecture boundaries, cycle detection, dead code/export detection, community detection, sequence diagrams, and CI gates. Their tool is a lightweight MCP wrapper; ours is a full code intelligence platform

---

## Features to Adopt — Priority Roadmap

### Tier 1: High impact, low effort
| Feature | Inspired by | Why | Status |
|---------|------------|-----|--------|
| ~~**Dead code detection**~~ | narsil-mcp, axon, codexray, CKB | ~~We have the graph — find nodes with zero incoming edges (minus entry points/exports). Agents constantly ask "is this used?"~~ | **DONE** — Delivered via node classification. `roles --role dead` lists all unreferenced, non-exported symbols |
| ~~**Fuzzy symbol search**~~ | arbor | ~~Add Levenshtein/Jaro-Winkler to `fn` command. Currently requires exact match~~ | **DONE** — `fn` now has relevance scoring (exact > prefix > word-boundary > substring) with fan-in tiebreaker, plus `--file` and `--kind` filters |
| ~~**Expose confidence scores**~~ | arbor | ~~Already computed internally in import resolution — just surface them~~ | **DONE** — confidence scores stored on every call edge, surfaced in `stats` graph quality score |
| ~~**Shortest path A→B**~~ | codexray, arbor | ~~BFS on existing edges table~~ | **DONE** — `codegraph path <from> <to>` with BFS on call graph edges |

### Tier 2: High impact, medium effort
| Feature | Inspired by | Why | Status |
|---------|------------|-----|--------|
| **Optional LLM provider integration** | code-graph-rag, autodev-codebase | Bring-your-own provider (OpenAI, etc.) for richer embeddings and AI-powered search. Enhancement layer only — core graph never depends on it. No other tool offers both zero-cost local and LLM-enhanced modes in one package | TODO |
| ~~**Compound MCP tools**~~ | CKB, colbymchenry/codegraph | ~~`explore`/`understand` meta-tools that batch deps + fn + map into single responses~~ | **DONE** — `context` returns source + deps + callers + signature + tests in one call; `explain` returns structural summaries of files or functions |
| **Token counting on responses** | glimpse, arbor | tiktoken-based counts so agents know context budget consumed | TODO |
| ~~**Node classification**~~ | arbor | ~~Auto-tag Entry Point / Core / Utility / Adapter from in-degree/out-degree patterns~~ | **DONE** — `classifyNodeRoles()` tags every symbol as `entry`/`core`/`utility`/`adapter`/`dead`/`leaf`. New `roles` CLI command, `node_roles` MCP tool, `--role`/`--file` filters. Roles surfaced in `where`/`context`/`stats`/`list-functions` |
| **TF-IDF lightweight search** | codexray | SQLite FTS5 + TF-IDF as a middle tier (~50MB) between "no search" and full transformers (~500MB) | TODO |
| **OWASP/CWE pattern detection** | narsil-mcp, CKB | Security pattern scanning on the existing AST — hardcoded secrets, SQL injection patterns, XSS | TODO |
| ~~**Formal code health metrics**~~ | code-health-meter | ~~Cyclomatic complexity, Maintainability Index, Halstead metrics per function~~ | **DONE** — `codegraph complexity` delivers cognitive, cyclomatic (CFG-derived), Halstead, MI, nesting depth per function across all 11 languages |

### Tier 3: High impact, high effort
| Feature | Inspired by | Why | Status |
|---------|------------|-----|--------|
| ~~**Interactive HTML visualization**~~ | autodev-codebase, CodeVisualizer | ~~`codegraph viz` → opens interactive graph in browser~~ | **DONE** — `codegraph plot` opens interactive vis-network HTML viewer with physics, clustering, drill-down |
| ~~**Git change coupling**~~ | axon | ~~Analyze git history for files that always change together~~ | **DONE** — `codegraph co-change` analyzes git history for temporal file coupling |
| ~~**Community detection**~~ | axon, GitNexus, CodeGraphMCPServer | ~~Louvain algorithm to discover natural module boundaries~~ | **DONE** — `codegraph communities` with Louvain clustering and drift analysis |
| ~~**Execution flow tracing**~~ | axon, GitNexus, code-context-mcp | ~~Framework-aware entry point detection + BFS flow tracing~~ | **DONE** — `codegraph flow` traces from entry points (routes, commands, events) through callees to leaves |
| ~~**Dataflow analysis**~~ | codegraph-rust | ~~Define/use chains and flows_to/returns/mutates edges~~ | **DONE** — `codegraph dataflow` with `flows_to`/`returns`/`mutates` edges across all 11 languages |
| ~~**Architecture boundary rules**~~ | codegraph-rust, stratify | ~~User-defined rules for allowed/forbidden dependencies between modules~~ | **DONE** — `codegraph check` with configurable boundary rules and onion/hexagonal/layered/clean presets |

### Paid Solutions

#### Sourcegraph (sourcegraph.com)

**What it is:** Enterprise code intelligence platform. Cloud-hosted and self-hosted. Proprietary, paid per user (free tier for individuals).

**Core features:**

| Feature | Description | Codegraph equivalent | Gap |
|---------|-------------|---------------------|-----|
| **Code Search** | Full-text regex search across all repos, branches, commits, and diffs. RE2 engine with boolean operators (`AND`/`OR`/`NOT`), compound filters (`repo:`, `file:`, `lang:`, `author:`, `before:`/`after:`), output shaping (`select:repo`, `select:symbol.function`, `select:file.owners`), and `rev:at.time()` for historical point-in-time search. Search Contexts define reusable named scopes | `codegraph search` (hybrid BM25+semantic), `where`, `list-functions` with `-f`/`-k`/`-T` filters | **Partial** — we have semantic+keyword search but lack boolean compound queries, diff/commit content search, output reshaping, and named search contexts. Backlog IDs 75, 79 |
| **Deep Search** | Agentic natural-language search: an AI agent iteratively uses Code Search + Code Navigation tools, refining its understanding each loop until confident. Returns markdown answers with source citations. Conversational follow-ups | `codegraph search` (semantic mode) finds conceptual matches but returns raw results, not synthesized answers | **Yes** — we do semantic search but not agentic iterative search with synthesized answers. This is an LLM-layer feature — could be built on top of our MCP tools by an orchestrating agent rather than built into codegraph itself |
| **Code Navigation** | Go-to-definition, find-references, find-implementations across repositories. Two tiers: search-based (heuristic, instant) and precise (SCIP compiler-accurate indexers). Popover type signatures and docs inline | `codegraph where` (search-based), `codegraph query` (callers/callees), `codegraph context` (full context). No find-implementations | **Partial** — we have search-based navigation and caller/callee chains. We lack interface→implementation tracking (backlog ID 74) and cross-repo reference resolution (backlog ID 78) |
| **Code Monitoring** | Persistent watch rules on `type:diff`/`type:commit` queries. Fires email, Slack webhook, or custom HTTP webhook when new commits match. No limit on monitor count or monitored code volume | `codegraph build --watch` (incremental rebuild), `codegraph check --staged` (CI predicates) | **Partial** — we have watch-mode rebuilds and CI predicates but no persistent query-based commit monitors with notification actions. Backlog ID 76 |
| **Code Ownership** | CODEOWNERS as a first-class search dimension: `file:has.owner()`, `select:file.owners`, owner-scoped queries. Resolves CODEOWNERS entries against user profiles | `codegraph owners` with `--owner`, `--boundary` filters. Integrated into `diff-impact` (affected owners + suggested reviewers). `code_owners` MCP tool | **No gap** — feature parity. We parse CODEOWNERS, match patterns, integrate into impact analysis, and expose via CLI + MCP. They have richer owner-as-search-filter syntax; our backlog ID 79 (advanced query language) would close this |
| **Code Insights** | Track any search query as a time-series metric on dashboards. Automatic historical backfill from git history — years of data immediately. Migration progress, tech debt trends, codebase composition over time | `codegraph stats` (point-in-time), `codegraph snapshot` (manual checkpoints) | **Yes** — we have point-in-time metrics and manual snapshots but no automated historical trend tracking. Backlog ID 77 |
| **Batch Changes** | Declarative YAML spec → automated code changes across hundreds of repos. Creates PRs on all affected repos, tracks merge status, CI checks, review approvals. Burndown charts for migration progress | None — codegraph is read-only by design (Foundation P8: we don't edit code or make decisions) | **By design** — we're a graph query tool, not a code modification tool. This is out of scope per Foundation principles |
| **CLI (`src`)** | Terminal search, batch change creation, SBOM generation, repo/user/team admin, code intelligence ops, CODEOWNERS management | `codegraph` CLI with 41 commands, 32-tool MCP server | **Partial** — our CLI is richer for graph queries; theirs is richer for admin/batch/SBOM operations. Different focus areas |

**Where Sourcegraph wins over codegraph:**

| Advantage | Details |
|-----------|---------|
| **Scale** | Designed for 100,000+ repo enterprises. Indexed search across all repos, branches, and history simultaneously. Our multi-repo mode works but is designed for tens of repos, not thousands |
| **Precise navigation (SCIP)** | Compiler-accurate go-to-definition and find-references via language-specific SCIP indexers. Our tree-sitter resolution is heuristic — good enough for most cases but fundamentally less accurate for typed languages |
| **Diff/commit content search** | First-class search within git diffs and commit messages with author/date filters. We have `co-change` (statistical correlation) but can't search actual diff content |
| **Code monitoring** | Persistent query-based alerts on new commits with webhook/Slack/email actions. Our `--watch` mode rebuilds the graph but doesn't evaluate persistent query triggers |
| **Historical insights** | Automatic time-series tracking of any metric over git history with dashboard visualization. We have manual snapshots but no automated trend tracking |
| **Enterprise ecosystem** | SSO, RBAC, audit logs, IDE extensions (VS Code, JetBrains, Neovim), browser extension for GitHub/GitLab code review. We're a CLI + MCP tool |
| **Boolean query language** | Rich boolean operators, compound filters, output reshaping, and named search contexts. Our search is either semantic (fuzzy) or exact-name (`where`) |

**Where codegraph wins over Sourcegraph:**

| Advantage | Details |
|-----------|---------|
| **Zero infrastructure** | `npm install` and done. No server, no Docker, no cloud, no accounts. Sourcegraph requires either a cloud subscription or a self-hosted instance (Kubernetes/Docker Compose) |
| **Function-level graph** | We build and query at function/method/class granularity with call edges, dataflow, CFG, and impact analysis. Sourcegraph operates at file/symbol level — search finds symbols but doesn't build a persistent dependency graph with blast radius analysis |
| **Impact analysis** | `diff-impact`, `fn-impact`, `branch-compare` trace transitive blast radius through the call graph. Sourcegraph's `find-references` shows direct references but not transitive impact chains |
| **Complexity & health metrics** | Cognitive, cyclomatic, Halstead, MI per function with CI gates. Sourcegraph has no built-in code health metrics |
| **Community detection & drift** | Louvain clustering reveals architectural drift between directory structure and actual dependencies. Sourcegraph has no equivalent |
| **Dataflow analysis** | `flows_to`/`returns`/`mutates` edges track how data moves through functions across all 11 languages. Sourcegraph doesn't do dataflow analysis |
| **Control flow graphs** | Per-function CFG with basic blocks stored in the graph; cyclomatic complexity derived from CFG structure (E - N + 2). Sourcegraph doesn't build CFGs |
| **Sequence diagrams** | `sequence <name>` generates Mermaid sequence diagrams from call graph edges. Sourcegraph has no diagram generation |
| **Node role classification** | Every symbol auto-tagged as entry/core/utility/adapter/dead/leaf. Sourcegraph has no architectural role concept |
| **Cost** | Completely free and open source (Apache-2.0). Sourcegraph's paid plans start at $49/user/month for enterprise features |
| **Privacy** | Your code never leaves your machine (unless you choose to connect an LLM). Sourcegraph Cloud processes your code on their infrastructure; self-hosted requires significant ops investment |
| **AI-optimized output** | `context`, `audit`, `triage`, `batch`, `sequence` commands are purpose-built for AI agent consumption with structured JSON. Sourcegraph's output is designed for human developers in a web UI |

### Not worth copying
| Feature | Why skip |
|---------|----------|
| Memgraph/Neo4j/KuzuDB/SurrealDB/LadybugDB | Our SQLite = zero Docker, simpler deployment. Query gap matters less than simplicity. codegraph-rust's SurrealDB requirement is its biggest weakness. GitNexus's LadybugDB is custom/unproven |
| SCIP indexing | Would require maintaining SCIP toolchains per language. Tree-sitter + native Rust is the right bet |
| Full CPG (AST+CFG+PDG) | Joern/cpg's approach requires fundamentally different parsing — we'd be rebuilding Joern. Tree-sitter gives us AST-level graphs; adding lightweight dataflow on top is the pragmatic path |
| Points-to analysis | Academic-grade JS analysis (jelly) — overkill for our use case and limited to JS/TS |
| Cloud-hosted graph service | mcp-code-graph (CodeGPT) requires accounts and cloud dependency — goes against our local-first philosophy |
| CrewAI multi-agent | Overengineered for a code analysis tool. Keep the scope focused |
| Clipboard/LLM-dump mode | Different product category (glimpse). We're a graph tool, not a context-packer |

