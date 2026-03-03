<p align="center">
  <img src="https://img.shields.io/badge/codegraph-dependency%20intelligence-blue?style=for-the-badge&logo=graphql&logoColor=white" alt="codegraph" />
</p>

<h1 align="center">codegraph</h1>

<p align="center">
  <strong>Give your AI the map before it starts exploring.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@optave/codegraph"><img src="https://img.shields.io/npm/v/@optave/codegraph?style=flat-square&logo=npm&logoColor=white&label=npm" alt="npm version" /></a>
  <a href="https://github.com/optave/codegraph/blob/main/LICENSE"><img src="https://img.shields.io/github/license/optave/codegraph?style=flat-square&logo=opensourceinitiative&logoColor=white" alt="Apache-2.0 License" /></a>
  <a href="https://github.com/optave/codegraph/actions"><img src="https://img.shields.io/github/actions/workflow/status/optave/codegraph/codegraph-impact.yml?style=flat-square&logo=githubactions&logoColor=white&label=CI" alt="CI" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node >= 20" />
</p>

<p align="center">
  <a href="#the-problem">The Problem</a> &middot;
  <a href="#what-codegraph-does">What It Does</a> &middot;
  <a href="#-quick-start">Quick Start</a> &middot;
  <a href="#-commands">Commands</a> &middot;
  <a href="#-language-support">Languages</a> &middot;
  <a href="#-ai-agent-integration">AI Integration</a> &middot;
  <a href="#-how-it-works">How It Works</a> &middot;
  <a href="#-recommended-practices">Practices</a> &middot;
  <a href="#-roadmap">Roadmap</a>
</p>

---

## The Problem

Large codebases are opaque. The structure lives in people's heads, not in tools.

A developer inherits a project and spends days grepping to understand what calls what. An AI agent burns half its token budget on `grep`, `find`, `cat` — re-discovering the same structure every session. An architect draws boundary rules on a whiteboard that erode within weeks because nothing enforces them. A CI pipeline catches test failures but can't tell you _"this change silently affects 14 callers across 9 files."_

The information exists — it's in the code itself. But without a structured map, everyone is navigating blind: developers guess, AI agents hallucinate, and architecture degrades one unreviewed change at a time.

## What Codegraph Does

Codegraph builds a function-level dependency graph of your entire codebase — every function, every caller, every dependency — and keeps it current with sub-second incremental rebuilds.

It parses your code with [tree-sitter](https://tree-sitter.github.io/) (native Rust or WASM), stores the graph in SQLite, and gives you multiple ways to consume it:

- **CLI** — developers explore, query, and audit their code from the terminal
- **MCP server** — AI agents query the graph directly through 30 tools
- **CI gates** — `check` and `manifesto` commands enforce quality thresholds with exit codes
- **Programmatic API** — embed codegraph in your own tools via `npm install`

Instead of 30 tool calls to maybe discover half your dependencies, you get _"this function has 14 callers across 9 files"_ instantly. Instead of hoping architecture rules are followed, you enforce them. Instead of finding breakage in production, `diff-impact --staged` catches it before you commit.

**Free. Open source. Fully local.** Zero network calls, zero telemetry. Your code stays on your machine. When you want deeper intelligence, bring your own LLM provider — your code only goes where you choose to send it.

**Three commands to get started:**

```bash
npm install -g @optave/codegraph
cd your-project
codegraph build
```

That's it. No config files, no Docker, no JVM, no API keys, no accounts. The graph is ready to query.

### Why it matters

| | Without codegraph | With codegraph |
|---|---|---|
| **AI agents** | Spend 20+ tool calls per session re-discovering code structure | Get full dependency context in one MCP call |
| **AI agents** | Modify `parseConfig()` without knowing 9 files import it | `fn-impact parseConfig` shows every caller before the edit |
| **Developers** | Inherit a codebase and grep for hours to understand what calls what | `context handleAuth -T` gives source, deps, callers, and tests in one command |
| **Developers** | Rename a function, break 14 call sites silently | `diff-impact --staged` catches breakage before you commit |
| **CI pipelines** | Catch test failures but miss structural degradation | `check --staged` fails the build when blast radius or complexity thresholds are exceeded |
| **Architects** | Draw boundary rules that erode within weeks | `manifesto` and `boundaries` enforce architecture rules on every commit |

### Feature comparison

<sub>Comparison last verified: March 2026. Full analysis: <a href="generated/competitive/COMPETITIVE_ANALYSIS.md">COMPETITIVE_ANALYSIS.md</a></sub>

| Capability | codegraph | [joern](https://github.com/joernio/joern) | [narsil-mcp](https://github.com/postrv/narsil-mcp) | [code-graph-rag](https://github.com/vitali87/code-graph-rag) | [cpg](https://github.com/Fraunhofer-AISEC/cpg) | [GitNexus](https://github.com/abhigyanpatwari/GitNexus) | [CodeMCP](https://github.com/SimplyLiz/CodeMCP) | [axon](https://github.com/harshkedia177/axon) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Function-level analysis | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** |
| Multi-language | **11** | **14** | **32** | **11** | **~10** | **12** | **12** | **3** |
| Semantic search | **Yes** | — | **Yes** | **Yes** | — | **Yes** | — | **Yes** |
| Hybrid BM25 + semantic | **Yes** | — | — | — | — | **Yes** | — | **Yes** |
| CODEOWNERS integration | **Yes** | — | — | — | — | — | — | — |
| Architecture boundary rules | **Yes** | — | — | — | — | — | — | — |
| CI validation predicates | **Yes** | — | — | — | — | — | — | — |
| Composite audit command | **Yes** | — | — | — | — | — | — | — |
| Batch querying | **Yes** | — | — | — | — | — | — | — |
| Graph snapshots | **Yes** | — | — | — | — | — | — | — |
| MCP / AI agent support | **Yes** | — | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** |
| Git diff impact | **Yes** | — | — | — | — | **Yes** | **Yes** | **Yes** |
| Branch structural diff | **Yes** | — | — | — | — | — | — | **Yes** |
| Git co-change analysis | **Yes** | — | — | — | — | — | — | **Yes** |
| Watch mode | **Yes** | — | **Yes** | **Yes** | — | — | **Yes** | **Yes** |
| Dead code / role classification | **Yes** | — | **Yes** | — | — | — | **Yes** | **Yes** |
| Cycle detection | **Yes** | — | — | — | — | — | — | — |
| Incremental rebuilds | **O(changed)** | — | O(n) Merkle | — | — | — | Go only | **Yes** |
| Zero config | **Yes** | — | **Yes** | — | — | **Yes** | — | **Yes** |
| Embeddable JS library (`npm install`) | **Yes** | — | — | — | — | — | — | — |
| LLM-optional (works without API keys) | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** |
| Dataflow analysis | **Yes** | **Yes** | — | — | **Yes** | — | — | — |
| Control flow graph (CFG) | **Yes** | **Yes** | — | — | **Yes** | — | — | — |
| AST node querying | **Yes** | **Yes** | — | — | **Yes** | — | — | — |
| Expanded node/edge types | **Yes** | **Yes** | — | — | **Yes** | — | — | — |
| GraphML / Neo4j export | **Yes** | **Yes** | — | — | — | — | — | — |
| Interactive graph viewer | **Yes** | — | — | — | — | — | — | — |
| Commercial use allowed | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | No | Paid | **Yes** |
| Open source | **Yes** | Yes | Yes | Yes | Yes | No | No | Yes |

### What makes codegraph different

| | Differentiator | In practice |
|---|---|---|
| **⚡** | **Always-fresh graph** | Three-tier change detection: journal (O(changed)) → mtime+size (O(n) stats) → hash (O(changed) reads). Sub-second rebuilds even on large codebases |
| **🔓** | **Zero-cost core, LLM-enhanced when you want** | Full graph analysis with no API keys, no accounts, no cost. Optionally bring your own LLM provider — your code only goes where you choose |
| **🔬** | **Function-level, not just files** | Traces `handleAuth()` → `validateToken()` → `decryptJWT()` and shows 14 callers across 9 files break if `decryptJWT` changes |
| **🏷️** | **Role classification** | Every symbol auto-tagged as `entry`/`core`/`utility`/`adapter`/`dead`/`leaf` — agents instantly know what they're looking at |
| **🤖** | **Built for AI agents** | 30-tool [MCP server](https://modelcontextprotocol.io/) — AI assistants query your graph directly. Single-repo by default |
| **🌐** | **Multi-language, one CLI** | JS/TS + Python + Go + Rust + Java + C# + PHP + Ruby + HCL in a single graph |
| **💥** | **Git diff impact** | `codegraph diff-impact` shows changed functions, their callers, and full blast radius — enriched with historically coupled files from git co-change analysis. Ships with a GitHub Actions workflow |
| **🧠** | **Hybrid search** | BM25 keyword + semantic embeddings fused via RRF — `hybrid` (default), `semantic`, or `keyword` mode; multi-query via `"auth; token; JWT"` |
| **🔬** | **Dataflow + CFG** | Track how data flows through functions (`flows_to`, `returns`, `mutates`) and visualize intraprocedural control flow graphs for all 11 languages |

---

## 🚀 Quick Start

```bash
# Install
npm install -g @optave/codegraph

# Build a graph for any project
cd your-project
codegraph build        # → .codegraph/graph.db created

# Start exploring
codegraph map          # see most-connected files
codegraph query myFunc # find any function, see callers & callees
codegraph deps src/index.ts  # file-level import/export map
```

Or install from source:

```bash
git clone https://github.com/optave/codegraph.git
cd codegraph && npm install && npm link
```

> **Dev builds:** Pre-release tarballs are attached to [GitHub Releases](https://github.com/optave/codegraph/releases). Install with `npm install -g <path-to-tarball>`. Note that `npm install -g <tarball-url>` does not work because npm cannot resolve optional platform-specific dependencies from a URL — download the `.tgz` first, then install from the local file.

### For AI agents

Add codegraph to your agent's instructions (e.g. `CLAUDE.md`):

```markdown
Before modifying code, always:
1. `codegraph where <name>` — find where the symbol lives
2. `codegraph context <name> -T` — get full context (source, deps, callers)
3. `codegraph fn-impact <name> -T` — check blast radius before editing

After modifying code:
4. `codegraph diff-impact --staged -T` — verify impact before committing
```

Or connect directly via MCP:

```bash
codegraph mcp          # 30-tool MCP server — AI queries the graph directly
```

Full agent setup: [AI Agent Guide](docs/guides/ai-agent-guide.md) &middot; [CLAUDE.md template](docs/guides/ai-agent-guide.md#claudemd-template)

---

## ✨ Features

| | Feature | Description |
|---|---|---|
| 🔍 | **Symbol search** | Find any function, class, or method by name — exact match priority, relevance scoring, `--file` and `--kind` filters |
| 📁 | **File dependencies** | See what a file imports and what imports it |
| 💥 | **Impact analysis** | Trace every file affected by a change (transitive) |
| 🧬 | **Function-level tracing** | Call chains, caller trees, function-level impact, and A→B pathfinding with qualified call resolution |
| 🎯 | **Deep context** | `context` gives AI agents source, deps, callers, signature, and tests for a function in one call; `audit --quick` gives structural summaries of files or functions |
| 📍 | **Fast lookup** | `where` shows exactly where a symbol is defined and used — minimal, fast |
| 📊 | **Diff impact** | Parse `git diff`, find overlapping functions, trace their callers |
| 🔗 | **Co-change analysis** | Analyze git history for files that always change together — surfaces hidden coupling the static graph can't see; enriches `diff-impact` with historically coupled files |
| 🗺️ | **Module map** | Bird's-eye view of your most-connected files |
| 🏗️ | **Structure & hotspots** | Directory cohesion scores, fan-in/fan-out hotspot detection, module boundaries |
| 🏷️ | **Node role classification** | Every symbol auto-tagged as `entry`/`core`/`utility`/`adapter`/`dead`/`leaf` based on connectivity patterns — agents instantly know architectural role |
| 🔄 | **Cycle detection** | Find circular dependencies at file or function level |
| 📤 | **Export** | DOT, Mermaid, JSON, GraphML, GraphSON, and Neo4j CSV graph export |
| 🧠 | **Semantic search** | Embeddings-powered natural language search with multi-query RRF ranking |
| 👀 | **Watch mode** | Incrementally update the graph as files change |
| 🤖 | **MCP server** | 30-tool MCP server for AI assistants; single-repo by default, opt-in multi-repo |
| ⚡ | **Always fresh** | Three-tier incremental detection — sub-second rebuilds even on large codebases |
| 🧮 | **Complexity metrics** | Cognitive, cyclomatic, nesting depth, Halstead, and Maintainability Index per function |
| 🏘️ | **Community detection** | Louvain clustering to discover natural module boundaries and architectural drift |
| 📜 | **Manifesto rule engine** | Configurable pass/fail rules with warn/fail thresholds for CI gates via `check` (exit code 1 on fail) |
| 👥 | **CODEOWNERS integration** | Map graph nodes to CODEOWNERS entries — see who owns each function, ownership boundaries in `diff-impact` |
| 💾 | **Graph snapshots** | `snapshot save`/`restore` for instant DB backup and rollback — checkpoint before refactoring, restore without rebuilding |
| 🔎 | **Hybrid BM25 + semantic search** | FTS5 keyword search + embedding-based semantic search fused via Reciprocal Rank Fusion — `hybrid`, `semantic`, or `keyword` modes |
| 📄 | **Pagination & NDJSON streaming** | Universal `--limit`/`--offset` pagination on all MCP tools and CLI commands; `--ndjson` for newline-delimited JSON streaming |
| 🔀 | **Branch structural diff** | Compare code structure between two git refs — added/removed/changed symbols with transitive caller impact |
| 🛡️ | **Architecture boundaries** | User-defined dependency rules between modules with onion architecture preset — violations flagged in manifesto and CI |
| ✅ | **CI validation predicates** | `check` command with configurable gates: complexity, blast radius, cycles, boundary violations — exit code 0/1 for CI |
| 📋 | **Composite audit** | Single `audit` command combining explain + impact + health metrics per function — one call instead of 3-4 |
| 🚦 | **Triage queue** | `triage` merges connectivity, hotspots, roles, and complexity into a ranked audit priority queue |
| 📦 | **Batch querying** | Accept a list of targets and return all results in one JSON payload — enables multi-agent parallel dispatch |
| 🔬 | **Dataflow analysis** | Track how data moves through functions with `flows_to`, `returns`, and `mutates` edges — opt-in via `build --dataflow` (JS/TS) |
| 🧩 | **Control flow graph** | Intraprocedural CFG construction for all 11 languages — `cfg` command with text/DOT/Mermaid output, opt-in via `build --cfg` |
| 🔎 | **AST node querying** | Stored queryable AST nodes (calls, `new`, string, regex, throw, await) — `ast` command with SQL GLOB pattern matching |
| 🧬 | **Expanded node/edge types** | `parameter`, `property`, `constant` node kinds with `parent_id` for sub-declaration queries; `contains`, `parameter_of`, `receiver` edge kinds |
| 📊 | **Exports analysis** | `exports <file>` shows all exported symbols with per-symbol consumers, re-export detection, and counts |
| 📈 | **Interactive viewer** | `codegraph plot` generates an interactive HTML graph viewer with hierarchical/force/radial layouts, complexity overlays, and drill-down |
| 🏷️ | **Stable JSON schema** | `normalizeSymbol` utility ensures consistent 7-field output (name, kind, file, line, endLine, role, fileHash) across all commands |

See [docs/examples](docs/examples) for real-world CLI and MCP usage examples.

## 📦 Commands

### Build & Watch

```bash
codegraph build [dir]          # Parse and build the dependency graph
codegraph build --no-incremental  # Force full rebuild
codegraph build --engine wasm  # Force WASM engine (skip native)
codegraph watch [dir]          # Watch for changes, update graph incrementally
```

### Query & Explore

```bash
codegraph query <name>         # Find a symbol — shows callers and callees
codegraph deps <file>          # File imports/exports
codegraph map                  # Top 20 most-connected files
codegraph map -n 50 --no-tests # Top 50, excluding test files
codegraph where <name>         # Where is a symbol defined and used?
codegraph where --file src/db.js  # List symbols, imports, exports for a file
codegraph stats                # Graph health: nodes, edges, languages, quality score
codegraph roles                # Node role classification (entry, core, utility, adapter, dead, leaf)
codegraph roles --role dead -T # Find dead code (unreferenced, non-exported symbols)
codegraph roles --role core --file src/  # Core symbols in src/
codegraph exports src/queries.js  # Per-symbol consumer analysis (who calls each export)
codegraph children <name>         # List parameters, properties, constants of a symbol
```

### Deep Context (AI-Optimized)

```bash
codegraph context <name>       # Full context: source, deps, callers, signature, tests
codegraph context <name> --depth 2 --no-tests  # Include callee source 2 levels deep
codegraph audit <file> --quick    # Structural summary: public API, internals, data flow
codegraph audit <function> --quick  # Function summary: signature, calls, callers, tests
```

### Impact Analysis

```bash
codegraph impact <file>        # Transitive reverse dependency trace
codegraph query <name>         # Function-level: callers, callees, call chain
codegraph query <name> --no-tests --depth 5
codegraph fn-impact <name>     # What functions break if this one changes
codegraph path <from> <to>            # Shortest path between two symbols (A calls...calls B)
codegraph path <from> <to> --reverse  # Follow edges backward
codegraph path <from> <to> --depth 5 --kinds calls,imports
codegraph diff-impact          # Impact of unstaged git changes
codegraph diff-impact --staged # Impact of staged changes
codegraph diff-impact HEAD~3   # Impact vs a specific ref
codegraph diff-impact main --format mermaid -T  # Mermaid flowchart of blast radius
codegraph branch-compare main feature-branch    # Structural diff between two refs
codegraph branch-compare main HEAD --no-tests   # Symbols added/removed/changed vs main
codegraph branch-compare v2.4.0 v2.5.0 --json   # JSON output for programmatic use
codegraph branch-compare main HEAD --format mermaid  # Mermaid diagram of structural changes
```

### Co-Change Analysis

Analyze git history to find files that always change together — surfaces hidden coupling the static graph can't see. Requires a git repository.

```bash
codegraph co-change --analyze          # Scan git history and populate co-change data
codegraph co-change src/queries.js     # Show co-change partners for a file
codegraph co-change                    # Show top co-changing file pairs globally
codegraph co-change --since 6m         # Limit to last 6 months of history
codegraph co-change --min-jaccard 0.5  # Only show strong coupling (Jaccard >= 0.5)
codegraph co-change --min-support 5    # Minimum co-commit count
codegraph co-change --full             # Include all details
```

Co-change data also enriches `diff-impact` — historically coupled files appear in a `historicallyCoupled` section alongside the static dependency analysis.

### Structure & Hotspots

```bash
codegraph structure            # Directory overview with cohesion scores
codegraph triage --level file  # Files with extreme fan-in, fan-out, or density
codegraph triage --level directory --sort coupling --no-tests
```

### Code Health & Architecture

```bash
codegraph complexity              # Per-function cognitive, cyclomatic, nesting, MI
codegraph complexity --health -T  # Full Halstead health view (volume, effort, bugs, MI)
codegraph complexity --sort mi -T # Sort by worst maintainability index
codegraph complexity --above-threshold -T  # Only functions exceeding warn thresholds
codegraph communities             # Louvain community detection — natural module boundaries
codegraph communities --drift -T  # Drift analysis only — split/merge candidates
codegraph communities --functions # Function-level community detection
codegraph check                   # Pass/fail rule engine (exit code 1 on fail)
codegraph check -T                # Exclude test files from rule evaluation
```

### Dataflow, CFG & AST

```bash
codegraph dataflow <name>             # Data flow edges for a function (flows_to, returns, mutates)
codegraph dataflow <name> --impact    # Transitive data-dependent blast radius
codegraph cfg <name>                  # Control flow graph (text format)
codegraph cfg <name> --format dot     # CFG as Graphviz DOT
codegraph cfg <name> --format mermaid # CFG as Mermaid diagram
codegraph ast                         # List all stored AST nodes
codegraph ast "handleAuth"            # Search AST nodes by pattern (GLOB)
codegraph ast -k call                 # Filter by kind: call, new, string, regex, throw, await
codegraph ast -k throw --file src/    # Combine kind and file filters
```

> **Note:** Dataflow requires `codegraph build --dataflow` (JS/TS only). CFG requires `codegraph build --cfg`. Both are opt-in to keep default builds fast.

### Audit, Triage & Batch

Composite commands for risk-driven workflows and multi-agent dispatch.

```bash
codegraph audit <file-or-function>    # Combined structural summary + impact + health in one report
codegraph audit <target> --quick      # Structural summary only (skip impact and health)
codegraph audit src/queries.js -T     # Audit all functions in a file
codegraph triage                      # Ranked audit priority queue (connectivity + hotspots + roles)
codegraph triage -T --limit 20        # Top 20 riskiest functions, excluding tests
codegraph triage --level file -T      # File-level hotspot analysis
codegraph triage --level directory -T # Directory-level hotspot analysis
codegraph batch target1 target2 ...   # Batch query multiple targets in one call
codegraph batch --json targets.json   # Batch from a JSON file
```

### CI Validation

`codegraph check` provides configurable pass/fail predicates for CI gates and state machines. Exit code 0 = pass, 1 = fail.

```bash
codegraph check                             # Run manifesto rules on whole codebase
codegraph check --staged                    # Check staged changes (diff predicates)
codegraph check --staged --rules            # Run both diff predicates AND manifesto rules
codegraph check --no-new-cycles             # Fail if staged changes introduce cycles
codegraph check --max-complexity 30         # Fail if any function exceeds complexity threshold
codegraph check --max-blast-radius 50       # Fail if blast radius exceeds limit
codegraph check --no-boundary-violations    # Fail on architecture boundary violations
codegraph check main                        # Check current branch vs main
```

### CODEOWNERS

Map graph symbols to CODEOWNERS entries. Shows who owns each function and surfaces ownership boundaries.

```bash
codegraph owners                   # Show ownership for all symbols
codegraph owners src/queries.js    # Ownership for symbols in a specific file
codegraph owners --boundary        # Show ownership boundaries between modules
codegraph owners --owner @backend  # Filter by owner
```

Ownership data also enriches `diff-impact` — affected owners and suggested reviewers appear alongside the static dependency analysis.

### Snapshots

Lightweight SQLite DB backup and restore — checkpoint before refactoring, instantly rollback without rebuilding.

```bash
codegraph snapshot save before-refactor   # Save a named snapshot
codegraph snapshot list                   # List all snapshots
codegraph snapshot restore before-refactor  # Restore a snapshot
codegraph snapshot delete before-refactor   # Delete a snapshot
```

### Export & Visualization

```bash
codegraph export -f dot        # Graphviz DOT format
codegraph export -f mermaid    # Mermaid diagram
codegraph export -f json       # JSON graph
codegraph export -f graphml    # GraphML (XML standard)
codegraph export -f graphson   # GraphSON (TinkerPop v3 / Gremlin)
codegraph export -f neo4j      # Neo4j CSV (bulk import, separate nodes/relationships files)
codegraph export --functions -o graph.dot  # Function-level, write to file
codegraph plot                 # Interactive HTML viewer with force/hierarchical/radial layouts
codegraph cycles               # Detect circular dependencies
codegraph cycles --functions   # Function-level cycles
```

### Semantic Search

Local embeddings for every function, method, and class — search by natural language. Everything runs locally using [@huggingface/transformers](https://huggingface.co/docs/transformers.js) — no API keys needed.

```bash
codegraph embed                # Build embeddings (default: nomic-v1.5)
codegraph embed --model nomic  # Use a different model
codegraph search "handle authentication"
codegraph search "parse config" --min-score 0.4 -n 10
codegraph search "parseConfig" --mode keyword   # BM25 keyword-only (exact names)
codegraph search "auth flow" --mode semantic    # Embedding-only (conceptual)
codegraph search "auth flow" --mode hybrid      # BM25 + semantic RRF fusion (default)
codegraph models               # List available models
```

#### Multi-query search

Separate queries with `;` to search from multiple angles at once. Results are ranked using [Reciprocal Rank Fusion (RRF)](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) — items that rank highly across multiple queries rise to the top.

```bash
codegraph search "auth middleware; JWT validation"
codegraph search "parse config; read settings; load env" -n 20
codegraph search "error handling; retry logic" --kind function
codegraph search "database connection; query builder" --rrf-k 30
```

A single trailing semicolon is ignored (falls back to single-query mode). The `--rrf-k` flag controls the RRF smoothing constant (default 60) — lower values give more weight to top-ranked results.

#### Available Models

| Flag | Model | Dimensions | Size | License | Notes |
|---|---|---|---|---|---|
| `minilm` | all-MiniLM-L6-v2 | 384 | ~23 MB | Apache-2.0 | Fastest, good for quick iteration |
| `jina-small` | jina-embeddings-v2-small-en | 512 | ~33 MB | Apache-2.0 | Better quality, still small |
| `jina-base` | jina-embeddings-v2-base-en | 768 | ~137 MB | Apache-2.0 | High quality, 8192 token context |
| `jina-code` | jina-embeddings-v2-base-code | 768 | ~137 MB | Apache-2.0 | Best for code search, trained on code+text (requires HF token) |
| `nomic` | nomic-embed-text-v1 | 768 | ~137 MB | Apache-2.0 | Good quality, 8192 context |
| `nomic-v1.5` (default) | nomic-embed-text-v1.5 | 768 | ~137 MB | Apache-2.0 | **Improved nomic, Matryoshka dimensions** |
| `bge-large` | bge-large-en-v1.5 | 1024 | ~335 MB | MIT | Best general retrieval, top MTEB scores |

The model used during `embed` is stored in the database, so `search` auto-detects it — no need to pass `--model` when searching.

### Multi-Repo Registry

Manage a global registry of codegraph-enabled projects. The registry stores paths to your built graphs so the MCP server can query them when multi-repo mode is enabled.

```bash
codegraph registry list        # List all registered repos
codegraph registry list --json # JSON output
codegraph registry add <dir>   # Register a project directory
codegraph registry add <dir> -n my-name  # Custom name
codegraph registry remove <name>  # Unregister
```

`codegraph build` auto-registers the project — no manual setup needed.

### Common Flags

| Flag | Description |
|---|---|
| `-d, --db <path>` | Custom path to `graph.db` |
| `-T, --no-tests` | Exclude `.test.`, `.spec.`, `__test__` files (available on most query commands including `query`, `fn-impact`, `path`, `context`, `where`, `diff-impact`, `search`, `map`, `roles`, `co-change`, `deps`, `impact`, `complexity`, `communities`, `branch-compare`, `audit`, `triage`, `check`, `dataflow`, `cfg`, `ast`, `exports`, `children`) |
| `--depth <n>` | Transitive trace depth (default varies by command) |
| `-j, --json` | Output as JSON |
| `-v, --verbose` | Enable debug output |
| `--engine <engine>` | Parser engine: `native`, `wasm`, or `auto` (default: `auto`) |
| `-k, --kind <kind>` | Filter by kind: `function`, `method`, `class`, `interface`, `type`, `struct`, `enum`, `trait`, `record`, `module`, `parameter`, `property`, `constant` |
| `-f, --file <path>` | Scope to a specific file (`fn`, `context`, `where`) |
| `--mode <mode>` | Search mode: `hybrid` (default), `semantic`, or `keyword` (`search`) |
| `--ndjson` | Output as newline-delimited JSON (one object per line) |
| `--limit <n>` | Limit number of results |
| `--offset <n>` | Skip first N results (pagination) |
| `--rrf-k <n>` | RRF smoothing constant for multi-query search (default 60) |

## 🌐 Language Support

| Language | Extensions | Coverage |
|---|---|---|
| ![JavaScript](https://img.shields.io/badge/-JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black) | `.js`, `.jsx`, `.mjs`, `.cjs` | Full — functions, classes, imports, call sites |
| ![TypeScript](https://img.shields.io/badge/-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white) | `.ts`, `.tsx` | Full — interfaces, type aliases, `.d.ts` |
| ![Python](https://img.shields.io/badge/-Python-3776AB?style=flat-square&logo=python&logoColor=white) | `.py` | Functions, classes, methods, imports, decorators |
| ![Go](https://img.shields.io/badge/-Go-00ADD8?style=flat-square&logo=go&logoColor=white) | `.go` | Functions, methods, structs, interfaces, imports, call sites |
| ![Rust](https://img.shields.io/badge/-Rust-000000?style=flat-square&logo=rust&logoColor=white) | `.rs` | Functions, methods, structs, traits, `use` imports, call sites |
| ![Java](https://img.shields.io/badge/-Java-ED8B00?style=flat-square&logo=openjdk&logoColor=white) | `.java` | Classes, methods, constructors, interfaces, imports, call sites |
| ![C#](https://img.shields.io/badge/-C%23-512BD4?style=flat-square&logo=dotnet&logoColor=white) | `.cs` | Classes, structs, records, interfaces, enums, methods, constructors, using directives, invocations |
| ![PHP](https://img.shields.io/badge/-PHP-777BB4?style=flat-square&logo=php&logoColor=white) | `.php` | Functions, classes, interfaces, traits, enums, methods, namespace use, calls |
| ![Ruby](https://img.shields.io/badge/-Ruby-CC342D?style=flat-square&logo=ruby&logoColor=white) | `.rb` | Classes, modules, methods, singleton methods, require/require_relative, include/extend |
| ![Terraform](https://img.shields.io/badge/-Terraform-844FBA?style=flat-square&logo=terraform&logoColor=white) | `.tf`, `.hcl` | Resource, data, variable, module, output blocks |

## ⚙️ How It Works

```
┌──────────┐    ┌───────────┐    ┌───────────┐    ┌──────────┐    ┌─────────┐
│  Source  │──▶│ tree-sitter│──▶│  Extract  │──▶│  Resolve │──▶│ SQLite  │
│  Files   │    │   Parse   │    │  Symbols  │    │  Imports │    │   DB    │
└──────────┘    └───────────┘    └───────────┘    └──────────┘    └─────────┘
                                                                       │
                                                                       ▼
                                                                 ┌─────────┐
                                                                 │  Query  │
                                                                 └─────────┘
```

1. **Parse** — tree-sitter parses every source file into an AST (native Rust engine or WASM fallback)
2. **Extract** — Functions, classes, methods, interfaces, imports, exports, call sites, parameters, properties, and constants are extracted
3. **Resolve** — Imports are resolved to actual files (handles ESM conventions, `tsconfig.json` path aliases, `baseUrl`)
4. **Store** — Everything goes into SQLite as nodes + edges with tree-sitter node boundaries, plus structural edges (`contains`, `parameter_of`, `receiver`)
5. **Analyze** (opt-in) — Complexity metrics, control flow graphs (`--cfg`), dataflow edges (`--dataflow`), and AST node storage
6. **Query** — All queries run locally against the SQLite DB — typically under 100ms

### Incremental Rebuilds

The graph stays current without re-parsing your entire codebase. Three-tier change detection ensures rebuilds are proportional to what changed, not the size of the project:

1. **Tier 0 — Journal (O(changed)):** If `codegraph watch` was running, a change journal records exactly which files were touched. The next build reads the journal and only processes those files — zero filesystem scanning
2. **Tier 1 — mtime+size (O(n) stats, O(changed) reads):** No journal? Codegraph stats every file and compares mtime + size against stored values. Matching files are skipped without reading a single byte
3. **Tier 2 — Hash (O(changed) reads):** Files that fail the mtime/size check are read and MD5-hashed. Only files whose hash actually changed get re-parsed and re-inserted

**Result:** change one file in a 3,000-file project and the rebuild completes in under a second. Put it in a commit hook, a file watcher, or let your AI agent trigger it.

### Dual Engine

Codegraph ships with two parsing engines:

| Engine | How it works | When it's used |
|--------|-------------|----------------|
| **Native** (Rust) | napi-rs addon built from `crates/codegraph-core/` — parallel multi-core parsing via rayon | Auto-selected when the prebuilt binary is available |
| **WASM** | `web-tree-sitter` with pre-built `.wasm` grammars in `grammars/` | Fallback when the native addon isn't installed |

Both engines produce identical output. Use `--engine native|wasm|auto` to control selection (default: `auto`).

### Call Resolution

Calls are resolved with **qualified resolution** — method calls (`obj.method()`) are distinguished from standalone function calls, and built-in receivers (`console`, `Math`, `JSON`, `Array`, `Promise`, etc.) are filtered out automatically. Import scope is respected: a call to `foo()` only resolves to functions that are actually imported or defined in the same file, eliminating false positives from name collisions.

| Priority | Source | Confidence |
|---|---|---|
| 1 | **Import-aware** — `import { foo } from './bar'` → link to `bar` | `1.0` |
| 2 | **Same-file** — definitions in the current file | `1.0` |
| 3 | **Same directory** — definitions in sibling files (standalone calls only) | `0.7` |
| 4 | **Same parent directory** — definitions in sibling dirs (standalone calls only) | `0.5` |
| 5 | **Method hierarchy** — resolved through `extends`/`implements` | varies |

Method calls on unknown receivers skip global fallback entirely — `stmt.run()` will never resolve to a standalone `run` function in another file. Duplicate caller/callee edges are deduplicated automatically. Dynamic patterns like `fn.call()`, `fn.apply()`, `fn.bind()`, and `obj["method"]()` are also detected on a best-effort basis.

Codegraph also extracts symbols from common callback patterns: Commander `.command().action()` callbacks (as `command:build`), Express route handlers (as `route:GET /api/users`), and event emitter listeners (as `event:data`).

## 📊 Performance

Self-measured on every release via CI ([build benchmarks](generated/benchmarks/BUILD-BENCHMARKS.md) | [embedding benchmarks](generated/benchmarks/EMBEDDING-BENCHMARKS.md)):

| Metric | Latest |
|---|---|
| Build speed (native) | **1.9 ms/file** |
| Build speed (WASM) | **8.3 ms/file** |
| Query time | **3ms** |
| No-op rebuild (native) | **4ms** |
| 1-file rebuild (native) | **124ms** |
| Query: fn-deps | **1.4ms** |
| Query: path | **1.4ms** |
| ~50,000 files (est.) | **~95.0s build** |

Metrics are normalized per file for cross-version comparability. Times above are for a full initial build — incremental rebuilds only re-parse changed files.

### Lightweight Footprint

<a href="https://www.npmjs.com/package/@optave/codegraph"><img src="https://img.shields.io/npm/unpacked-size/@optave/codegraph?style=flat-square&label=unpacked%20size" alt="npm unpacked size" /></a>

Only **3 runtime dependencies** — everything else is optional or a devDependency:

| Dependency | What it does | | |
|---|---|---|---|
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Fast, synchronous SQLite driver | ![GitHub stars](https://img.shields.io/github/stars/WiseLibs/better-sqlite3?style=flat-square&label=%E2%AD%90) | ![npm downloads](https://img.shields.io/npm/dw/better-sqlite3?style=flat-square&label=%F0%9F%93%A5%2Fwk) |
| [commander](https://github.com/tj/commander.js) | CLI argument parsing | ![GitHub stars](https://img.shields.io/github/stars/tj/commander.js?style=flat-square&label=%E2%AD%90) | ![npm downloads](https://img.shields.io/npm/dw/commander?style=flat-square&label=%F0%9F%93%A5%2Fwk) |
| [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) | WASM tree-sitter bindings | ![GitHub stars](https://img.shields.io/github/stars/tree-sitter/tree-sitter?style=flat-square&label=%E2%AD%90) | ![npm downloads](https://img.shields.io/npm/dw/web-tree-sitter?style=flat-square&label=%F0%9F%93%A5%2Fwk) |

Optional: `@huggingface/transformers` (semantic search), `@modelcontextprotocol/sdk` (MCP server) — lazy-loaded only when needed.

## 🤖 AI Agent Integration

### MCP Server

Codegraph includes a built-in [Model Context Protocol](https://modelcontextprotocol.io/) server with 30 tools (31 in multi-repo mode), so AI assistants can query your dependency graph directly:

```bash
codegraph mcp                  # Single-repo mode (default) — only local project
codegraph mcp --multi-repo     # Enable access to all registered repos
codegraph mcp --repos a,b      # Restrict to specific repos (implies --multi-repo)
```

**Single-repo mode (default):** Tools operate only on the local `.codegraph/graph.db`. The `repo` parameter and `list_repos` tool are not exposed to the AI agent.

**Multi-repo mode (`--multi-repo`):** All tools gain an optional `repo` parameter to target any registered repository, and `list_repos` becomes available. Use `--repos` to restrict which repos the agent can access.

### CLAUDE.md / Agent Instructions

Add this to your project's `CLAUDE.md` to help AI agents use codegraph (full template in the [AI Agent Guide](docs/guides/ai-agent-guide.md#claudemd-template)):

```markdown
## Code Navigation

This project uses codegraph. The database is at `.codegraph/graph.db`.

### Before modifying code, always:
1. `codegraph where <name>` — find where the symbol lives
2. `codegraph audit <file-or-function> --quick` — understand the structure
3. `codegraph context <name> -T` — get full context (source, deps, callers)
4. `codegraph fn-impact <name> -T` — check blast radius before editing

### After modifying code:
5. `codegraph diff-impact --staged -T` — verify impact before committing

### Other useful commands
- `codegraph build .` — rebuild the graph (incremental by default)
- `codegraph map` — module overview
- `codegraph query <name> -T` — function call chain (callers + callees)
- `codegraph path <from> <to> -T` — shortest call path between two symbols
- `codegraph deps <file>` — file-level dependencies
- `codegraph roles --role dead -T` — find dead code (unreferenced symbols)
- `codegraph roles --role core -T` — find core symbols (high fan-in)
- `codegraph co-change <file>` — files that historically change together
- `codegraph complexity -T` — per-function complexity metrics (cognitive, cyclomatic, MI)
- `codegraph communities --drift -T` — module boundary drift analysis
- `codegraph check -T` — pass/fail rule check (CI gate, exit code 1 on fail)
- `codegraph audit <target> -T` — combined structural summary + impact + health in one report
- `codegraph triage -T` — ranked audit priority queue
- `codegraph triage --level file -T` — file-level hotspot analysis
- `codegraph check --staged` — CI validation predicates (exit code 0/1)
- `codegraph batch target1 target2` — batch query multiple targets at once
- `codegraph owners [target]` — CODEOWNERS mapping for symbols
- `codegraph snapshot save <name>` — checkpoint the graph DB before refactoring
- `codegraph branch-compare main HEAD -T` — structural diff between two refs (added/removed/changed symbols)
- `codegraph exports <file>` — per-symbol consumer analysis (who calls each export)
- `codegraph children <name>` — list parameters, properties, constants of a symbol
- `codegraph dataflow <name>` — data flow edges (flows_to, returns, mutates)
- `codegraph cfg <name>` — intraprocedural control flow graph
- `codegraph ast <pattern>` — search stored AST nodes (calls, new, string, regex, throw, await)
- `codegraph plot` — interactive HTML dependency graph viewer
- `codegraph search "<query>"` — hybrid search (requires `codegraph embed`)
- `codegraph search "<query>" --mode keyword` — BM25 keyword search
- `codegraph cycles` — check for circular dependencies

### Flags
- `-T` / `--no-tests` — exclude test files (use by default)
- `-j` / `--json` — JSON output for programmatic use
- `-f, --file <path>` — scope to a specific file
- `-k, --kind <kind>` — filter by symbol kind

### Semantic search

Use `codegraph search` to find functions by intent rather than exact name.
When a single query might miss results, combine multiple angles with `;`:

  codegraph search "validate auth; check token; verify JWT"
  codegraph search "parse config; load settings" --kind function

Multi-query search uses Reciprocal Rank Fusion — functions that rank
highly across several queries surface first. This is especially useful
when you're not sure what naming convention the codebase uses.

When writing multi-queries, use 2-4 sub-queries (2-4 words each) that
attack the problem from different angles. Pick from these strategies:
- **Naming variants**: cover synonyms the author might have used
  ("send email; notify user; deliver message")
- **Abstraction levels**: pair high-level intent with low-level operation
  ("handle payment; charge credit card")
- **Input/output sides**: cover the read half and write half
  ("parse config; apply settings")
- **Domain + technical**: bridge business language and implementation
  ("onboard tenant; create organization; provision workspace")

Use `--kind function` to cut noise. Use `--file <pattern>` to scope.
```

## 📋 Recommended Practices

See **[docs/guides/recommended-practices.md](docs/guides/recommended-practices.md)** for integration guides:

- **Git hooks** — auto-rebuild on commit, impact checks on push, commit message enrichment
- **CI/CD** — PR impact comments, threshold gates, graph caching
- **AI agents** — MCP server, CLAUDE.md templates, Claude Code hooks
- **Developer workflow** — watch mode, explore-before-you-edit, semantic search
- **Secure credentials** — `apiKeyCommand` with 1Password, Bitwarden, Vault, macOS Keychain, `pass`

For AI-specific integration, see the **[AI Agent Guide](docs/guides/ai-agent-guide.md)** — a comprehensive reference covering the 6-step agent workflow, complete command-to-MCP mapping, Claude Code hooks, and token-saving patterns.

## 🔁 CI / GitHub Actions

Codegraph ships with a ready-to-use GitHub Actions workflow that comments impact analysis on every pull request.

Copy `.github/workflows/codegraph-impact.yml` to your repo, and every PR will get a comment like:

> **3 functions changed** → **12 callers affected** across **7 files**

## 🛠️ Configuration

Create a `.codegraphrc.json` in your project root to customize behavior:

```json
{
  "include": ["src/**", "lib/**"],
  "exclude": ["**/*.test.js", "**/__mocks__/**"],
  "ignoreDirs": ["node_modules", ".git", "dist"],
  "extensions": [".js", ".ts", ".tsx", ".py"],
  "aliases": {
    "@/": "./src/",
    "@utils/": "./src/utils/"
  },
  "build": {
    "incremental": true
  },
  "query": {
    "excludeTests": true
  }
}
```

> **Tip:** `excludeTests` can also be set at the top level as a shorthand — `{ "excludeTests": true }` is equivalent to nesting it under `query`. If both are present, the nested `query.excludeTests` takes precedence.

### Manifesto rules

Configure pass/fail thresholds for `codegraph check` (manifesto mode):

```json
{
  "manifesto": {
    "rules": {
      "cognitive_complexity": { "warn": 15, "fail": 30 },
      "cyclomatic_complexity": { "warn": 10, "fail": 20 },
      "nesting_depth": { "warn": 4, "fail": 6 },
      "maintainability_index": { "warn": 40, "fail": 20 },
      "halstead_bugs": { "warn": 0.5, "fail": 1.0 }
    }
  }
}
```

When any function exceeds a `fail` threshold, `codegraph check` exits with code 1 — perfect for CI gates.

### LLM credentials

Codegraph supports an `apiKeyCommand` field for secure credential management. Instead of storing API keys in config files or environment variables, you can shell out to a secret manager at runtime:

```json
{
  "llm": {
    "provider": "openai",
    "apiKeyCommand": "op read op://vault/openai/api-key"
  }
}
```

The command is split on whitespace and executed with `execFileSync` (no shell injection risk). Priority: **command output > `CODEGRAPH_LLM_API_KEY` env var > file config**. On failure, codegraph warns and falls back to the next source.

Works with any secret manager: 1Password CLI (`op`), Bitwarden (`bw`), `pass`, HashiCorp Vault, macOS Keychain (`security`), AWS Secrets Manager, etc.

## 📖 Programmatic API

Codegraph also exports a full API for use in your own tools:

```js
import { buildGraph, queryNameData, findCycles, exportDOT, normalizeSymbol } from '@optave/codegraph';

// Build the graph
buildGraph('/path/to/project');

// Query programmatically
const results = queryNameData('myFunction', '/path/to/.codegraph/graph.db');
// All query results use normalizeSymbol for a stable 7-field schema
```

```js
import { parseFileAuto, getActiveEngine, isNativeAvailable } from '@optave/codegraph';

// Check which engine is active
console.log(getActiveEngine());      // 'native' or 'wasm'
console.log(isNativeAvailable());    // true if Rust addon is installed

// Parse a single file (uses auto-selected engine)
const symbols = await parseFileAuto('/path/to/file.ts');
```

```js
import { searchData, multiSearchData, buildEmbeddings } from '@optave/codegraph';

// Build embeddings (one-time)
await buildEmbeddings('/path/to/project');

// Single-query search
const { results } = await searchData('handle auth', dbPath);

// Multi-query search with RRF ranking
const { results: fused } = await multiSearchData(
  ['auth middleware', 'JWT validation'],
  dbPath,
  { limit: 10, minScore: 0.3 }
);
// Each result has: { name, kind, file, line, rrf, queryScores[] }
```

## ⚠️ Limitations

- **No full type inference** — parses `.d.ts` interfaces but doesn't use TypeScript's type checker for overload resolution
- **Dynamic calls are best-effort** — complex computed property access and `eval` patterns are not resolved
- **Python imports** — resolves relative imports but doesn't follow `sys.path` or virtual environment packages
- **Dataflow analysis** — currently JS/TS only; intraprocedural (single-function scope), not interprocedural

## 🗺️ Roadmap

See **[ROADMAP.md](docs/roadmap/ROADMAP.md)** for the full development roadmap and **[STABILITY.md](STABILITY.md)** for the stability policy and versioning guarantees. Current plan:

1. ~~**Rust Core**~~ — **Complete** (v1.3.0) — native tree-sitter parsing via napi-rs, parallel multi-core parsing, incremental re-parsing, import resolution & cycle detection in Rust
2. ~~**Foundation Hardening**~~ — **Complete** (v1.4.0) — parser registry, 12-tool MCP server with multi-repo support, test coverage 62%→75%, `apiKeyCommand` secret resolution, global repo registry
3. ~~**Deep Analysis**~~ — **Complete** (v3.0.0) — dataflow analysis (flows_to, returns, mutates), intraprocedural CFG for all 11 languages, stored AST nodes, expanded node/edge types (parameter, property, constant, contains, parameter_of, receiver), GraphML/GraphSON/Neo4j CSV export, interactive HTML viewer, CLI consolidation, stable JSON schema
4. **Architectural Refactoring** — parser plugin system, repository pattern, pipeline builder, engine strategy, domain errors, curated API
5. **Natural Language Queries** — `codegraph ask` command, conversational sessions
6. **Expanded Language Support** — 8 new languages (12 → 20)
7. **GitHub Integration & CI** — reusable GitHub Action, PR review, SARIF output
8. **TypeScript Migration** — gradual migration from JS to TypeScript

## 🤝 Contributing

Contributions are welcome! See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the full guide — setup, workflow, commit convention, testing, and architecture notes.

```bash
git clone https://github.com/optave/codegraph.git
cd codegraph
npm install
npm test
```

Looking to add a new language? Check out **[Adding a New Language](docs/guides/adding-a-language.md)**.

## 📄 License

[Apache-2.0](LICENSE)

---

<p align="center">
  <sub>Built with <a href="https://tree-sitter.github.io/">tree-sitter</a> and <a href="https://github.com/WiseLibs/better-sqlite3">better-sqlite3</a>. Your code stays on your machine.</sub>
</p>
