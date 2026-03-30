---
name: titan-recon
description: Map a codebase's dependency graph, identify hotspots, name logical domains, propose work batches, and produce a ranked priority queue for autonomous cleanup (Titan Paradigm Phase 1)
argument-hint: <path (default: .)>
allowed-tools: Bash, Read, Write, Glob, Grep, Edit
---

# Titan RECON — Codebase Reconnaissance

You are running the **RECON** phase of the Titan Paradigm on the target at `$ARGUMENTS` (default: `.`).

Your goal: map the dependency graph, identify structural hotspots, name logical domains, produce a global architecture document, propose work batches, and initialize the session state. Everything you produce feeds downstream phases (GAUNTLET, SYNC, GATE) via artifacts in `.codegraph/titan/`.

> **Context budget:** Every codegraph command MUST use `--json` to keep output compact. Never dump raw CLI tables into context — parse JSON and extract only what you need.

---

## Step 0 — Pre-flight: worktree and sync

1. **Check for worktree isolation:**
   ```bash
   git rev-parse --show-toplevel && git worktree list
   ```
   If you are NOT in a worktree, **stop:** "Run `/worktree` first. Titan phases write artifacts that should not interfere with other work."

2. **Sync with main:**
   ```bash
   git fetch origin main && git merge origin/main --no-edit
   ```
   If there are merge conflicts, stop and ask the user to resolve them.

3. **Record the main anchor SHA:**
   ```bash
   git rev-parse origin/main
   ```
   Store this as `mainSHA` in `titan-state.json`. All downstream phases use this to detect codebase drift — if main advances between phases, the drift detection mechanism (Step 0.5 in each phase) compares against this anchor to determine what's stale and what needs reassessment.

---

## Step 1 — Build the graph

```bash
codegraph build $ARGUMENTS
```

Record: file count, node count, edge count, engine.

---

## Step 2 — Generate embeddings (for DRY detection in GAUNTLET)

```bash
codegraph embed -m minilm
```

This enables `codegraph search` for duplicate code detection in downstream phases. If it fails (e.g., missing model), note it and continue — DRY checks will be grep-only.

---

## Step 3 — Collect baseline metrics

Run in parallel:

```bash
codegraph stats --json
codegraph structure --depth 2 --json
```

Extract from `stats`: `totalNodes`, `totalEdges`, `totalFiles`, `qualityScore`, `avgFanIn`, `avgFanOut`.

Extract from `structure`: top 10 directories by file count, directories with cohesion < 0.3 (tangled).

---

## Step 4 — Build the priority queue

```bash
codegraph triage -T --limit 100 --json
```

Risk-ranked list combining connectivity, complexity, and role classification. Truncate to top 50 for the artifact if >100 items.

---

## Step 5 — Community and drift analysis

```bash
codegraph communities -T --json
codegraph communities --drift -T --json
```

Extract: community count, top 5 largest (member count + key files), drift warnings.

---

## Step 6 — High-traffic files and role classification

```bash
codegraph map --limit 30 -T --json
codegraph roles --role core -T --json
codegraph roles --role dead -T --json
```

Count core symbols (high fan-in) and dead symbols (zero fan-in, not exported).

---

## Step 7 — Complexity health baseline

Get the full metrics picture across the codebase — this is what makes codegraph powerful:

```bash
codegraph complexity --health --above-threshold -T --json --limit 50
```

This returns only functions exceeding configured warn thresholds, with all available metrics per function:
- **Structural:** `cognitive`, `cyclomatic`, `maxNesting`
- **Halstead:** `volume`, `difficulty`, `effort`, `bugs` (estimated bug count)
- **Size:** `loc.sloc`, `loc.commentLines`
- **Composite:** `mi` (Maintainability Index)

Also get the worst offenders by different metrics:

```bash
codegraph complexity --health --sort effort -T --json --limit 10
codegraph complexity --health --sort bugs -T --json --limit 10
codegraph complexity --health --sort mi -T --json --limit 10
```

These three views reveal different quality dimensions: `effort` = hardest to understand, `bugs` = most likely to contain defects, `mi` = worst overall maintainability.

---

## Step 8 — Domain inventory

Using community detection (Step 5) and directory structure (Step 3), **name** the logical domains. A domain is a cohesive group of files serving a single concern.

For each domain, record:
- **Name:** use the codebase's own vocabulary (directory names, module names)
- **Root directories**
- **File count**
- **Key symbols:** 3-5 most-connected symbols (from triage)
- **Community IDs:** which communities map to this domain
- **Health:** cohesion score, drift warnings, cycle participation

For large domains, map inter-domain dependencies using key files (not directories — `deps` takes a file path):

```bash
codegraph deps <key-file-in-domain> --json
```

---

## Step 9 — Global architecture document

Write `.codegraph/titan/GLOBAL_ARCH.md`:

```markdown
# Global Architecture

**Date:** <today>
**Codebase:** <path> (<file count> files, <node count> symbols)

## Domain Map

| Domain | Root Dirs | Files | Core Symbols | Health |
|--------|-----------|-------|-------------|--------|
| ... | ... | ... | ... | cohesion, drift? |

## Dependency Flow

<High-level dependency direction between domains. Which are upstream vs downstream. Flag upward imports or layer violations.>

## Shared Types and Interfaces

<Symbols imported by 3+ domains — shared abstractions. Changes have cross-cutting impact.>

## Architectural Rules

<Inferred layering from dependency flow. Flag violations.>

## Cycles

<Module-level or function-level cycles, especially those crossing domain boundaries.>
```

---

## Step 10 — Propose work batches

Decompose the priority queue into **work batches** of **at most 5 files each**:
- **Hard limit: 5 files per batch.** If a domain has more than 5 files, split it into multiple batches (e.g., "domain-parser-1", "domain-parser-2"). This keeps each gauntlet iteration focused and prevents context overload in sub-agents.
- Stay within a single domain where possible
- Group tightly-coupled files together (from communities)
- Order by priority: highest-risk domains first
- Note dependencies: "batch N depends on batch M being done first"

---

## Step 11 — Save baseline snapshot

```bash
codegraph snapshot save titan-baseline
```

This is the rollback point. If anything goes wrong downstream, any skill can restore it.

---

## Step 12 — Write the state file

Create `.codegraph/titan/titan-state.json` — the single source of truth for the entire pipeline:

```bash
mkdir -p .codegraph/titan
```

```json
{
  "version": 1,
  "initialized": "<ISO 8601>",
  "lastUpdated": "<ISO 8601>",
  "target": "<resolved path>",
  "currentPhase": "recon",
  "mainSHA": "<git rev-parse origin/main>",
  "snapshots": {
    "baseline": "titan-baseline",
    "lastBatch": null
  },
  "embeddingsAvailable": true,
  "stats": {
    "totalFiles": 0,
    "totalNodes": 0,
    "totalEdges": 0,
    "qualityScore": 0,
    "avgFanIn": 0,
    "avgFanOut": 0
  },
  "healthBaseline": {
    "functionsAboveThreshold": 0,
    "worstByEffort": ["<top 5 symbol names>"],
    "worstByBugs": ["<top 5 symbol names>"],
    "worstByMI": ["<top 5 symbol names>"]
  },
  "domains": [
    {
      "name": "<domain name>",
      "rootDirs": ["<dir>"],
      "fileCount": 0,
      "status": "pending",
      "audited": 0,
      "passed": 0,
      "failed": 0
    }
  ],
  "batches": [
    {
      "id": 1,
      "domain": "<domain name>",
      "files": ["<file paths>"],
      "status": "pending",
      "dependsOn": [],
      "priority": 1
    }
  ],
  "priorityQueue": [
    {
      "rank": 1,
      "target": "<symbol or file>",
      "riskScore": 0,
      "reason": "<why>"
    }
  ],
  "communities": {
    "count": 0,
    "driftWarnings": []
  },
  "roles": {
    "coreCount": 0,
    "deadCount": 0,
    "deadSymbols": ["<all dead symbols>"]
  },
  "hotFiles": ["<top 30>"],
  "tangledDirs": ["<cohesion < 0.3>"],
  "fileAudits": {},
  "progress": {
    "totalFiles": 0,
    "audited": 0,
    "passed": 0,
    "warned": 0,
    "failed": 0,
    "fixed": 0
  }
}
```

---

## Step 13 — Report to user

Print a concise summary:
- Graph size and quality score
- Domains identified (count and names)
- Complexity health: count of functions above threshold, top 3 worst by `halstead.bugs`
- Work batches proposed (count)
- Top 5 priority targets
- Dead symbol count
- Drift warnings
- Path to artifacts: `.codegraph/titan/titan-state.json` and `.codegraph/titan/GLOBAL_ARCH.md`
- Next step: `/titan-gauntlet` to audit the priority queue

---

## Issue Tracking

Throughout this phase, if you encounter any of the following, append a JSON line to `.codegraph/titan/issues.ndjson`:

- **Codegraph bugs:** wrong output, crashes, missing features, unexpected behavior
- **Tooling issues:** problems with commands, WASM failures, embedding errors
- **Process suggestions:** ideas for improving the Titan workflow
- **Codebase observations:** structural concerns beyond what metrics capture

Format (one JSON object per line, append-only):

```json
{"phase": "recon", "timestamp": "<ISO 8601>", "severity": "bug|limitation|suggestion", "category": "codegraph|tooling|process|codebase", "description": "<what happened>", "context": "<command that triggered it, file involved, or other detail>"}
```

Log issues as they happen — don't batch them. The `/titan-close` phase compiles these into the final report.

---

## Rules

- **Always use `--json` and `-T`** on codegraph commands.
- **Never paste raw JSON** into your response — parse and extract.
- **Write artifacts before reporting.**
- If any command fails, **log it to `issues.ndjson`** and continue with partial data.
- **Domain naming** uses the codebase's own vocabulary.

## Self-Improvement

This skill lives at `.claude/skills/titan-recon/SKILL.md`. Edit it if you find improvements during execution.
