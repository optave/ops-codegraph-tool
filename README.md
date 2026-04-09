<p align="center">
  <img src="https://img.shields.io/badge/codegraph-dependency%20intelligence-blue?style=for-the-badge&logo=graphql&logoColor=white" alt="codegraph" />
</p>

<h1 align="center">codegraph</h1>

<p align="center">
  <strong>Give your AI the map before it starts exploring.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@optave/codegraph"><img src="https://img.shields.io/npm/v/@optave/codegraph?style=flat-square&logo=npm&logoColor=white&label=npm" alt="npm version" /></a>
  <a href="https://github.com/optave/ops-codegraph-tool/blob/main/LICENSE"><img src="https://img.shields.io/github/license/optave/ops-codegraph-tool?style=flat-square&logo=opensourceinitiative&logoColor=white" alt="Apache-2.0 License" /></a>
  <a href="https://github.com/optave/ops-codegraph-tool/actions"><img src="https://img.shields.io/github/actions/workflow/status/optave/ops-codegraph-tool/codegraph-impact.yml?style=flat-square&logo=githubactions&logoColor=white&label=CI" alt="CI" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.6-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node >= 22.6" />
</p>

<p align="center">
  <a href="#the-problem">The Problem</a> &middot;
  <a href="#what-codegraph-does">What It Does</a> &middot;
  <a href="#-quick-start">Quick Start</a> &middot;
  <a href="#-commands">Commands</a> &middot;
  <a href="#-language-support">Languages</a> &middot;
  <a href="#-ai-agent-integration-core">AI Integration</a> &middot;
  <a href="#-how-it-works">How It Works</a> &middot;
  <a href="#-recommended-practices">Practices</a> &middot;
  <a href="#-roadmap">Roadmap</a>
</p>

---

## The Problem

AI agents face an impossible trade-off. They either spend thousands of tokens reading files to understand a codebase's structure — blowing up their context window until quality degrades — or they assume how things work, and the assumptions are often wrong. Either way, things break. The larger the codebase, the worse it gets.

An agent modifies a function without knowing 9 files import it. It misreads what a helper does and builds logic on top of that misunderstanding. It leaves dead code behind after a refactor. The PR gets opened, and your reviewer — human or automated — flags the same structural issues again and again: _"this breaks 14 callers,"_ _"that function already exists,"_ _"this export is now dead."_ If the reviewer catches it, that's multiple rounds of back-and-forth. If they don't, it can ship to production. Multiply that by every PR, every developer, every repo.

The information to prevent these issues exists — it's in the code itself. But without a structured map, agents lack the context to get it right consistently, reviewers waste cycles on preventable issues, and architecture degrades one unreviewed change at a time.

## What Codegraph Does

Codegraph builds a function-level dependency graph of your entire codebase — every function, every caller, every dependency — and keeps it current with sub-second incremental rebuilds.

It parses your code with [tree-sitter](https://tree-sitter.github.io/) (native Rust or WASM), stores the graph in SQLite, and exposes it where it matters most:

- **MCP server** — AI agents query the graph directly through 30 tools — one call instead of 30 `grep`/`find`/`cat` invocations
- **CLI** — developers and agents explore, query, and audit code from the terminal
- **CI gates** — `check` and `manifesto` commands enforce quality thresholds with exit codes
- **Programmatic API** — embed codegraph in your own tools via `npm install`

Instead of an agent editing code without structural context and letting reviewers catch the fallout, it knows _"this function has 14 callers across 9 files"_ before it touches anything. Dead exports, circular dependencies, and boundary violations surface during development — not during review. The result: PRs that need fewer review rounds.

**Free. Open source. Fully local.** Zero network calls, zero telemetry. Your code stays on your machine. When you want deeper intelligence, bring your own LLM provider — your code only goes where you choose to send it.

**Three commands to a queryable graph:**

```bash
npm install -g @optave/codegraph
cd your-project
codegraph build
```

No config files, no Docker, no JVM, no API keys, no accounts. Point your agent at the MCP server and it has structural awareness of your codebase.

### Why it matters

| | Without codegraph | With codegraph |
|---|---|---|
| **Code review** | Reviewers flag broken callers, dead code, and boundary violations round after round | Structural issues are caught during development — PRs pass review with fewer rounds |
| **AI agents** | Modify `parseConfig()` without knowing 9 files import it — reviewer catches it | `fn-impact parseConfig` shows every caller before the edit — agent fixes it proactively |
| **AI agents** | Leave dead exports and duplicate helpers behind after refactors | Dead code, cycles, and duplicates surface in real time via hooks and MCP queries |
| **AI agents** | Produce code that works but doesn't fit the codebase structure | `context <name> -T` returns source, deps, callers, and tests — the agent writes code that fits |
| **CI pipelines** | Catch test failures but miss structural degradation | `check --staged` fails the build when blast radius or complexity thresholds are exceeded |
| **Developers** | Inherit a codebase and grep for hours to understand what calls what | `context handleAuth -T` gives the same structured view agents use |
| **Architects** | Draw boundary rules that erode within weeks | `manifesto` and `boundaries` enforce architecture rules on every commit |

### Feature comparison

<sub>Comparison last verified: March 2026. Claims verified against each repo's README/docs. Full analysis: <a href="generated/competitive/COMPETITIVE_ANALYSIS.md">COMPETITIVE_ANALYSIS.md</a></sub>

| Capability | codegraph | [joern](https://github.com/joernio/joern) | [narsil-mcp](https://github.com/postrv/narsil-mcp) | [cpg](https://github.com/Fraunhofer-AISEC/cpg) | [axon](https://github.com/harshkedia177/axon) | [GitNexus](https://github.com/abhigyanpatwari/GitNexus) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Languages | **34** | ~12 | **32** | ~10 | 3 | 13 |
| MCP server | **Yes** | — | **Yes** | **Yes** | **Yes** | **Yes** |
| Dataflow + CFG + AST querying | **Yes** | **Yes** | **Yes**¹ | **Yes** | — | — |
| Hybrid search (BM25 + semantic) | **Yes** | — | — | — | **Yes** | **Yes** |
| Git-aware (diff impact, co-change, branch diff) | **All 3** | — | — | — | **All 3** | — |
| Dead code / role classification | **Yes** | — | **Yes** | — | **Yes** | — |
| Incremental rebuilds | **O(changed)** | — | O(n) | — | **Yes** | Commit-level⁴ |
| Architecture rules + CI gate | **Yes** | — | — | — | — | — |
| Security scanning (SAST / vuln detection) | Intentionally out of scope² | **Yes** | **Yes** | **Yes** | — | — |
| Zero config, `npm install` | **Yes** | — | **Yes** | — | **Yes** | **Yes** |
| Graph export (GraphML / Neo4j / DOT) | **Yes** | **Yes** | — | — | — | — |
| Open source + commercial use | **Yes** (Apache-2.0) | **Yes** (Apache-2.0) | **Yes** (MIT/Apache-2.0) | **Yes** (Apache-2.0) | Source-available³ | Non-commercial⁵ |

<sup>¹ narsil-mcp added CFG and dataflow in recent versions. ² Codegraph focuses on structural understanding, not vulnerability detection — use dedicated SAST tools (Semgrep, CodeQL, Snyk) for that. ³ axon claims MIT in pyproject.toml but has no LICENSE file in the repo. ⁴ GitNexus skips re-index if the git commit hasn't changed, but re-processes the entire repo when it does — no per-file incremental parsing. ⁵ GitNexus uses the PolyForm Noncommercial 1.0.0 license.</sup>

### What makes codegraph different

| | Differentiator | In practice |
|---|---|---|
| **🤖** | **AI-first architecture** | 30-tool [MCP server](https://modelcontextprotocol.io/) — agents query the graph directly instead of scraping the filesystem. One call replaces 20+ grep/find/cat invocations |
| **🏷️** | **Role classification** | Every symbol auto-tagged as `entry`/`core`/`utility`/`adapter`/`dead`/`leaf` — agents understand a symbol's architectural role without reading surrounding code |
| **🔬** | **Function-level, not just files** | Traces `handleAuth()` → `validateToken()` → `decryptJWT()` and shows 14 callers across 9 files break if `decryptJWT` changes |
| **⚡** | **Always-fresh graph** | Three-tier change detection: journal (O(changed)) → mtime+size (O(n) stats) → hash (O(changed) reads). Sub-second rebuilds — agents work with current data |
| **💥** | **Git diff impact** | `codegraph diff-impact` shows changed functions, their callers, and full blast radius — enriched with historically coupled files from git co-change analysis. Ships with a GitHub Actions workflow |
| **🌐** | **Multi-language, one graph** | 34 languages in a single graph — JS/TS, Python, Go, Rust, Java, C#, PHP, Ruby, C/C++, Kotlin, Swift, Scala, Bash, HCL, Elixir, Lua, Dart, Zig, Haskell, OCaml, F#, Gleam, Clojure, Julia, R, Erlang, Solidity, Objective-C, CUDA, Groovy, Verilog — agents don't need per-language tools |
| **🧠** | **Hybrid search** | BM25 keyword + semantic embeddings fused via RRF — `hybrid` (default), `semantic`, or `keyword` mode; multi-query via `"auth; token; JWT"` |
| **🔬** | **Dataflow + CFG** | Track how data flows through functions (`flows_to`, `returns`, `mutates`) and visualize intraprocedural control flow graphs for all 34 languages |
| **🔓** | **Fully local, zero cost** | No API keys, no accounts, no network calls. Optionally bring your own LLM provider — your code only goes where you choose |

---

## 🚀 Quick Start

```bash
npm install -g @optave/codegraph
cd your-project
codegraph build        # → .codegraph/graph.db created
```

That's it. The graph is ready. Now connect your AI agent.

### For AI agents (primary use case)

Connect directly via MCP — your agent gets 30 tools to query the graph:

```bash
codegraph mcp          # 33-tool MCP server — AI queries the graph directly
```

Or add codegraph to your agent's instructions (e.g. `CLAUDE.md`):

```markdown
Before modifying code, always:
1. `codegraph where <name>` — find where the symbol lives
2. `codegraph context <name> -T` — get full context (source, deps, callers)
3. `codegraph fn-impact <name> -T` — check blast radius before editing

After modifying code:
4. `codegraph diff-impact --staged -T` — verify impact before committing
```

Full agent setup: [AI Agent Guide](docs/guides/ai-agent-guide.md) &middot; [CLAUDE.md template](docs/guides/ai-agent-guide.md#claudemd-template)

### For developers

The same graph is available via CLI:

```bash
codegraph map          # see most-connected files
codegraph query myFunc # find any function, see callers & callees
codegraph deps src/index.ts  # file-level import/export map
```

Or install from source:

```bash
git clone https://github.com/optave/ops-codegraph-tool.git
cd codegraph && npm install && npm link
```

> **Dev builds:** Pre-release tarballs are attached to [GitHub Releases](https://github.com/optave/ops-codegraph-tool/releases). Install with `npm install -g <path-to-tarball>`. Note that `npm install -g <tarball-url>` does not work because npm cannot resolve optional platform-specific dependencies from a URL — download the `.tgz` first, then install from the local file.

---

## ✨ Features

| | Feature | Description |
|---|---|---|
| 🤖 | **MCP server** | 33-tool MCP server for AI assistants; single-repo by default, opt-in multi-repo |
| 🎯 | **Deep context** | `context` gives agents source, deps, callers, signature, and tests for a function in one call; `audit --quick` gives structural summaries |
| 🏷️ | **Node role classification** | Every symbol auto-tagged as `entry`/`core`/`utility`/`adapter`/`dead`/`leaf` based on connectivity — agents instantly know architectural role |
| 📦 | **Batch querying** | Accept a list of targets and return all results in one JSON payload — enables multi-agent parallel dispatch |
| 💥 | **Impact analysis** | Trace every file affected by a change (transitive) |
| 🧬 | **Function-level tracing** | Call chains, caller trees, function-level impact, and A→B pathfinding with qualified call resolution |
| 📍 | **Fast lookup** | `where` shows exactly where a symbol is defined and used — minimal, fast |
| 🔍 | **Symbol search** | Find any function, class, or method by name — exact match priority, relevance scoring, `--file` and `--kind` filters |
| 📁 | **File dependencies** | See what a file imports and what imports it |
| 📊 | **Diff impact** | Parse `git diff`, find overlapping functions, trace their callers |
| 🔗 | **Co-change analysis** | Analyze git history for files that always change together — surfaces hidden coupling the static graph can't see; enriches `diff-impact` with historically coupled files |
| 🗺️ | **Module map** | Bird's-eye view of your most-connected files |
| 🏗️ | **Structure & hotspots** | Directory cohesion scores, fan-in/fan-out hotspot detection, module boundaries |
| 🔄 | **Cycle detection** | Find circular dependencies at file or function level |
| 📤 | **Export** | DOT, Mermaid, JSON, GraphML, GraphSON, and Neo4j CSV graph export |
| 🧠 | **Semantic search** | Embeddings-powered natural language search with multi-query RRF ranking |
| 👀 | **Watch mode** | Incrementally update the graph as files change |
| ⚡ | **Always fresh** | Three-tier incremental detection — sub-second rebuilds even on large codebases |
| 🔬 | **Data flow analysis** | Intraprocedural parameter tracking, return consumers, argument flows, and mutation detection — all 34 languages |
| 🧮 | **Complexity metrics** | Cognitive, cyclomatic, nesting depth, Halstead, and Maintainability Index per function |
| 🏘️ | **Community detection** | Leiden clustering to discover natural module boundaries and architectural drift |
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
| 🔬 | **Dataflow analysis** | Track how data moves through functions with `flows_to`, `returns`, and `mutates` edges — all 34 languages, included by default, skip with `--no-dataflow` |
| 🧩 | **Control flow graph** | Intraprocedural CFG construction for all 34 languages — `cfg` command with text/DOT/Mermaid output, included by default, skip with `--no-cfg` |
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
codegraph build --dataflow     # Extract data flow edges (flows_to, returns, mutates)
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

### Deep Context (designed for AI agents)

```bash
codegraph context <name>       # Full context: source, deps, callers, signature, tests
codegraph context <name> --depth 2 --no-tests  # Include callee source 2 levels deep
codegraph brief <file>            # Token-efficient file summary: symbols, roles, risk tiers
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
codegraph communities             # Leiden community detection — natural module boundaries
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

> **Note:** Dataflow and CFG are included by default for all 34 languages. Use `--no-dataflow` / `--no-cfg` for faster builds.


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
| `--table` | Output as auto-column aligned table |
| `--csv` | Output as CSV (RFC 4180, nested objects flattened) |
| `--limit <n>` | Limit number of results |
| `--offset <n>` | Skip first N results (pagination) |
| `--rrf-k <n>` | RRF smoothing constant for multi-query search (default 60) |

## 🌐 Language Support

| Language | Extensions | Imports | Exports | Call Sites | Heritage¹ | Type Inference² | Dataflow |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| ![JavaScript](https://img.shields.io/badge/-JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black) | `.js`, `.jsx`, `.mjs`, `.cjs` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ![TypeScript](https://img.shields.io/badge/-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white) | `.ts`, `.tsx` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ![Python](https://img.shields.io/badge/-Python-3776AB?style=flat-square&logo=python&logoColor=white) | `.py`, `.pyi` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ![Go](https://img.shields.io/badge/-Go-00ADD8?style=flat-square&logo=go&logoColor=white) | `.go` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ![Rust](https://img.shields.io/badge/-Rust-000000?style=flat-square&logo=rust&logoColor=white) | `.rs` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ![Java](https://img.shields.io/badge/-Java-ED8B00?style=flat-square&logo=openjdk&logoColor=white) | `.java` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ![C#](https://img.shields.io/badge/-C%23-512BD4?style=flat-square&logo=dotnet&logoColor=white) | `.cs` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ![PHP](https://img.shields.io/badge/-PHP-777BB4?style=flat-square&logo=php&logoColor=white) | `.php`, `.phtml` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ![Ruby](https://img.shields.io/badge/-Ruby-CC342D?style=flat-square&logo=ruby&logoColor=white) | `.rb`, `.rake`, `.gemspec` | ✓ | ✓ | ✓ | ✓ | —³ | ✓ |
| ![C](https://img.shields.io/badge/-C-A8B9CC?style=flat-square&logo=c&logoColor=black) | `.c`, `.h` | ✓ | ✓ | ✓ | —⁴ | —⁴ | ✓ |
| ![C++](https://img.shields.io/badge/-C++-00599C?style=flat-square&logo=cplusplus&logoColor=white) | `.cpp`, `.hpp`, `.cc`, `.cxx` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| ![Kotlin](https://img.shields.io/badge/-Kotlin-7F52FF?style=flat-square&logo=kotlin&logoColor=white) | `.kt`, `.kts` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| ![Swift](https://img.shields.io/badge/-Swift-F05138?style=flat-square&logo=swift&logoColor=white) | `.swift` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| ![Scala](https://img.shields.io/badge/-Scala-DC322F?style=flat-square&logo=scala&logoColor=white) | `.scala`, `.sc` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| ![Bash](https://img.shields.io/badge/-Bash-4EAA25?style=flat-square&logo=gnubash&logoColor=white) | `.sh`, `.bash` | ✓ | ✓ | ✓ | —⁴ | —⁴ | ✓ |
| ![Elixir](https://img.shields.io/badge/-Elixir-4B275F?style=flat-square&logo=elixir&logoColor=white) | `.ex`, `.exs` | ✓ | ✓ | ✓ | — | — | ✓ |
| ![Lua](https://img.shields.io/badge/-Lua-2C2D72?style=flat-square&logo=lua&logoColor=white) | `.lua` | ✓ | ✓ | ✓ | — | — | ✓ |
| ![Dart](https://img.shields.io/badge/-Dart-0175C2?style=flat-square&logo=dart&logoColor=white) | `.dart` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| ![Zig](https://img.shields.io/badge/-Zig-F7A41D?style=flat-square&logo=zig&logoColor=white) | `.zig` | ✓ | ✓ | ✓ | — | — | ✓ |
| ![Haskell](https://img.shields.io/badge/-Haskell-5D4F85?style=flat-square&logo=haskell&logoColor=white) | `.hs` | ✓ | ✓ | ✓ | — | — | ✓ |
| ![OCaml](https://img.shields.io/badge/-OCaml-EC6813?style=flat-square&logo=ocaml&logoColor=white) | `.ml`, `.mli` | ✓ | ✓ | ✓ | — | — | ✓ |
| ![F#](https://img.shields.io/badge/-F%23-378BBA?style=flat-square&logo=fsharp&logoColor=white) | `.fs`, `.fsx`, `.fsi` | ✓ | ✓ | ✓ | — | — | ✓ |
| ![Gleam](https://img.shields.io/badge/-Gleam-FFAFF3?style=flat-square&logoColor=black) | `.gleam` | ✓ | ✓ | ✓ | — | — | ✓ |
| ![Clojure](https://img.shields.io/badge/-Clojure-5881D8?style=flat-square&logo=clojure&logoColor=white) | `.clj`, `.cljs`, `.cljc` | ✓ | ✓ | ✓ | — | — | ✓ |
| ![Julia](https://img.shields.io/badge/-Julia-9558B2?style=flat-square&logo=julia&logoColor=white) | `.jl` | ✓ | ✓ | ✓ | — | — | ✓ |
| ![R](https://img.shields.io/badge/-R-276DC3?style=flat-square&logo=r&logoColor=white) | `.r`, `.R` | ✓ | ✓ | ✓ | — | — | ✓ |
| ![Erlang](https://img.shields.io/badge/-Erlang-A90533?style=flat-square&logo=erlang&logoColor=white) | `.erl`, `.hrl` | ✓ | ✓ | ✓ | — | — | ✓ |
| ![Solidity](https://img.shields.io/badge/-Solidity-363636?style=flat-square&logo=solidity&logoColor=white) | `.sol` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| ![Objective-C](https://img.shields.io/badge/-Objective--C-438EFF?style=flat-square&logoColor=white) | `.m` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| ![CUDA](https://img.shields.io/badge/-CUDA-76B900?style=flat-square&logo=nvidia&logoColor=white) | `.cu`, `.cuh` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| ![Groovy](https://img.shields.io/badge/-Groovy-4298B8?style=flat-square&logo=apachegroovy&logoColor=white) | `.groovy`, `.gvy` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| ![Verilog](https://img.shields.io/badge/-Verilog-848484?style=flat-square&logoColor=white) | `.v`, `.sv` | ✓ | ✓ | ✓ | — | — | ✓ |
| ![Terraform](https://img.shields.io/badge/-Terraform-844FBA?style=flat-square&logo=terraform&logoColor=white) | `.tf`, `.hcl` | ✓ | —³ | —³ | —³ | —³ | —³ |

> ¹ **Heritage** = `extends`, `implements`, `include`/`extend` (Ruby), trait `impl` (Rust), receiver methods (Go).
> ² **Type Inference** extracts a per-file type map from annotations (`const x: Router`, `MyType x`, `x: MyType`) and `new` expressions, enabling the edge resolver to connect `x.method()` → `Type.method()`.
> ³ Not applicable — Ruby is dynamically typed; Terraform/HCL is declarative (no functions, classes, or type system).
> ⁴ Not applicable — C and Bash have no class/inheritance system.
> All languages have full **parity** between the native Rust engine and the WASM fallback.

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

On the native path, Rust handles the entire hot pipeline end-to-end:

| Phase | What Rust does |
|-------|---------------|
| **Parse** | Parallel multi-file tree-sitter parsing via rayon (3.5× faster than WASM) |
| **Extract** | Symbols, imports, calls, classes, type maps, AST nodes — all in one pass |
| **Analyze** | Complexity (cognitive, cyclomatic, Halstead), CFG, and dataflow pre-computed per function during parse |
| **Resolve** | Import resolution with 6-level priority system and confidence scoring |
| **Edges** | Call, receiver, extends, and implements edge inference |
| **DB writes** | All inserts (nodes, edges, AST nodes, complexity, CFG, dataflow) via rusqlite — `better-sqlite3` is lazy-loaded only for the WASM fallback path |

The Rust crate (`crates/codegraph-core/`) exposes a `NativeDatabase` napi-rs class that holds a persistent `rusqlite::Connection` for the full build lifecycle, eliminating JS↔SQLite round-trips on every operation.

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

Self-measured on every release via CI ([build benchmarks](generated/benchmarks/BUILD-BENCHMARKS.md) | [embedding benchmarks](generated/benchmarks/EMBEDDING-BENCHMARKS.md) | [query benchmarks](generated/benchmarks/QUERY-BENCHMARKS.md) | [incremental benchmarks](generated/benchmarks/INCREMENTAL-BENCHMARKS.md) | [resolution precision/recall](tests/benchmarks/resolution/)):

*Last updated: v3.9.2 (2026-04-09)*

| Metric | Native | WASM |
|---|---|---|
| Build speed | **15.7 ms/file** | **15 ms/file** |
| Query time | **27ms** | **40ms** |
| No-op rebuild | **9ms** | **20ms** |
| 1-file rebuild | **558ms** | **624ms** |
| Query: fn-deps | **2.3ms** | **2.4ms** |
| Query: path | **2.5ms** | **2.4ms** |
| ~50,000 files (est.) | **~785.0s build** | **~750.0s build** |
| Resolution precision | **90.7%** | — |
| Resolution recall | **42.9%** | — |

Metrics are normalized per file for cross-version comparability. Times above are for a full initial build — incremental rebuilds only re-parse changed files.

<details><summary>Per-language resolution precision/recall</summary>

| Language | Precision | Recall | TP | FP | FN | Edges | Dynamic |
|----------|----------:|-------:|---:|---:|---:|------:|--------:|
| javascript | 100.0% | 66.7% | 12 | 0 | 6 | 18 | 14/28 |
| typescript | 100.0% | 75.0% | 15 | 0 | 5 | 20 | — |
| bash | 100.0% | 100.0% | 12 | 0 | 0 | 12 | 0/1 |
| c | 100.0% | 100.0% | 9 | 0 | 0 | 9 | — |
| clojure | 80.0% | 26.7% | 4 | 1 | 11 | 15 | — |
| cpp | 100.0% | 57.1% | 8 | 0 | 6 | 14 | — |
| csharp | 100.0% | 52.6% | 10 | 0 | 9 | 19 | — |
| cuda | 50.0% | 33.3% | 4 | 4 | 8 | 12 | — |
| dart | 0.0% | 0.0% | 0 | 0 | 18 | 18 | — |
| elixir | 0.0% | 0.0% | 0 | 0 | 15 | 15 | — |
| erlang | 100.0% | 100.0% | 12 | 0 | 0 | 12 | — |
| fsharp | 0.0% | 0.0% | 0 | 9 | 12 | 12 | — |
| gleam | 100.0% | 26.7% | 4 | 0 | 11 | 15 | — |
| go | 100.0% | 69.2% | 9 | 0 | 4 | 13 | 13/14 |
| groovy | 100.0% | 7.7% | 1 | 0 | 12 | 13 | — |
| haskell | 100.0% | 33.3% | 4 | 0 | 8 | 12 | — |
| hcl | 0.0% | 0.0% | 0 | 0 | 2 | 2 | — |
| java | 100.0% | 52.9% | 9 | 0 | 8 | 17 | — |
| julia | 0.0% | 0.0% | 0 | 0 | 15 | 15 | — |
| kotlin | 92.3% | 63.2% | 12 | 1 | 7 | 19 | — |
| lua | 100.0% | 15.4% | 2 | 0 | 11 | 13 | — |
| objc | 0.0% | 0.0% | 0 | 1 | 12 | 12 | — |
| ocaml | 100.0% | 8.3% | 1 | 0 | 11 | 12 | — |
| php | 100.0% | 31.6% | 6 | 0 | 13 | 19 | — |
| python | 100.0% | 60.0% | 9 | 0 | 6 | 15 | 15/15 |
| r | 100.0% | 100.0% | 11 | 0 | 0 | 11 | — |
| ruby | 100.0% | 100.0% | 11 | 0 | 0 | 11 | 11/11 |
| rust | 100.0% | 35.7% | 5 | 0 | 9 | 14 | — |
| scala | 100.0% | 71.4% | 5 | 0 | 2 | 7 | — |
| solidity | 33.3% | 7.7% | 1 | 2 | 12 | 13 | — |
| swift | 75.0% | 42.9% | 6 | 2 | 8 | 14 | 9/9 |
| tsx | 100.0% | 100.0% | 13 | 0 | 0 | 13 | — |
| verilog | 0.0% | 0.0% | 0 | 0 | 4 | 4 | — |
| zig | 0.0% | 0.0% | 0 | 0 | 15 | 15 | — |

**By resolution mode (all languages):**

| Mode | Resolved | Expected | Recall |
|------|--------:|---------:|-------:|
| module-function | 16 | 106 | 15.1% |
| receiver-typed | 17 | 104 | 16.3% |
| static | 66 | 93 | 71.0% |
| same-file | 48 | 86 | 55.8% |
| interface-dispatched | 7 | 12 | 58.3% |
| class-inheritance | 0 | 4 | 0.0% |
| trait-dispatch | 0 | 2 | 0.0% |
| package-function | 1 | 1 | 100.0% |

</details>

### Lightweight Footprint

<a href="https://www.npmjs.com/package/@optave/codegraph"><img src="https://img.shields.io/npm/unpacked-size/@optave/codegraph?style=flat-square&label=unpacked%20size" alt="npm unpacked size" /></a>

Only **3 runtime dependencies** — everything else is optional or a devDependency:

| Dependency | What it does | | |
|---|---|---|---|
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | SQLite driver (WASM engine; lazy-loaded, not used for native-engine reads) | ![GitHub stars](https://img.shields.io/github/stars/WiseLibs/better-sqlite3?style=flat-square&label=%E2%AD%90) | ![npm downloads](https://img.shields.io/npm/dw/better-sqlite3?style=flat-square&label=%F0%9F%93%A5%2Fwk) |
| [commander](https://github.com/tj/commander.js) | CLI argument parsing | ![GitHub stars](https://img.shields.io/github/stars/tj/commander.js?style=flat-square&label=%E2%AD%90) | ![npm downloads](https://img.shields.io/npm/dw/commander?style=flat-square&label=%F0%9F%93%A5%2Fwk) |
| [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) | WASM tree-sitter bindings | ![GitHub stars](https://img.shields.io/github/stars/tree-sitter/tree-sitter?style=flat-square&label=%E2%AD%90) | ![npm downloads](https://img.shields.io/npm/dw/web-tree-sitter?style=flat-square&label=%F0%9F%93%A5%2Fwk) |

Optional: `@huggingface/transformers` (semantic search), `@modelcontextprotocol/sdk` (MCP server) — lazy-loaded only when needed.

## 🤖 AI Agent Integration (Core)

### MCP Server

Codegraph is built around a [Model Context Protocol](https://modelcontextprotocol.io/) server with 30 tools (31 in multi-repo mode) — the primary way agents consume the graph:

```bash
codegraph mcp                  # Single-repo mode (default) — only local project
codegraph mcp --multi-repo     # Enable access to all registered repos
codegraph mcp --repos a,b      # Restrict to specific repos (implies --multi-repo)
```

**Single-repo mode (default):** Tools operate only on the local `.codegraph/graph.db`. The `repo` parameter and `list_repos` tool are not exposed to the AI agent.

**Multi-repo mode (`--multi-repo`):** All tools gain an optional `repo` parameter to target any registered repository, and `list_repos` becomes available. Use `--repos` to restrict which repos the agent can access.

### CLAUDE.md / Agent Instructions

Add this to your project's `CLAUDE.md` to help AI agents use codegraph. Full template with all commands in the [AI Agent Guide](docs/guides/ai-agent-guide.md#claudemd-template).

```markdown
## Codegraph

This project uses codegraph for dependency analysis. The graph is at `.codegraph/graph.db`.

### Before modifying code:
1. `codegraph where <name>` — find where the symbol lives
2. `codegraph audit --quick <target>` — understand the structure
3. `codegraph context <name> -T` — get full context (source, deps, callers)
4. `codegraph fn-impact <name> -T` — check blast radius before editing

### After modifying code:
5. `codegraph diff-impact --staged -T` — verify impact before committing

### Other useful commands
- `codegraph build .` — rebuild graph (incremental by default)
- `codegraph map` — module overview · `codegraph stats` — graph health
- `codegraph query <name> -T` — call chain · `codegraph path <from> <to> -T` — shortest path
- `codegraph deps <file>` — file deps · `codegraph exports <file> -T` — export consumers
- `codegraph audit <target> -T` — full risk report · `codegraph triage -T` — priority queue
- `codegraph check --staged` — CI gate · `codegraph batch t1 t2 -T --json` — batch query
- `codegraph search "<query>"` — semantic search · `codegraph cycles` — cycle detection
- `codegraph roles --role dead -T` — dead code · `codegraph complexity -T` — metrics
- `codegraph dataflow <name> -T` — data flow · `codegraph cfg <name> -T` — control flow

### Flags
- `-T` — exclude test files (use by default) · `-j` — JSON output
- `-f, --file <path>` — scope to file · `-k, --kind <kind>` — filter kind
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

- **No TypeScript type-checker integration** — type inference resolves annotations, `new` expressions, and assignment chains, but does not invoke `tsc` for overload resolution or complex generics
- **Dynamic calls are best-effort** — complex computed property access and `eval` patterns are not resolved
- **Python imports** — resolves relative imports but doesn't follow `sys.path` or virtual environment packages
- **Dataflow analysis** — intraprocedural (single-function scope), not interprocedural

## 🗺️ Roadmap

See **[ROADMAP.md](docs/roadmap/ROADMAP.md)** for the full development roadmap and **[STABILITY.md](STABILITY.md)** for the stability policy and versioning guarantees. Current plan:

1. ~~**Rust Core**~~ — **Complete** (v1.3.0) — native tree-sitter parsing via napi-rs, parallel multi-core parsing, incremental re-parsing, import resolution & cycle detection in Rust
2. ~~**Foundation Hardening**~~ — **Complete** (v1.5.0) — parser registry, complete MCP, test coverage, enhanced config, multi-repo MCP
3. ~~**Analysis Expansion**~~ — **Complete** (v2.7.0) — complexity metrics, community detection, flow tracing, co-change, manifesto, boundary rules, check, triage, audit, batch, hybrid search
4. ~~**Deep Analysis & Graph Enrichment**~~ — **Complete** (v3.0.0) — dataflow analysis, intraprocedural CFG, AST node storage, expanded node/edge types, interactive viewer, exports command
5. ~~**Architectural Refactoring**~~ — **Complete** (v3.1.5) — unified AST analysis, composable MCP, domain errors, builder pipeline, graph model, qualified names, presentation layer, CLI composability
6. ~~**Resolution Accuracy**~~ — **Complete** (v3.3.1) — type inference, receiver type tracking, dead role sub-categories, resolution benchmarks, `package.json` exports, monorepo workspace resolution
7. ~~**TypeScript Migration**~~ — **Complete** (v3.4.0) — all 271 source files migrated from JS to TS, zero `.js` remaining
8. ~~**Native Analysis Acceleration**~~ — **Complete** (v3.5.0) — all build phases in Rust/rusqlite, sub-100ms incremental rebuilds, better-sqlite3 lazy-loaded as fallback only
9. ~~**Expanded Language Support**~~ — **Complete** (v3.8.0) — 23 new languages in 4 batches (11 → 34), dual-engine WASM + Rust support for all
10. **Analysis Depth** — TypeScript-native resolution, inter-procedural type propagation, field-based points-to analysis
11. **Runtime & Extensibility** — event-driven pipeline, plugin system, query caching, pagination
12. **Quality, Security & Technical Debt** — supply-chain security (SBOM, SLSA), CI coverage gates, timer cleanup, tech debt kill list
13. **Intelligent Embeddings** — LLM-generated descriptions, enhanced embeddings, module summaries
14. **Natural Language Queries** — `codegraph ask` command, conversational sessions
15. **GitHub Integration & CI** — reusable GitHub Action, LLM-enhanced PR review, SARIF output
16. **Advanced Features** — dead code detection, monorepo support, agentic search

## 🤝 Contributing

Contributions are welcome! See **[CONTRIBUTING.md](CONTRIBUTING.md)** for the full guide — setup, workflow, commit convention, testing, and architecture notes.

```bash
git clone https://github.com/optave/ops-codegraph-tool.git
cd codegraph
npm install
npm test
```

Looking to add a new language? Check out **[Adding a New Language](docs/contributing/adding-a-language.md)**.

## 📄 License

[Apache-2.0](LICENSE)

---

<p align="center">
  <sub>Built with <a href="https://tree-sitter.github.io/">tree-sitter</a> and <a href="https://github.com/WiseLibs/better-sqlite3">better-sqlite3</a>. Your code stays on your machine.</sub>
</p>
