# Competitive Analysis — Code Graph / Code Intelligence Tools

**Date:** 2026-02-22
**Scope:** 21 code analysis tools compared against `@optave/codegraph`

---

## Overall Ranking

Ranked by weighted score across 6 dimensions (each 1–5):

| # | Score | Project | Stars | Lang | License | Summary |
|---|-------|---------|-------|------|---------|---------|
| 1 | 4.5 | [vitali87/code-graph-rag](https://github.com/vitali87/code-graph-rag) | 1,916 | Python | MIT | Graph RAG with Memgraph, multi-provider AI, code editing, semantic search, MCP |
| 2 | 4.2 | [seatedro/glimpse](https://github.com/seatedro/glimpse) | 349 | Rust | MIT | Clipboard-first codebase-to-LLM tool with call graphs, token counting, LSP resolution |
| 3 | 4.0 | [SimplyLiz/CodeMCP (CKB)](https://github.com/SimplyLiz/CodeMCP) | 59 | Go | Custom | SCIP-based indexing, compound operations (83% token savings), CODEOWNERS, secret scanning |
| 4 | 3.9 | [harshkedia177/axon](https://github.com/harshkedia177/axon) | 29 | Python | None | 11-phase pipeline, KuzuDB, Leiden community detection, dead code, change coupling |
| 5 | 3.8 | [anrgct/autodev-codebase](https://github.com/anrgct/autodev-codebase) | 111 | TypeScript | None | 40+ languages, 7 embedding providers, Cytoscape.js visualization, LLM reranking |
| 6 | 3.7 | [Anandb71/arbor](https://github.com/Anandb71/arbor) | 85 | Rust | MIT | Native GUI, confidence scoring, architectural role classification, fuzzy search, MCP |
| **7** | **3.6** | **[@optave/codegraph](https://github.com/optave/codegraph)** | — | **JS/Rust** | **Apache-2.0** | **Dual engine (native Rust + WASM), 11 languages, SQLite, MCP, semantic search, zero-cloud** |
| 8 | 3.4 | [Durafen/Claude-code-memory](https://github.com/Durafen/Claude-code-memory) | 72 | Python | None | Memory Guard quality gate, persistent codebase memory, Voyage AI + Qdrant |
| 9 | 3.3 | [NeuralRays/codexray](https://github.com/NeuralRays/codexray) | 2 | TypeScript | MIT | 16 MCP tools, TF-IDF semantic search (~50MB), dead code, complexity, path finding |
| 10 | 3.2 | [al1-nasir/codegraph-cli](https://github.com/al1-nasir/codegraph-cli) | 11 | Python | MIT | CrewAI multi-agent system, 6 LLM providers, browser explorer, DOCX export |
| 11 | 3.1 | [anasdayeh/claude-context-local](https://github.com/anasdayeh/claude-context-local) | 0 | Python | None | 100% local, Merkle DAG incremental indexing, sharded FAISS, hybrid BM25+vector, GPU accel |
| 12 | 3.0 | [Vasu014/loregrep](https://github.com/Vasu014/loregrep) | 12 | Rust | Apache-2.0 | In-memory index library, Rust + Python bindings, AI-tool-ready schemas |
| 13 | 2.9 | [rahulvgmail/CodeInteliMCP](https://github.com/rahulvgmail/CodeInteliMCP) | 8 | Python | None | DuckDB + ChromaDB (zero Docker), multi-repo, lightweight embedded DBs |
| 14 | 2.8 | [Bikach/codeGraph](https://github.com/Bikach/codeGraph) | 6 | TypeScript | MIT | Neo4j graph, Claude Code slash commands, Kotlin support, 40-50% cost reduction |
| 15 | 2.7 | [yumeiriowl/repo-graphrag-mcp](https://github.com/yumeiriowl/repo-graphrag-mcp) | 3 | Python | MIT | LightRAG + tree-sitter, entity merge (code ↔ docs), implementation planning tool |
| 16 | 2.6 | [0xjcf/MCP_CodeAnalysis](https://github.com/0xjcf/MCP_CodeAnalysis) | 7 | Python/TS | None | Stateful tools (XState), Redis sessions, socio-technical analysis, dual language impl |
| 17 | 2.5 | [RaheesAhmed/code-context-mcp](https://github.com/RaheesAhmed/code-context-mcp) | 0 | Python | MIT | Security pattern detection, auto architecture diagrams, code flow tracing |
| 18 | 2.4 | [shantham/codegraph](https://github.com/shantham/codegraph) | 0 | TypeScript | MIT | Polished `npx` one-command installer, sqlite-vss, 7 MCP tools |
| 19 | 2.3 | [0xd219b/codegraph](https://github.com/0xd219b/codegraph) | 0 | Rust | None | Pure Rust, HTTP server mode, Java + Go support |
| 20 | 2.1 | [floydw1234/badger-graph](https://github.com/floydw1234/badger-graph) | 0 | Python | None | Dgraph backend (Docker), C struct field access tracking |
| 21 | 2.0 | [khushil/code-graph-rag](https://github.com/khushil/code-graph-rag) | 0 | Python | MIT | Fork of vitali87/code-graph-rag with no modifications |
| 22 | 1.8 | [m3et/CodeRAG](https://github.com/m3et/CodeRAG) | 0 | Python | None | Iterative RAG with self-reflection, ChromaDB, Azure OpenAI dependent |

---

## Scoring Breakdown

| # | Project | Features | Analysis Depth | Deploy Simplicity | Lang Support | Code Quality | Community |
|---|---------|----------|---------------|-------------------|-------------|-------------|-----------|
| 1 | code-graph-rag | 5 | 4 | 3 | 4 | 4 | 5 |
| 2 | glimpse | 4 | 4 | 5 | 3 | 5 | 5 |
| 3 | CKB | 5 | 5 | 4 | 3 | 4 | 3 |
| 4 | axon | 5 | 5 | 4 | 2 | 4 | 2 |
| 5 | autodev-codebase | 5 | 3 | 3 | 5 | 3 | 4 |
| 6 | arbor | 4 | 4 | 5 | 4 | 5 | 3 |
| **7** | **codegraph (us)** | **3** | **3** | **5** | **4** | **4** | **2** |
| 8 | Claude-code-memory | 4 | 3 | 3 | 3 | 4 | 3 |
| 9 | codexray | 5 | 4 | 4 | 4 | 3 | 1 |
| 10 | codegraph-cli | 5 | 3 | 3 | 2 | 3 | 2 |
| 11 | claude-context-local | 4 | 3 | 3 | 4 | 4 | 1 |
| 12 | loregrep | 3 | 3 | 4 | 3 | 5 | 2 |
| 13 | CodeInteliMCP | 3 | 3 | 4 | 3 | 3 | 1 |
| 14 | Bikach/codeGraph | 3 | 3 | 3 | 2 | 3 | 1 |
| 15 | repo-graphrag-mcp | 3 | 3 | 3 | 4 | 3 | 1 |
| 16 | MCP_CodeAnalysis | 4 | 3 | 3 | 2 | 3 | 1 |
| 17 | code-context-mcp | 4 | 2 | 3 | 2 | 2 | 1 |
| 18 | shantham/codegraph | 3 | 2 | 4 | 4 | 3 | 1 |
| 19 | 0xd219b/codegraph | 2 | 3 | 4 | 1 | 4 | 1 |
| 20 | badger-graph | 2 | 2 | 2 | 1 | 2 | 1 |
| 21 | khushil/code-graph-rag | 5 | 4 | 3 | 4 | 4 | 1 |
| 22 | CodeRAG | 3 | 2 | 2 | 1 | 2 | 1 |

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
| **Zero-dependency deployment** | `npm install` and done. No Docker, no cloud, no API keys needed. Most competitors require Docker (Memgraph, Neo4j, Dgraph, Qdrant) or cloud APIs |
| **Dual engine architecture** | Only project with native Rust (napi-rs) + automatic WASM fallback. Others are pure Rust OR pure JS/Python — never both |
| **Single-repo MCP isolation** | Security-conscious default: tools have no `repo` property unless `--multi-repo` is explicitly enabled. Most competitors default to exposing everything |
| **Incremental builds** | File-hash-based skip of unchanged files. Some competitors re-index everything |
| **Platform binaries** | Published `@optave/codegraph-{platform}-{arch}` optional packages — true npm-native distribution |
| **Import resolution depth** | 6-level priority system with confidence scoring — more sophisticated than most competitors' resolution |

---

## Where Codegraph Loses

### vs code-graph-rag (#1, 1916 stars)
- **Graph query expressiveness**: Memgraph + Cypher enables arbitrary graph traversals; our SQL queries are more rigid
- **AI-powered code editing**: they can surgically edit functions via AST targeting with visual diffs
- **Provider flexibility**: they support Gemini/OpenAI/Claude/Ollama and can mix providers per task
- **Community**: 1,916 stars — orders of magnitude more traction

### vs glimpse (#2, 349 stars)
- **LLM workflow optimization**: clipboard-first output + token counting + XML output mode — purpose-built for "code → LLM context"
- **LSP-based call resolution**: compiler-grade accuracy vs our tree-sitter heuristic approach
- **Web content processing**: can fetch URLs and convert HTML to markdown for context

### vs CKB (#3, 59 stars)
- **Indexing accuracy**: SCIP provides compiler-grade cross-file references (type-aware), fundamentally more accurate than tree-sitter for supported languages
- **Compound operations**: `explore`/`understand`/`prepareChange` batch multiple queries into one call — 83% token reduction, 60-70% fewer tool calls
- **CODEOWNERS + secret scanning**: enterprise features we lack entirely

### vs axon (#4, 29 stars)
- **Analysis depth**: their 11-phase pipeline includes community detection (Leiden), execution flow tracing, git change coupling, dead code detection — all features we lack
- **Graph database**: KuzuDB with native Cypher is more expressive for complex graph queries than our SQLite
- **Branch structural diff**: compares code structure between branches using git worktrees

### vs autodev-codebase (#5, 111 stars)
- **Language breadth**: 40+ languages vs our 11
- **Interactive visualization**: Cytoscape.js call graph explorer in the browser — we only have static DOT/Mermaid
- **LLM reranking**: secondary LLM pass to improve search relevance — more sophisticated retrieval pipeline

### vs arbor (#6, 85 stars)
- **Native GUI**: desktop app for interactive impact analysis (we're CLI/MCP only)
- **Confidence scoring surfaced to users**: every result shows High/Medium/Low confidence
- **Architectural role classification**: auto-tags symbols as Entry Point / Core Logic / Utility / Adapter
- **Fuzzy symbol search**: typo tolerance with Jaro-Winkler matching

---

## Features to Adopt — Priority Roadmap

### Tier 1: High impact, low effort
| Feature | Inspired by | Why |
|---------|------------|-----|
| **Dead code detection** | axon, codexray, CKB | We have the graph — find nodes with zero incoming edges (minus entry points/exports). Agents constantly ask "is this used?" |
| **Fuzzy symbol search** | arbor | Add Levenshtein/Jaro-Winkler to `fn` command. Currently requires exact match |
| **Expose confidence scores** | arbor | Already computed internally in import resolution — just surface them |
| **Shortest path A→B** | codexray, arbor | BFS on existing edges table. We have `fn` for single chains but no A→B pathfinding |

### Tier 2: High impact, medium effort
| Feature | Inspired by | Why |
|---------|------------|-----|
| **Compound MCP tools** | CKB | `explore`/`understand` meta-tools that batch deps + fn + map into single responses. Biggest token-savings opportunity |
| **Token counting on responses** | glimpse, arbor | tiktoken-based counts so agents know context budget consumed |
| **Node classification** | arbor | Auto-tag Entry Point / Core / Utility / Adapter from in-degree/out-degree patterns |
| **TF-IDF lightweight search** | codexray | SQLite FTS5 + TF-IDF as a middle tier (~50MB) between "no search" and full transformers (~500MB) |

### Tier 3: High impact, high effort
| Feature | Inspired by | Why |
|---------|------------|-----|
| **Interactive HTML visualization** | autodev-codebase, codegraph-cli | `codegraph viz` → opens interactive vis.js/Cytoscape.js graph in browser |
| **Git change coupling** | axon | Analyze git history for files that always change together — enhances `diff-impact` |
| **Community detection** | axon | Leiden algorithm to discover natural module boundaries vs actual file organization |
| **Execution flow tracing** | axon, code-context-mcp | Framework-aware entry point detection + BFS flow tracing |
| **Security pattern scanning** | CKB, code-context-mcp | Detect hardcoded secrets, SQL injection patterns, XSS in parsed code |

### Not worth copying
| Feature | Why skip |
|---------|----------|
| Memgraph/Neo4j/KuzuDB | Our SQLite = zero Docker, simpler deployment. Query gap matters less than simplicity |
| Multi-provider AI | We're deliberately cloud-free — that's a feature, not a limitation |
| SCIP indexing | Would require maintaining SCIP toolchains per language. Tree-sitter + native Rust is the right bet |
| CrewAI multi-agent | Overengineered for a code analysis tool. Keep the scope focused |
| Clipboard/LLM-dump mode | Different product category (glimpse). We're a graph tool, not a context-packer |

---

## Irrelevant Repos (excluded from ranking)

These repos from the initial list were not code analysis / graph tools:

| Repo | What it actually is |
|------|-------------------|
| [susliko/tla.nvim](https://github.com/susliko/tla.nvim) | TLA+/PlusCal Neovim plugin for formal verification |
| [akaash-nigam/AxionApps](https://github.com/akaash-nigam/AxionApps) | Portfolio of 17 Indian social impact mobile apps |
| [jasonjckn/tree-sitter-clojure](https://github.com/jasonjckn/tree-sitter-clojure) | Fork of Clojure tree-sitter grammar, inactive since 2022 |
| [omkargade04/sentinel-agent](https://github.com/omkargade04/sentinel-agent) | AI-powered GitHub PR reviewer agent |
| [rupurt/tree-sitter-graph-nix](https://github.com/rupurt/tree-sitter-graph-nix) | Nix flake packaging for tree-sitter-graph (1.8KB of Nix) |
| [shandianchengzi/tree_sitter_DataExtractor](https://github.com/shandianchengzi/tree_sitter_DataExtractor) | Academic research on program graph representations for GNNs |
| [hasssanezzz/GoTypeGraph](https://github.com/hasssanezzz/GoTypeGraph) | Go-only struct/interface relationship visualizer |
| [romiras/py-cmm-parser](https://github.com/romiras/py-cmm-parser) | Python-only canonical metadata parser with Pyright LSP |
| [OrkeeAI/orkee](https://github.com/OrkeeAI/orkee) | AI agent orchestration platform (CLI/TUI/Web/Desktop) — adjacent but different category |
