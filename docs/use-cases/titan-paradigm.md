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

Use `communities` to discover natural module boundaries and identify architectural drift — where the directory structure no longer matches actual dependency clusters:

```bash
# Discover natural module boundaries via Louvain clustering
codegraph communities -T

# Drift analysis: which directories should be split or merged?
codegraph communities --drift -T
```

Or skip the manual synthesis entirely — `triage` merges connectivity, hotspots, roles, and complexity into a single ranked priority queue:

```bash
# One call — the orchestrating agent gets a ranked audit queue
codegraph triage -T --limit 50 --json > recon-priority.json
```

The `--json` flag on every command makes it trivial to feed results into a state file or orchestration script.

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

The Gauntlet needs each sub-agent to understand what a file does, what depends on it, and how risky changes are. The `audit` command gives each agent everything in one call:

```bash
# One call per file — explain + impact + complexity in one structured report
codegraph audit src/parser.js -T

# Or audit a single function
codegraph audit wasmExtractSymbols -T
```

For a swarm of 20+ sub-agents auditing different files, `batch` returns all results in one JSON payload:

```bash
# Orchestrator sends one request, gets audit results for all targets
codegraph batch src/parser.js src/builder.js src/queries.js -T --json > audit-results.json
```

For deeper analysis, individual commands are still available:

```bash
# Per-function complexity metrics — cognitive, cyclomatic, nesting, MI
codegraph complexity --file src/parser.js -T

# Full Halstead health view — volume, effort, estimated bugs, MI
codegraph complexity --file src/parser.js --health -T

# Pass/fail rule check — does this file meet the manifesto?
codegraph manifesto -T

# Architecture boundary violations — are cross-module dependencies allowed?
codegraph manifesto -T  # boundaries are enforced as manifesto rules
```

When a sub-agent decides a function needs decomposition (complexity > 7, nesting > 3, 10+ mocks), it needs to know what breaks. `fn-impact` gives the complete blast radius **before** the agent writes a single line of code.

The `--json` flag lets the orchestrator aggregate results across all sub-agents:

```bash
# Each sub-agent reports its audit findings as JSON
codegraph audit parseConfig -T --json > audit/parser.json
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

The State Machine phase needs yes/no answers: "Did this change introduce a cycle?" "Did blast radius exceed N?" "Did any boundary get violated?" The `check` command provides exactly this:

```bash
# Exit code 0 = pass, 1 = fail — perfect for CI gates and rollback triggers
codegraph check --staged --no-new-cycles --max-blast-radius 20 --max-complexity 30

# Also enforce architecture boundary rules
codegraph check --staged --no-boundary-violations

# Or combine all predicates in one call
codegraph check --staged --no-new-cycles --max-blast-radius 20 --no-boundary-violations -T
```

For detailed impact analysis, `diff-impact` provides the full picture:

```bash
# Which functions changed, which callers are affected, full blast radius
codegraph diff-impact --staged -T

# Compare current branch against main to see cumulative impact
codegraph diff-impact main -T

# Visual blast radius as a Mermaid diagram
codegraph diff-impact --staged --format mermaid -T

# JSON for the state machine to parse and validate
codegraph diff-impact --staged -T --json > state/impact-check.json
```

Use `snapshot` to checkpoint before each refactoring pass and instantly rollback without rebuilding:

```bash
# Checkpoint before the Gauntlet starts
codegraph snapshot save pre-gauntlet

# ... agents make changes ...

# If something goes wrong — instant rollback without rebuilding
codegraph snapshot restore pre-gauntlet
```

Use `manifesto` as an additional CI gate — it exits with code 1 when any function exceeds a fail-level threshold:

```bash
# Pass/fail rule check — exit code 1 = fail → rollback trigger
codegraph manifesto -T
```

The orchestrator can gate every commit: run `check --staged` for pass/fail validation, `diff-impact --staged --json` for detailed blast radius, and `manifesto -T` to verify code health rules. Auto-rollback if any exceeds thresholds. Combined with `codegraph watch` for real-time graph updates, the state machine always has a current picture of the codebase.

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
| **Formal code health metrics** ([Backlog #6](../../roadmap/BACKLOG.md)) | **Done** | `codegraph complexity` provides cognitive, cyclomatic, nesting depth, Halstead (volume, effort, bugs), and Maintainability Index per function. `--health` for full view, `--sort mi` to rank by MI, `--above-threshold` for flagged functions. Maps directly to the Gauntlet's "complexity > 7 is a failure" rule. PR #130 + #139 |
| **Manifesto-driven pass/fail** ([Backlog #22](../../roadmap/BACKLOG.md)) | **Done** | `codegraph manifesto` with 9 configurable rules and warn/fail thresholds. Exit code 1 on fail — the Gauntlet gets first-class pass/fail signals without parsing JSON. PR #138 |
| **Community detection** ([Backlog #11](../../roadmap/BACKLOG.md)) | **Done** | `codegraph communities` with Louvain algorithm discovers natural module boundaries vs actual file organization. `--drift` reveals which directories should be split or merged. `--functions` for function-level clustering. PR #133/#134 |
| **Build-time semantic metadata** ([Roadmap Phase 4.4](../../roadmap/ROADMAP.md#44--build-time-semantic-metadata)) | Planned | LLM-generated `complexity_notes`, `risk_score`, and `side_effects` per function. A sub-agent could query `codegraph assess <name>` and get "3 responsibilities, low cohesion — consider splitting" without analyzing the code itself |

### For GLOBAL SYNC

| Feature | Status | How it helps |
|---------|--------|-------------|
| **Architecture boundary rules** ([Backlog #13](../../roadmap/BACKLOG.md)) | **Done** | `manifesto.boundaries` config defines allowed/forbidden dependencies between modules. Onion architecture preset available via `manifesto.boundaryPreset: "onion"`. Violations flagged in `manifesto` and enforceable via `check --no-boundary-violations`. PR #228 + #229 |
| **CODEOWNERS integration** ([Backlog #18](../../roadmap/BACKLOG.md)) | **Done** | `codegraph owners` maps graph nodes to CODEOWNERS entries. Shows who owns each function, surfaces ownership boundaries in `diff-impact`. The GLOBAL SYNC agent can identify which teams need to coordinate. PR #195 |
| **Refactoring analysis** ([Roadmap Phase 8.5](../../roadmap/ROADMAP.md#85--refactoring-analysis)) | Planned | `split_analysis`, `extraction_candidates`, `boundary_analysis` — LLM-powered structural analysis that identifies exactly where shared abstractions should be created |
| **Dead code detection** ([Backlog #1](../../roadmap/BACKLOG.md)) | **Done** | `codegraph roles --role dead -T` lists all symbols with zero fan-in that aren't exported. Delivered as part of node classification |

### For STATE MACHINE

| Feature | Status | How it helps |
|---------|--------|-------------|
| **Change validation predicates** ([Backlog #30](../../roadmap/BACKLOG.md)) | **Done** | `codegraph check --staged --no-new-cycles --max-blast-radius N --no-boundary-violations` with exit code 0/1. The STATE MACHINE gets first-class pass/fail signals without parsing JSON. PR #225 + #230 |
| **Graph snapshots** ([Backlog #31](../../roadmap/BACKLOG.md)) | **Done** | `codegraph snapshot save/restore` for instant DB backup and rollback. Orchestrators checkpoint before each refactoring pass and restore on failure without rebuilding. PR #192 |
| **Branch structural diff** ([Backlog #16](../../roadmap/BACKLOG.md)) | **Done** | `codegraph branch-compare main feature-branch` compares code structure between two refs — added/removed/changed symbols with transitive caller impact. PR in v2.5.1 |
| **Streaming / chunked results** ([Backlog #20](../../roadmap/BACKLOG.md)) | **Done** | Universal pagination on all 30 MCP tools, NDJSON streaming on CLI commands, generator APIs for memory-efficient iteration. PR #207 |
| **GitHub Action + CI integration** ([Roadmap Phase 7](../../roadmap/ROADMAP.md#phase-7--github-integration--ci)) | Planned | Reusable GitHub Action that runs `diff-impact` on every PR, posts visual impact graphs, and fails if thresholds are exceeded — the STATE MACHINE becomes a CI gate |

---

## What's Next

All six recommendations from v2.5.0 — `audit`, `batch`, `triage`, `check`, `snapshot`, and MCP orchestration tools — shipped in v2.6.0. The remaining enhancements that would make codegraph even more powerful for the Titan Paradigm are in the LLM integration roadmap:

### LLM-enhanced features (Roadmap Phase 4+)

| Feature | How it helps the Titan Paradigm |
|---------|-------------------------------|
| **Build-time semantic metadata** ([Phase 4.4](../../roadmap/ROADMAP.md#44--build-time-semantic-metadata)) | LLM-generated `risk_score`, `complexity_notes`, and `side_effects` per function. The `audit` command could include "3 responsibilities — split validation from persistence from notification" instead of just numbers |
| **Module summaries** ([Phase 4.5](../../roadmap/ROADMAP.md#45--module-summaries)) | File-level narratives alongside function-level metrics in `batch` output, so Gauntlet sub-agents understand the module's role before diving in |
| **`ask_codebase`** ([Phase 5.3](../../roadmap/ROADMAP.md#53--mcp-integration)) | Natural-language queries over the graph via MCP. The RECON agent asks "what are the riskiest files?" and gets a ranked answer |
| **Refactoring analysis** ([Phase 8.5](../../roadmap/ROADMAP.md#85--refactoring-analysis)) | `split_analysis`, `extraction_candidates`, `boundary_analysis` — identifies exactly where shared abstractions should be created for GLOBAL SYNC |

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
codegraph triage -T --limit 50 --json   # Ranked priority queue (one call)
codegraph stats --json                   # Health baseline
```

Feed the results to your sub-agents with `codegraph batch` and `codegraph audit`, and gate every commit through `codegraph check --staged`.

For the full agent integration guide, see [AI Agent Guide](../ai-agent-guide.md). For MCP server setup, see [MCP Examples](../examples/MCP.md).
