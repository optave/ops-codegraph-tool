# Use Case: The Titan Paradigm — Autonomous Codebase Cleanup

> How codegraph powers the RECON, GAUNTLET, GLOBAL SYNC, and STATE MACHINE phases of multi-agent codebase refactoring.

---

## The Problem

In a [LinkedIn post](https://www.linkedin.com/posts/johannesr314_claude-vibecoding-activity-7432157088828678144-CiI_), **Johannes R.**, Senior Software Engineer at Google, described the #1 challenge of "vibe coding": keeping a fast-moving codebase from rotting.

His answer isn't a better prompt. It's a different architecture.

He calls it the **Titan Paradigm** — moving from a single chat to an autonomous multi-agent orchestration. It is, in his words, *"the only way I've found to fully autonomously get a massive codebase into Google-standard shape."*

### The architecture

| Phase | What it does |
|-------|-------------|
| **RECON** | One agent maps the dependency graph. It identifies "high-traffic" files and audits them first to prevent logic drift downstream |
| **THE GAUNTLET** | A swarm of sub-agents audits every file against a strict manifesto. Complexity > 7 is a failure. Nesting > 3 is a failure. If it needs 10+ mocks to test, it gets decomposed |
| **GLOBAL SYNC** | A lead agent identifies overlapping fixes across the repo to build shared abstractions before the swarm starts coding |
| **STATE MACHINE** | Everything is tracked in a JSON state file. If a change breaks the build or fails a linter, the system auto-rolls back. Your intent survives even if the session resets |

The insight is powerful: a single AI agent chatting with you cannot maintain a large codebase. You need **structure** — a dependency-aware orchestration layer that tells agents *where* to look, *what* to prioritize, and *what breaks* when they change things.

That's exactly what codegraph provides.

---

## How Codegraph Helps — Today

### RECON: Map the dependency graph, prioritize high-traffic files

This is codegraph's bread and butter. The RECON phase needs a dependency graph — codegraph **is** a dependency graph.

```bash
# Build the graph (sub-second incremental rebuilds after the first run)
codegraph build .

# Identify high-traffic files — most-connected modules, ranked
codegraph map --limit 30 --no-tests

# Find structural hotspots — extreme fan-in, fan-out, coupling
codegraph hotspots --no-tests

# Graph health overview — node/edge counts, quality score
codegraph stats
```

An orchestrating agent can use `map` and `hotspots` to build a priority queue: audit the most-connected files first, because changes there have the highest blast radius. The `--json` flag on every command makes it trivial to feed results into a state file or orchestration script.

```bash
# JSON output for programmatic consumption
codegraph map --limit 50 --no-tests --json > recon-priority.json
codegraph hotspots --no-tests --json >> recon-priority.json
```

For deeper structural understanding before touching anything:

```bash
# Structural summary of a high-traffic file — public API, internals, data flow
codegraph explain src/builder.js

# Understand a specific function before auditing it
codegraph context buildGraph -T

# Where is a symbol defined and who uses it?
codegraph where resolveImports
```

### THE GAUNTLET: Audit every file against strict standards

The Gauntlet needs each sub-agent to understand what a file does, what depends on it, and how risky changes are. Codegraph gives each agent full context without burning tokens on `grep`/`find`/`cat`:

```bash
# For each file the sub-agent is auditing:

# 1. What does this file export, import, and contain?
codegraph explain src/parser.js

# 2. For each function that might need decomposition:
#    Full context — source, deps, callers, signature
codegraph context wasmExtractSymbols -T

# 3. How many callers? What's the blast radius if we refactor?
codegraph fn-impact wasmExtractSymbols -T

# 4. What's the full call chain?
codegraph fn wasmExtractSymbols -T --depth 5
```

When a sub-agent decides a function needs decomposition (complexity > 7, nesting > 3, 10+ mocks), it needs to know what breaks. `fn-impact` gives the complete blast radius **before** the agent writes a single line of code.

The `--json` flag lets the orchestrator aggregate results across all sub-agents:

```bash
# Each sub-agent reports its audit findings as JSON
codegraph fn-impact parseConfig -T --json > audit/parser.json
```

### GLOBAL SYNC: Identify overlapping fixes, build shared abstractions

Before the swarm starts coding, a lead agent needs to see the big picture: which files are tightly coupled, where circular dependencies exist, and what shared abstractions could be extracted.

```bash
# Detect circular dependencies — these are prime candidates for abstraction
codegraph cycles
codegraph cycles --functions  # Function-level cycles

# Find how two symbols are connected — reveals shared dependencies
codegraph path parseConfig loadConfig -T
codegraph path buildGraph resolveImports -T

# File-level dependency map — what does this file import and what imports it?
codegraph deps src/builder.js

# Semantic search to find related code across the codebase
codegraph search "config loading; settings parsing; env resolution"

# Directory-level cohesion — which directories are well-organized vs tangled?
codegraph structure
```

The lead agent can use `cycles` to identify dependency knots, `path` to understand how modules relate, and `structure` to assess directory cohesion. This analysis informs which shared abstractions to build before individual agents start their refactoring work.

### STATE MACHINE: Track changes, verify impact, enable rollback

The State Machine phase needs to validate that every change is safe. Codegraph's `diff-impact` is purpose-built for this:

```bash
# After a sub-agent makes changes and stages them:
codegraph diff-impact --staged -T

# Output: which functions changed, which callers are affected,
# full transitive blast radius — all in one call

# Compare current branch against main to see cumulative impact
codegraph diff-impact main -T

# Visual blast radius as a Mermaid diagram
codegraph diff-impact --staged --format mermaid -T

# JSON for the state machine to parse and validate
codegraph diff-impact --staged -T --json > state/impact-check.json
```

The orchestrator can gate every commit: run `diff-impact --staged --json`, check that the blast radius is within acceptable bounds, and auto-rollback if it exceeds thresholds. Combined with `codegraph watch` for real-time graph updates, the state machine always has a current picture of the codebase.

```bash
# Watch mode — graph updates automatically as agents edit files
codegraph watch .

# After rollback, verify the graph is back to expected state
codegraph stats --json
```

---

## What's on the Roadmap

Several planned features would make codegraph even more powerful for the Titan Paradigm. These are tracked in the [roadmap](../../roadmap/ROADMAP.md) and [backlog](../../roadmap/BACKLOG.md):

### For RECON

| Feature | Status | How it helps |
|---------|--------|-------------|
| **Node classification** ([Backlog #4](../../roadmap/BACKLOG.md)) | **Done** | Auto-tags every symbol as Entry Point, Core, Utility, or Adapter based on fan-in/fan-out. Available via `codegraph roles`, `where`, `explain`, `context`, and the `node_roles` MCP tool |
| **Git change coupling** ([Backlog #9](../../roadmap/BACKLOG.md)) | **Done** | `codegraph co-change` analyzes git history for files that always change together. Integrated into `diff-impact` output via `historicallyCoupled` section. MCP tool `co_changes` |

### For THE GAUNTLET

| Feature | Status | How it helps |
|---------|--------|-------------|
| **Formal code health metrics** ([Backlog #6](../../roadmap/BACKLOG.md)) | Planned | Cyclomatic complexity, Maintainability Index, and Halstead metrics per function — directly maps to the Gauntlet's "complexity > 7 is a failure" rule. Computed from the AST we already parse |
| **Build-time semantic metadata** ([Roadmap Phase 4.4](../../roadmap/ROADMAP.md#44--build-time-semantic-metadata)) | Planned | LLM-generated `complexity_notes`, `risk_score`, and `side_effects` per function. A sub-agent could query `codegraph assess <name>` and get "3 responsibilities, low cohesion — consider splitting" without analyzing the code itself |
| **Community detection** ([Backlog #11](../../roadmap/BACKLOG.md)) | Planned | Leiden/Louvain algorithm to discover natural module boundaries vs actual file organization. Reveals which functions are tightly coupled and whether decomposition should follow the directory structure or propose a new one |

### For GLOBAL SYNC

| Feature | Status | How it helps |
|---------|--------|-------------|
| **Architecture boundary rules** ([Backlog #13](../../roadmap/BACKLOG.md)) | Planned | User-defined rules for allowed/forbidden dependencies between modules (e.g., "controllers must not import from other controllers"). The GLOBAL SYNC agent can enforce architectural standards automatically |
| **Refactoring analysis** ([Roadmap Phase 8.5](../../roadmap/ROADMAP.md#85--refactoring-analysis)) | Planned | `split_analysis`, `extraction_candidates`, `boundary_analysis` — LLM-powered structural analysis that identifies exactly where shared abstractions should be created |
| **Dead code detection** ([Backlog #1](../../roadmap/BACKLOG.md)) | **Done** | `codegraph roles --role dead -T` lists all symbols with zero fan-in that aren't exported. Delivered as part of node classification |

### For STATE MACHINE

| Feature | Status | How it helps |
|---------|--------|-------------|
| **Branch structural diff** ([Backlog #16](../../roadmap/BACKLOG.md)) | Planned | Compare code structure between two branches using git worktrees. Shows added/removed/changed symbols and their impact — perfect for validating that a refactoring branch hasn't broken the structural contract |
| **GitHub Action + CI integration** ([Roadmap Phase 7](../../roadmap/ROADMAP.md#phase-7--github-integration--ci)) | Planned | Reusable GitHub Action that runs `diff-impact` on every PR, posts visual impact graphs, and fails if thresholds are exceeded — the STATE MACHINE becomes a CI gate |
| **Streaming / chunked results** ([Backlog #20](../../roadmap/BACKLOG.md)) | Planned | Large codebases don't blow up agent context windows; consumers process results as they arrive instead of waiting for the full payload |

---

## Recommendations: Making Codegraph Even Better for This Use Case

The features above cover what codegraph can do today and what's already planned. Beyond those, the Titan Paradigm points to a class of enhancements that would naturally follow the [LLM integration work](../../roadmap/ROADMAP.md#phase-4--intelligent-embeddings) (Roadmap Phase 4) — combining codegraph's structural graph with LLM intelligence to serve multi-agent orchestration directly.

### 1. `codegraph audit` — one-call file assessment

Once [build-time semantic metadata](../../roadmap/ROADMAP.md#44--build-time-semantic-metadata) (Phase 4.4) lands, codegraph will have `risk_score`, `complexity_notes`, and `side_effects` per function. A natural next step is a single `audit` command that combines these with `explain` and `fn-impact` into one structured report — exactly what each Gauntlet sub-agent needs.

```bash
# One call per file, everything a sub-agent needs to decide pass/fail
codegraph audit src/parser.js --json
# → { functions: [{ name, complexity, nesting_depth, fan_in, fan_out,
#      risk_score, side_effects, callers_count, decomposition_hint }] }
```

With LLM-generated `complexity_notes`, the `decomposition_hint` could go beyond numbers ("complexity > 7") to actionable guidance ("3 responsibilities — split validation from persistence from notification").

### 2. Batch querying for swarm agents

Today, each query is a separate CLI invocation. For a swarm of 20+ sub-agents each auditing different files, a batch mode that accepts a list of targets and returns all results in one JSON payload would dramatically reduce overhead.

```bash
# Orchestrator sends one request, gets audit results for all targets
codegraph audit --batch targets.json --json > audit-results.json
```

This becomes especially powerful after [module summaries](../../roadmap/ROADMAP.md#45--module-summaries) (Phase 4.5) — the batch output can include file-level narratives alongside function-level metrics, so sub-agents understand the module's role before diving into individual functions.

### 3. `codegraph triage` — orchestrator-friendly priority queue

`map` and `hotspots` give ranked lists, but the Titan Paradigm needs a single prioritized audit queue. After LLM integration, codegraph could combine graph centrality, `risk_score`, [git change coupling](../../roadmap/BACKLOG.md) (Backlog #9), and LLM-assessed complexity into one ranked list:

```bash
codegraph triage --limit 50 -T --json
# → Ranked list: highest-risk, most-connected, most-churned files first
# → Each entry includes: connectivity rank, risk_score, churn frequency,
#    coupling cluster, estimated refactoring complexity
```

This replaces the RECON agent's synthesis work with a single call.

### 4. `codegraph check` — change validation predicates

The STATE MACHINE needs yes/no answers: "Did this change introduce a cycle?" "Did blast radius exceed N?" "Did any public API signature change?" Today this requires parsing JSON output. First-class exit codes or a `check` command with configurable predicates would make the state machine trivially scriptable:

```bash
# Exit code 1 if any predicate fails — perfect for CI gates and rollback triggers
codegraph check --staged --no-new-cycles --max-blast-radius 20 --no-signature-changes
```

After [architecture boundary rules](../../roadmap/BACKLOG.md) (Backlog #13), this could also enforce "no new cross-boundary violations."

### 5. Session-aware graph snapshots

The STATE MACHINE tracks state across agent sessions. If codegraph could snapshot and restore graph states (lightweight — just the SQLite DB), the orchestrator could take a snapshot before each refactoring pass and restore on rollback, without rebuilding:

```bash
codegraph snapshot save pre-gauntlet
# ... agents make changes ...
codegraph snapshot restore pre-gauntlet   # instant rollback
```

After LLM integration, snapshots would also preserve embeddings, descriptions, and semantic metadata — so rolling back doesn't require re-running expensive LLM calls.

### 6. MCP-native orchestration

The Titan Paradigm's agents could run entirely through codegraph's [MCP server](../examples/MCP.md) instead of shelling out to the CLI. With 21 tools already exposed, the main gap is the `audit`/`triage`/`check` commands described above. After Phase 4, adding these as MCP tools — alongside [`ask_codebase`](../../roadmap/ROADMAP.md#53--mcp-integration) (Phase 5.3) for natural-language queries — would let orchestrators like Claude Code's agent teams query the graph with zero CLI overhead. The RECON agent asks the MCP server "what are the riskiest files?", each Gauntlet agent asks "should this function be decomposed?", and the STATE MACHINE asks "is this change safe?" — all through the same protocol.

---

## Getting Started

To try the Titan Paradigm with codegraph today:

```bash
npm install -g @optave/codegraph
cd your-project
codegraph build
```

Then wire your orchestrator's RECON phase to start with:

```bash
codegraph map --limit 50 -T --json      # Priority queue
codegraph hotspots -T --json             # Risk signals
codegraph stats --json                   # Health baseline
```

Feed the results to your sub-agents, give each one `codegraph context` and `codegraph fn-impact`, and gate every commit through `codegraph diff-impact --staged --json`.

For the full agent integration guide, see [AI Agent Guide](../ai-agent-guide.md). For MCP server setup, see [MCP Examples](../examples/MCP.md).
