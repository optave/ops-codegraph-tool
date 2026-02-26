# Codegraph Feature Backlog

**Last updated:** 2026-02-25
**Source:** Features derived from [COMPETITIVE_ANALYSIS.md](../../generated/COMPETITIVE_ANALYSIS.md) and internal roadmap discussions.

---

## How to Read This Backlog

Each item has a short title, description, category, expected benefit, and four assessment columns left blank for prioritization review:

| Column | Meaning |
|--------|---------|
| **Zero-dep** | Can this feature be implemented without adding new runtime dependencies to the project? A checkmark means it builds entirely on what we already ship (tree-sitter, SQLite, existing AST). Blank means it needs evaluation. Features that require new deps raise the install footprint and maintenance burden — they need stronger justification. |
| **Foundation-aligned** | Does this feature align with the [FOUNDATION.md](../../FOUNDATION.md) core principles? Specifically: does it keep the graph always-current (P1), maintain zero-cost core with optional LLM enhancement (P4), respect embeddable-first design (P5), and stay honest about what we are — a code intelligence engine, not an application (P8)? A checkmark means full alignment. An X means it conflicts with at least one principle and needs a deliberate exception. |
| **Problem-fit (1-5)** | How directly does this feature address the core problem from our README: *AI coding assistants waste tokens re-orienting themselves in large codebases, hallucinate dependencies, and miss blast radius.* A 5 means it directly reduces token waste, prevents hallucinated deps, or catches breakage. A 1 means it's tangential — nice to have but doesn't solve the stated problem. |
| **Breaking** | Is this a breaking change? `Yes` means existing CLI output, API signatures, DB schema, or MCP tool contracts change in incompatible ways. `No` means it's purely additive. Breaking changes require a major version bump. |

---

## Backlog

### Tier 1 — Zero-dep + Foundation-aligned (build these first)

Non-breaking, ordered by problem-fit:

| ID | Title | Description | Category | Benefit | Zero-dep | Foundation-aligned | Problem-fit (1-5) | Breaking |
|----|-------|-------------|----------|---------|----------|-------------------|-------------------|----------|
| 4 | ~~Node classification~~ | ~~Auto-tag symbols as Entry Point / Core / Utility / Adapter based on in-degree/out-degree patterns. High fan-in + low fan-out = Core. Zero fan-in + non-export = Dead. Inspired by arbor.~~ | Intelligence | ~~Agents immediately understand architectural role of any symbol without reading surrounding code — fewer orientation tokens~~ | ✓ | ✓ | 5 | No | **DONE** — `classifyNodeRoles()` in `structure.js` auto-tags every symbol as `entry`/`core`/`utility`/`adapter`/`dead`/`leaf` using median-based fan-in/fan-out thresholds. Roles stored in DB (`role` column, migration v5), surfaced in `where`/`explain`/`context`/`stats`/`list-functions`, new `roles` CLI command, new `node_roles` MCP tool (18 tools total). Includes `--role` and `--file` filters. |
| 9 | ~~Git change coupling~~ | ~~Analyze git history for files/functions that always change together. Surfaces hidden dependencies that the static graph can't see. Enhances `diff-impact` with historical co-change data. Inspired by axon.~~ | Analysis | ~~`diff-impact` catches more breakage by including historically coupled files; agents get a more complete blast radius picture~~ | ✓ | ✓ | 5 | No | **DONE** — `src/cochange.js` module with scan, compute, analyze, and query functions. DB migration v5 adds `co_changes` + `co_change_meta` tables. CLI command `codegraph co-change [file]` with `--analyze`, `--since`, `--min-support`, `--min-jaccard`, `--full` options. Integrates into `diff-impact` output via `historicallyCoupled` section. New `co_changes` MCP tool (19 tools total). Uses Jaccard similarity on commit history. |
| 1 | ~~Dead code detection~~ | ~~Find symbols with zero incoming edges (excluding entry points and exports). Agents constantly ask "is this used?" — the graph already has the data, we just need to surface it. Inspired by narsil-mcp, axon, codexray, CKB.~~ | Analysis | ~~Agents stop wasting tokens investigating dead code; developers get actionable cleanup lists without external tools~~ | ✓ | ✓ | 4 | No | **DONE** — Delivered as part of node classification (ID 4). `codegraph roles --role dead -T` lists all symbols with zero fan-in that aren't exported. |
| 2 | Shortest path A→B | BFS/Dijkstra on the existing edges table to find how symbol A reaches symbol B. We have `fn` for single-node chains but no A→B pathfinding. Inspired by codexray, arbor. | Navigation | Agents can answer "how does this function reach that one?" in one call instead of manually tracing chains | ✓ | ✓ | 4 | No |
| 12 | Execution flow tracing | Framework-aware entry point detection (Express routes, CLI commands, event handlers) + BFS flow tracing from entry to leaf. Inspired by axon, GitNexus, code-context-mcp. | Navigation | Agents can answer "what happens when a user hits POST /login?" by tracing the full execution path in one query | ✓ | ✓ | 4 | No |
| 16 | Branch structural diff | Compare code structure between two branches using git worktrees. Show added/removed/changed symbols and their impact. Inspired by axon. | Analysis | Teams can review structural impact of feature branches before merge; agents get branch-aware context | ✓ | ✓ | 4 | No |
| 20 | Streaming / chunked results | Support streaming output for large query results so MCP clients and programmatic consumers can process incrementally. | Embeddability | Large codebases don't blow up agent context windows; consumers process results as they arrive instead of waiting for the full payload | ✓ | ✓ | 4 | No |
| 5 | TF-IDF lightweight search | SQLite FTS5 + TF-IDF as a middle tier (~50MB) between "no search" and full transformer embeddings (~500MB). Provides decent keyword search with near-zero overhead. Inspired by codexray. | Search | Users get useful search without the 500MB embedding model download; faster startup for small projects | ✓ | ✓ | 3 | No |
| 13 | Architecture boundary rules | User-defined rules for allowed/forbidden dependencies between modules (e.g., "controllers must not import from other controllers"). Violations flagged in `diff-impact` and CI. Inspired by codegraph-rust, stratify. | Architecture | Prevents architectural decay in CI; agents are warned before introducing forbidden cross-module dependencies | ✓ | ✓ | 3 | No |
| 15 | Hybrid BM25 + semantic search | Combine BM25 keyword matching with embedding-based semantic search using Reciprocal Rank Fusion. Better recall than either approach alone. Inspired by GitNexus, claude-context-local. | Search | Search results improve dramatically — keyword matches catch exact names, embeddings catch conceptual matches, RRF merges both | ✓ | ✓ | 3 | No |
| 18 | CODEOWNERS integration | Map graph nodes to CODEOWNERS entries. Show who owns each function, surface ownership boundaries in `diff-impact`. Inspired by CKB. | Developer Experience | `diff-impact` tells agents which teams to notify; ownership-aware impact analysis reduces missed reviews | ✓ | ✓ | 3 | No |
| 6 | Formal code health metrics | Cyclomatic complexity, Maintainability Index, and Halstead metrics per function — we already parse the AST, the data is there. Inspired by code-health-meter (published in ACM TOSEM 2025). | Analysis | Agents can prioritize refactoring targets; `hotspots` becomes richer with quantitative health scores per function | ✓ | ✓ | 2 | No |
| 7 | OWASP/CWE pattern detection | Security pattern scanning on the existing AST — hardcoded secrets, SQL injection patterns, eval usage, XSS sinks. Lightweight static rules, not full taint analysis. Inspired by narsil-mcp, CKB. | Security | Catches low-hanging security issues during `diff-impact`; agents can flag risky patterns before they're committed | ✓ | ✓ | 2 | No |
| 11 | Community detection | Leiden/Louvain algorithm to discover natural module boundaries vs actual file organization. Reveals which symbols are tightly coupled and whether the directory structure matches. Inspired by axon, GitNexus, CodeGraphMCPServer. | Intelligence | Surfaces architectural drift — when directory structure no longer matches actual dependency clusters; guides refactoring | ✓ | ✓ | 2 | No |

Breaking (penalized to end of tier):

| ID | Title | Description | Category | Benefit | Zero-dep | Foundation-aligned | Problem-fit (1-5) | Breaking |
|----|-------|-------------|----------|---------|----------|-------------------|-------------------|----------|
| 14 | Dataflow analysis | Define/use chains and flows_to/returns/mutates edge types. Tracks how data moves through functions, not just call relationships. Major analysis depth increase. Inspired by codegraph-rust. | Analysis | Enables taint-like analysis, more precise impact analysis, and answers "where does this value end up?" | ✓ | ✓ | 5 | Yes |

### Tier 2 — Foundation-aligned, needs dependencies

Ordered by problem-fit:

| ID | Title | Description | Category | Benefit | Zero-dep | Foundation-aligned | Problem-fit (1-5) | Breaking |
|----|-------|-------------|----------|---------|----------|-------------------|-------------------|----------|
| 3 | Token counting on responses | Add tiktoken-based token counts to CLI and MCP responses so agents know how much context budget each query consumed. Inspired by glimpse, arbor. | Developer Experience | Agents and users can budget context windows; enables smarter multi-query strategies without blowing context limits | ✗ | ✓ | 3 | No |
| 8 | Optional LLM provider integration | Bring-your-own provider (OpenAI, Anthropic, Ollama, etc.) for richer embeddings and AI-powered search. Enhancement layer only — core graph never depends on it. Inspired by code-graph-rag, autodev-codebase. | Search | Semantic search quality jumps significantly with provider embeddings; users who already pay for an LLM get better results at no extra cost | ✗ | ✓ | 3 | No |

### Tier 3 — Not foundation-aligned (needs deliberate exception)

Ordered by problem-fit:

| ID | Title | Description | Category | Benefit | Zero-dep | Foundation-aligned | Problem-fit (1-5) | Breaking |
|----|-------|-------------|----------|---------|----------|-------------------|-------------------|----------|
| 19 | Auto-generated context files | Generate structural summaries (AGENTS.md, CLAUDE.md sections) from the graph — module descriptions, key entry points, architecture overview. Inspired by GitNexus. | Intelligence | New contributors and AI agents get an always-current project overview without manual documentation effort | ✓ | ✗ | 3 | No |
| 17 | Multi-file coordinated rename | Rename a symbol across all call sites, validated against the graph structure. Inspired by GitNexus. | Refactoring | Safe renames without relying on LSP or IDE — works in CI, agent loops, and headless environments | ✓ | ✗ | 2 | No |
| 10 | Interactive HTML visualization | `codegraph viz` opens an interactive force-directed graph in the browser (vis.js or Cytoscape.js). Zoom, pan, filter by module, click to inspect. Inspired by autodev-codebase, CodeVisualizer. | Visualization | Developers and teams can visually explore architecture; useful for onboarding, code reviews, and spotting structural problems | ✗ | ✗ | 1 | No |

---

## Scoring Guide

When filling in the assessment columns during a prioritization session:

**Zero-dep checklist:**
- Does it use only tree-sitter AST data we already extract? → likely zero-dep
- Does it need a new npm package at runtime? → not zero-dep
- Does it need git CLI access? → acceptable (git is already assumed)
- Does it need a new WASM module or native addon? → not zero-dep

**Foundation alignment red flags:**
- Adds a cloud API call to the core pipeline → violates P1 and P4
- Requires Docker, external DB, or non-npm toolchain → violates zero-infrastructure goal
- Generates code, edits files, or makes decisions → violates P8 (we're not an agent)
- Breaks programmatic API contract → check against P5 (embeddable-first)

**Problem-fit rubric:**
- **5** — Directly reduces token waste, prevents hallucinated dependencies, or catches blast-radius breakage
- **4** — Improves agent accuracy or reduces round-trips for common tasks
- **3** — Useful for developers and agents but doesn't address the core "lost AI" problem
- **2** — Nice-to-have; improves the tool but tangential to the stated problem
- **1** — Cool feature, but doesn't help AI agents navigate codebases better
