# Claude Code Skills for Codegraph

> **Experimental — agent-oriented extensions.** These skills are outside codegraph's core scope as a code intelligence engine. They orchestrate multi-step workflows that make decisions, modify code, and run automated pipelines — capabilities that go beyond codegraph's primary role of exposing dependency data to AI agents via MCP. Use them as reference implementations and starting points, not as production-grade automation. They may produce incorrect changes, miss edge cases, or behave unexpectedly on codebases with unusual structures. Always review their output before committing.

This directory contains example [Claude Code skills](https://docs.anthropic.com/en/docs/claude-code/skills) that use codegraph to power autonomous codebase cleanup — based on the [Titan Paradigm](../../use-cases/titan-paradigm.md).

## The Problem: Context Window Explosion

A single AI agent cannot hold an entire large codebase in context. The Titan Paradigm solves this with a phased approach where each phase:

1. Runs targeted codegraph queries (not raw file reads)
2. Writes structured **artifacts** to `.codegraph/titan/`
3. Next phase reads only those artifacts — not the original sources

```
/titan-recon → titan-state.json + GLOBAL_ARCH.md
      │
      ▼
/titan-gauntlet → gauntlet.ndjson (batches of 5, resumes across sessions)
      │
      ▼
/titan-sync → sync.json (execution plan)
      │
      ▼
/titan-forge → executes sync.json (one phase per invocation, resumable)
      │  ├─ codegraph context/fn-impact before each change
      │  ├─ /titan-gate validates each commit
      │  └─ advances titan-state.json
      │
      ▼
/titan-gate (validates each commit: codegraph + lint/build/test)

/titan-reset (escape hatch: clean up everything)
```

## Skills

| Skill | Phase | What it does | Key artifact |
|-------|-------|-------------|-------------|
| `/titan-recon` | RECON | Builds graph + embeddings, complexity health baseline, domains, priority queue, work batches, `GLOBAL_ARCH.md`, baseline snapshot | `titan-state.json` |
| `/titan-gauntlet` | GAUNTLET | 4-pillar audit (17 rules) using full codegraph metrics (`cognitive`, `cyclomatic`, `halstead.bugs`, `halstead.effort`, `mi`, `loc.sloc`). Batches of 5, NDJSON writes, session resume | `gauntlet.ndjson` |
| `/titan-sync` | GLOBAL SYNC | Dependency clusters, code ownership, shared abstractions, ordered execution plan with logical commits | `sync.json` |
| `/titan-forge` | FORGE | Executes `sync.json` one phase at a time — makes code changes, validates with `/titan-gate`, commits, tracks progress. Resumable across sessions | `titan-state.json` (execution block) |
| `/titan-gate` | STATE MACHINE | `codegraph check --staged --cycles --blast-radius 30 --boundaries` + lint/build/test. Snapshot restore on failure | `gate-log.ndjson` |
| `/titan-reset` | ESCAPE HATCH | Restores baseline snapshot, deletes all artifacts and snapshots, rebuilds graph | — |

## Installation

Copy the skill directories into your project's `.claude/skills/` directory:

```bash
# From your project root (assuming codegraph is installed)
mkdir -p .claude/skills
cp -r node_modules/@optave/codegraph/docs/examples/claude-code-skills/titan-* .claude/skills/
```

Then install codegraph if you haven't:

```bash
npm install -g @optave/codegraph
codegraph build .
```

## Usage

### Full pipeline

```
/titan-recon           # Map the codebase, produce priority queue + embeddings
/titan-gauntlet 5      # Audit top targets in batches of 5
/titan-sync            # Plan shared abstractions and execution order
/titan-forge            # Execute next phase (re-run for each phase)
                       # (calls /titan-gate automatically per commit)
```

If GAUNTLET runs out of context, just re-invoke `/titan-gauntlet` — it resumes from the next pending batch.

### Standalone phases

- `/titan-recon` always works standalone (builds graph fresh)
- `/titan-gauntlet` falls back to `codegraph triage` if no RECON artifact exists
- `/titan-sync` requires GAUNTLET artifacts (warns if missing)
- `/titan-forge` requires SYNC artifacts (`sync.json`); supports `--phase N`, `--target <name>`, `--dry-run`
- `/titan-gate` works with or without prior artifacts (uses default thresholds)
- `/titan-reset` cleans up everything — use when you want to start over

### Iterative workflow

```
/titan-recon              # Once: map the codebase
/titan-gauntlet           # Once (or multiple sessions): audit everything
/titan-sync               # Once: plan the work

# Then for each phase:
/titan-forge               # Executes one phase, validates, commits
/titan-forge               # Re-run for next phase
/titan-forge               # ...until all phases complete
```

## Artifacts

All artifacts are written to `.codegraph/titan/` (6 files, no redundancy):

| File | Format | Written by | Read by |
|------|--------|-----------|---------|
| `titan-state.json` | JSON | RECON (init), ALL (update) | ALL |
| `GLOBAL_ARCH.md` | Markdown | RECON | GAUNTLET, SYNC |
| `gauntlet.ndjson` | NDJSON | GAUNTLET | SYNC |
| `gauntlet-summary.json` | JSON | GAUNTLET | SYNC, GATE |
| `sync.json` | JSON | SYNC | FORGE, GATE |
| `gate-log.ndjson` | NDJSON | GATE | Audit trail |

NDJSON format (one JSON object per line) means partial results survive crashes mid-batch.

**Tip:** Add `.codegraph/titan/` to `.gitignore` — these are ephemeral analysis artifacts, not source code.

## Snapshots

Codegraph snapshots provide instant graph database backup/restore:

| Snapshot | Created by | Restored by | Deleted by |
|----------|-----------|------------|-----------|
| `titan-baseline` | RECON | GATE (on failure) | GATE (final success) or RESET |
| `titan-batch-N` | GAUNTLET (per batch) | GATE (on failure) | GAUNTLET (next batch) or RESET |

## Context Window Management

1. **JSON over tables.** All codegraph commands use `--json` for compact output.
2. **Batch processing with resume.** GAUNTLET processes 5 targets at a time (configurable), writes to NDJSON, stops at ~80% context. Re-invoking resumes automatically.
3. **Artifact bridging.** Each phase reads compact JSON artifacts, not raw source files.
4. **`codegraph batch <command>`** queries multiple targets in one call (e.g., `batch complexity t1 t2 t3`).
5. **`--above-threshold`** returns only functions exceeding thresholds — skip the noise.
6. **No-test filtering.** All commands use `-T` to exclude test files.

### Cross-session continuity

Run each `/titan-*` skill in a separate conversation if needed:
- Artifacts on disk bridge between conversations
- `titan-state.json` tracks progress, pending batches, and file audit status
- No context is lost because each phase's output is self-contained

## Customizing Thresholds

Edit the Rule 1 threshold table in `.claude/skills/titan-gauntlet/SKILL.md`:

```markdown
| Metric | Warn | Fail | Why |
|--------|------|------|-----|
| cognitive | > 15 | > 30 | How hard to understand |
| cyclomatic | > 10 | > 20 | How many paths to test |
| maxNesting | > 3 | > 5 | Flatten with guards |
| halstead.effort | > 5000 | > 15000 | Information-theoretic density |
| halstead.bugs | > 0.5 | > 1.0 | Estimated defect count |
| mi | < 50 | < 20 | Composite health |
| loc.sloc | > 50 | > 100 | Too long — split |
```

Adjust for your codebase — stricter for greenfield, more lenient for legacy code.

## Worktree Isolation

All skills enforce worktree isolation as their first step. If invoked from the main checkout, they stop and ask for `/worktree`. This prevents:

- Titan artifacts from polluting the main checkout
- Concurrent sessions from interfering
- Accidental commits of analysis artifacts

## Codegraph Commands Used

| Command | Used by | Purpose |
|---------|---------|---------|
| `codegraph build` | RECON | Build/refresh the dependency graph |
| `codegraph embed` | RECON | Generate embeddings for DRY detection |
| `codegraph stats` | RECON | Baseline metrics |
| `codegraph triage` | RECON, GAUNTLET (fallback) | Ranked priority queue |
| `codegraph map` | RECON | High-traffic files |
| `codegraph communities` | RECON | Module boundaries and drift |
| `codegraph roles` | RECON, GAUNTLET | Core/dead/entry symbol classification |
| `codegraph structure` | RECON | Directory cohesion |
| `codegraph complexity --health` | RECON, GAUNTLET, GATE, FORGE | Full metrics: cognitive, cyclomatic, nesting, Halstead, MI |
| `codegraph complexity --above-threshold` | RECON | Only functions exceeding thresholds |
| `codegraph batch complexity` | GAUNTLET | Multi-target complexity in one call |
| `codegraph batch context` | GAUNTLET | Multi-target context in one call |
| `codegraph check --staged --cycles --blast-radius --boundaries` | GATE | Full validation predicates |
| `codegraph ast --kind call\|await\|string` | GAUNTLET | AST pattern detection |
| `codegraph dataflow` | GAUNTLET | Data flow and mutation analysis |
| `codegraph exports` | GAUNTLET, FORGE | Per-symbol export consumers |
| `codegraph fn-impact` | GAUNTLET, SYNC, FORGE | Blast radius |
| `codegraph search` | GAUNTLET | Duplicate code detection (needs embeddings) |
| `codegraph co-change` | GAUNTLET, SYNC | Git history coupling |
| `codegraph path` | SYNC | Dependency paths between targets |
| `codegraph cycles` | SYNC, GATE | Circular dependency detection |
| `codegraph deps` | SYNC | File-level dependency map |
| `codegraph context` | SYNC, FORGE | Full function context |
| `codegraph owners` | SYNC | CODEOWNERS mapping for cross-team coordination |
| `codegraph branch-compare` | SYNC, GATE | Structural diff between refs |
| `codegraph diff-impact` | GATE | Impact of staged changes |
| `codegraph snapshot save\|restore\|delete` | RECON, GAUNTLET, GATE, RESET | Graph database backup/restore |

## Further Reading

- [Titan Paradigm Use Case](../../use-cases/titan-paradigm.md) — the full rationale and codegraph command mapping
- [AI Agent Guide](../../ai-agent-guide.md) — general guide for using codegraph with AI agents
- [MCP Examples](../MCP.md) — using codegraph via MCP for programmatic agent access
- [Claude Code Hooks](../claude-code-hooks/README.md) — automated hooks that complement these skills
