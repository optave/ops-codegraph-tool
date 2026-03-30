---
name: titan-close
description: Split branch commits into focused PRs, compile issue tracker, generate final report with before/after metrics (Titan Paradigm Phase 5)
argument-hint: <--dry-run to preview without creating PRs>
allowed-tools: Bash, Read, Write, Glob, Grep, Edit
---

# Titan CLOSE — PR Splitting & Final Report

You are running the **CLOSE** phase of the Titan Paradigm.

Your goal: analyze all commits on the current branch, split them into focused PRs for easier review, compile the issue tracker from all phases, capture final metrics, and generate a comprehensive audit report.

> **Context budget:** This phase reads artifacts and git history. Keep codegraph queries targeted — only for final metrics comparison.

**Dry-run mode:** If `$ARGUMENTS` contains `--dry-run`, preview the PR split plan and report without creating PRs or pushing branches.

---

## Step 0 — Pre-flight: find and consolidate the Titan session

1. **Locate the Titan session.** All prior phases (RECON → GAUNTLET → SYNC → GATE) may have run across different worktrees or branches. You need to consolidate their work.

   ```bash
   git worktree list
   ```

   For each worktree, check for Titan artifacts:
   ```bash
   ls <worktree-path>/.codegraph/titan/titan-state.json 2>/dev/null
   ```

   Also check branches (including remote):
   ```bash
   git branch -a --list '*titan*'
   git branch -a --list '*refactor/*'
   ```

   **Decision logic:**
   - **Found exactly one worktree/branch with `titan-state.json`:** Read its `currentPhase`. If it's `"sync"` or later, this is the right session. Merge its branch into your worktree.
   - **Found a worktree but `currentPhase` is earlier than expected (e.g., `"recon"` or `"gauntlet"`):** The pipeline may not be complete. Keep searching — there may be a more advanced worktree. If nothing better found, ask the user: "Found Titan state at `<path>` with phase `<phase>`. The pipeline appears incomplete. Continue anyway, or should I look elsewhere?"
   - **Found multiple worktrees with `titan-state.json`:** List them all with `currentPhase`, `lastUpdated`, and branch name. The Titan pipeline may have been split across worktrees (RECON in one, GAUNTLET in another). Merge them in phase order into your worktree. If there's ambiguity (e.g., two worktrees at the same phase), ask the user.
   - **Found branches but no worktrees:** Merge the titan branch(es) in phase order: `git merge <branch> --no-edit`
   - **Found nothing:** Stop: "No Titan session found in any worktree or branch. Run `/titan-recon` first."

2. **Ensure worktree isolation:**
   ```bash
   git rev-parse --show-toplevel && git worktree list
   ```
   If not in a worktree, stop: "Run `/worktree` first."

3. **Sync with main:**
   ```bash
   git fetch origin main && git merge origin/main --no-edit
   ```
   If there are merge conflicts, stop: "Merge conflict detected. Resolve conflicts and re-run `/titan-close`."

4. **Load artifacts.** Read:
   - `.codegraph/titan/titan-state.json` — session state, baseline metrics, progress
   - `.codegraph/titan/GLOBAL_ARCH.md` — architecture document
   - `.codegraph/titan/gauntlet.ndjson` — full per-target audit data (pillar verdicts, metrics, violations)
   - `.codegraph/titan/gauntlet-summary.json` — audit result totals
   - `.codegraph/titan/sync.json` — execution plan (commit grouping)
   - `.codegraph/titan/gate-log.ndjson` — validation history (may not exist if gate wasn't run)
   - `.codegraph/titan/issues.ndjson` — issue tracker from all phases
   - `.codegraph/titan/arch-snapshot.json` — pre-forge architectural snapshot (communities, structure, drift). Use for before/after comparison in the Metrics section. May not exist if capture failed.
   - `.codegraph/titan/drift-report.json` — cumulative drift reports from all phases. May not exist if no drift was detected.

   If `titan-state.json` is missing after the search, stop: "No Titan session found. Run `/titan-recon` first."

   > **When called from `/titan-run`:** The orchestrator already ensured worktree isolation, synced with main, and all artifacts are in the current worktree. Steps 0.1–0.3 (worktree search, isolation check, main sync) can be skipped if the orchestrator tells you to skip them.

5. **Detect version.** Extract from `package.json`:
   ```bash
   node -e "console.log(require('./package.json').version)"
   ```

---

## Step 1 — Drift detection: final staleness assessment

CLOSE is the last phase — it must assess the full pipeline's freshness before generating the report.

1. **Compare main SHA:**
   ```bash
   git rev-parse origin/main
   ```
   Compare against `titan-state.json → mainSHA`.

2. **If main has advanced**, calculate full drift:
   ```bash
   git rev-list --count <mainSHA>..origin/main
   git diff --name-only <mainSHA>..origin/main
   ```

3. **Read all prior drift reports** from `.codegraph/titan/drift-report.json` (a JSON array of entries, one per phase that detected drift). This shows the cumulative drift across the pipeline.

4. **Assess overall pipeline freshness:**

   | Level | Condition | Action |
   |-------|-----------|--------|
   | **fresh** | mainSHA matches current main, no drift reports with severity > low | Generate report normally |
   | **acceptable** | Some drift detected but phases handled it (re-audited stale targets) | Generate report — note drift in Executive Summary |
   | **stale** | Significant unaddressed drift: >10 commits behind, >20% of audited targets changed on main since audit | **Warn user:** "Pipeline results are partially stale. N targets were modified on main after being audited. The report will flag these. Consider re-running `/titan-gauntlet` for affected targets before finalizing." |
   | **expired** | >50 commits behind OR >50% of targets changed OR architecture-level changes (new directories in src/) | **Stop:** "Pipeline results are too stale to produce a reliable report. Run `/titan-recon` for a fresh baseline." |

5. **Write final drift assessment** to the drift report (same schema, `"detectedBy": "close"`).

6. **Include drift summary in the report.** The final report's Executive Summary and Recommendations sections must reflect any staleness. Stale targets should be called out in a "Staleness Warnings" subsection.

---

## Step 2 — Collect branch commit history

```bash
git log main..HEAD --oneline --no-merges
git log main..HEAD --format="%H %s" --no-merges
```

Extract: total commit count, commit messages, SHAs. If zero commits, stop: "No commits on this branch. Nothing to close."

For each commit, get the files changed:
```bash
git diff-tree --no-commit-id --name-only -r <sha>
```

---

## Step 3 — Classify commits into PR groups

Analyze commit messages and changed files to group commits into **focused PRs**. Each PR should address a single concern for easier review.

### Grouping strategy (in priority order)

Use `sync.json` execution phases as the primary guide if available:

1. **Dead code cleanup** — commits removing dead symbols
   - PR title: `chore: remove dead code identified by Titan audit`
2. **Shared abstractions** — commits extracting interfaces/utilities
   - PR title: `refactor: extract <abstraction> from <source>`
3. **Cycle breaks** — commits resolving circular dependencies
   - PR title: `refactor: break circular dependency in <domain>`
4. **Decompositions** — commits splitting complex functions/files
   - PR title: `refactor: decompose <target> in <domain>`
5. **Quality fixes** — commits addressing fail-level violations
   - Group by domain: `fix: address quality issues in <domain>`
6. **Warning improvements** — commits addressing warn-level issues
   - Group by domain: `refactor: improve code quality in <domain>`

### Fallback grouping (if no sync.json)

Group by changed file paths — commits touching the same directory/domain go together. Use commit message prefixes (`fix:`, `refactor:`, `chore:`) as secondary signals.

### Rules for grouping
- A PR should touch **one domain** where possible
- A PR should address **one concern** (don't mix dead code removal with refactors)
- Order PRs so dependencies come first (if PR B depends on PR A's changes, A merges first)
- Each PR must be independently reviewable — no PR should break the build alone
- If a commit touches files across multiple concerns, assign it to the primary concern and note the cross-cutting nature in the PR description

Record the grouping plan:
```json
[
  {
    "pr": 1,
    "title": "...",
    "concern": "dead_code|abstraction|cycle_break|decomposition|quality_fix|warning",
    "domain": "<domain name>",
    "commits": ["<sha1>", "<sha2>"],
    "files": ["<file1>", "<file2>"],
    "dependsOn": [],
    "description": "..."
  }
]
```

---

## Step 4 — Capture final metrics

Rebuild the graph and collect current metrics:

```bash
codegraph build
codegraph stats --json
codegraph complexity --health --above-threshold -T --json --limit 50
codegraph roles --role dead -T --json
codegraph roles --role core -T --json
codegraph cycles --json
```

Extract: `totalNodes`, `totalEdges`, `totalFiles`, `qualityScore`, functions above threshold, dead symbol count, core symbol count, cycle count.

Also get the worst offenders for comparison:
```bash
codegraph complexity --health --sort effort -T --json --limit 10
codegraph complexity --health --sort bugs -T --json --limit 10
codegraph complexity --health --sort mi -T --json --limit 10
```

### Architecture comparison (if arch-snapshot.json exists)

If `.codegraph/titan/arch-snapshot.json` was captured before forge, compare its `structure` data against current `codegraph structure --depth 2 --json` output. Report cohesion changes per directory (improved / degraded / unchanged). Include in the "Metrics: Before & After" section of the report.

### Compute deltas

Compare final metrics against `titan-state.json` baseline:

| Metric | Baseline | Final | Delta |
|--------|----------|-------|-------|
| Quality Score | from state | from stats | +/- |
| Functions above threshold | from state | from complexity | +/- |
| Dead symbols | from state | from roles | +/- |
| Cycles | from state | from cycles | +/- |
| Total nodes | from state | from stats | +/- |

---

## Step 5 — Compile the issue tracker and open GitHub issues

Read `.codegraph/titan/issues.ndjson`. Each line is a JSON object:

```json
{"phase": "recon|gauntlet|sync|gate", "timestamp": "ISO 8601", "severity": "bug|limitation|suggestion", "category": "codegraph|tooling|process|codebase", "description": "...", "context": "optional detail"}
```

Group issues by category and severity. Summarize:
- **Codegraph bugs:** issues with codegraph itself (wrong output, crashes, missing features)
- **Tooling issues:** problems with the Titan pipeline or other tools
- **Process notes:** suggestions for improving the Titan workflow
- **Codebase observations:** structural concerns beyond what the audit covered

### 5b. Open GitHub issues

**Pre-check:** Verify `gh` is available and authenticated before attempting issue creation:
```bash
gh auth status 2>&1 || echo "GH_UNAVAILABLE"
```
If `GH_UNAVAILABLE`, skip issue creation entirely and note in the report: "GitHub issues were not created — `gh` CLI is not available or not authenticated. Create them manually from the Issues section below."

For each issue with severity `bug` or `limitation`, create a GitHub issue using `gh`:

```bash
BODY=$(mktemp)
cat > "$BODY" <<'ISSUE_BODY'
## Context
Discovered during Titan audit (phase: <phase>, date: <timestamp>).

## Description
<description>

## Additional Context
<context field, if present>

## Source
- **Titan phase:** <phase>
- **Severity:** <severity>
- **Category:** <category>
ISSUE_BODY
gh issue create --title "<category>: <short description>" --body-file "$BODY" --label "titan-audit"
rm -f "$BODY"
```

Using `--body-file` with a temp file avoids quoting/expansion issues that can arise when issue descriptions contain backticks, `$()` sequences, or literal `EOF` strings.

**Rules for issue creation:**
- **Only open issues for `bug` and `limitation` severity.** Suggestions and observations go in the report only — they are not actionable enough for standalone issues.
- **Check for duplicates first:** Run `gh issue list --search "<short description>" --state open --limit 5` before creating. If a matching open issue exists, skip it and note "existing issue #N" in the report.
- **Label:** Use `titan-audit` label. If the label doesn't exist, create it: `gh label create titan-audit --description "Issues discovered during Titan audit" --color "d4c5f9" 2>/dev/null || true`
- **Record each created issue number** for inclusion in the report's Issues section.

For `suggestion` severity entries and entries with `category: "codebase"`, include them in the report's Issues section but do NOT create GitHub issues.

---

## Step 6 — Compile the gate log

Read `.codegraph/titan/gate-log.ndjson`. Summarize:
- Total gate runs
- Pass / Warn / Fail counts
- Rollbacks triggered
- Most common failure reasons

---

## Step 7 — Generate the report

### Record CLOSE completion timestamp

Before writing the report, record `phaseTimestamps.close.completedAt` so the Pipeline Timeline has accurate data for the CLOSE row. (titan-run also records this after titan-close returns as a safety backstop, but by then the report is already written.)

```bash
node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('.codegraph/titan/titan-state.json','utf8'));s.phaseTimestamps=s.phaseTimestamps||{};s.phaseTimestamps['close']=s.phaseTimestamps['close']||{};s.phaseTimestamps['close'].completedAt=new Date().toISOString();fs.writeFileSync('.codegraph/titan/titan-state.json',JSON.stringify(s,null,2));"
```

### Report path

```
generated/titan/titan-report-v<version>-<date>T<time>.md
```

Where:
- `<version>` is the package.json version (e.g., `3.1.5`)
- `<date>` is `YYYY-MM-DD`
- `<time>` is `HH-MM-SS` (local time, hyphen-separated for filesystem safety)

Example: `generated/titan/titan-report-v3.1.5-2026-03-17T14-30-00.md`

```bash
mkdir -p generated/titan
```

### Report structure

Write the report as Markdown:

```markdown
# Titan Audit Report

**Version:** <package version>
**Date:** <start date> → <end date>
**Branch:** <branch name>
**Target:** <resolved path>

---

## Executive Summary

<2-3 sentences: what was audited, key outcomes, overall health change>

---

## Pipeline Timeline

Read `titan-state.json → phaseTimestamps` for real wall-clock data. If `phaseTimestamps` exists, use the recorded ISO 8601 timestamps to compute durations. If it does not exist (older pipeline run), derive timing from git commit timestamps as a fallback — **never invent or guess timestamps.**

**Duration computation:** For each phase with `startedAt` and `completedAt`, compute duration as the difference in minutes/hours. For forge, also note the first and last commit timestamps from `git log`.

| Phase | Duration | Notes |
|-------|----------|-------|
| RECON | <computed from phaseTimestamps.recon> | — |
| GAUNTLET | <computed from phaseTimestamps.gauntlet> | <iterations count if resuming> |
| SYNC | <computed from phaseTimestamps.sync> | — |
| FORGE | <computed from phaseTimestamps.forge> | <commit count>, first at <time>, last at <time> |
| GATE | across forge | <total runs> inline with forge commits |
| CLOSE | <computed from phaseTimestamps.close> | — |
| **Total** | <sum of all phases> | — |

**If `phaseTimestamps` is missing:** Fall back to git log timestamps. Use the earliest and latest commit timestamps from `git log main..HEAD --format="%ai"` to bound the forge phase. For analysis phases (recon, gauntlet, sync), use `titan-state.json → initialized` and `lastUpdated` as rough bounds. Mark the durations as "~approximate" in the table.

---

## Metrics: Before & After

| Metric | Baseline | Final | Delta | Trend |
|--------|----------|-------|-------|-------|
| Quality Score | X | Y | +/-Z | arrow |
| Total Files | ... | ... | ... | ... |
| Total Symbols | ... | ... | ... | ... |
| Functions Above Threshold | ... | ... | ... | ... |
| Dead Symbols | ... | ... | ... | ... |
| Cycle Count | ... | ... | ... | ... |
| Avg Halstead Bugs | ... | ... | ... | ... |
| Avg Maintainability Index | ... | ... | ... | ... |

### Complexity Improvement: Top Movers

<Table of functions that improved the most — dropped below thresholds or reduced halstead.bugs>

### Remaining Hot Spots

<Table of functions still above thresholds — carried forward for next Titan run>

---

## Audit Results Summary

**Targets audited:** <N>
**Pass:** <N> | **Warn:** <N> | **Fail:** <N> | **Decompose:** <N>

### By Pillar

| Pillar | Pass | Warn | Fail |
|--------|------|------|------|
| I — Structural Purity | ... | ... | ... |
| II — Data & Type Sovereignty | ... | ... | ... |
| III — Ecosystem Synergy | ... | ... | ... |
| IV — Quality Vigil | ... | ... | ... |

### Most Common Violations

<Top 5 violation types with counts>

---

## Changes Made

### Commits: <total count>

<Table: SHA (short), message, files changed, domain>

### PR Split Plan

| PR # | Title | Concern | Domain | Commits | Files | Depends On |
|------|-------|---------|--------|---------|-------|------------|
| 1 | ... | ... | ... | N | N | — |
| 2 | ... | ... | ... | N | N | PR #1 |

---

## Gate Validation History

**Total runs:** <N>
**Pass:** <N> | **Warn:** <N> | **Fail:** <N>
**Rollbacks:** <N>

### Failure Patterns
<Most common failure reasons>

---

## Issues Discovered

### Codegraph Bugs (<count>)
<List with severity, description, context>

### Tooling Issues (<count>)
<List>

### Process Suggestions (<count>)
<List>

### Codebase Observations (<count>)
<List>

---

## Domains Analyzed

<From GLOBAL_ARCH.md — domain map with final status>

---

## Pipeline Freshness

**Main at RECON:** <mainSHA short>
**Main at CLOSE:** <current SHA short>
**Commits behind:** <N>
**Overall staleness:** <fresh|acceptable|stale>

### Drift Events
<Table from drift-report.json: phase, staleness level, impacted targets, action taken>

### Stale Targets
<List of targets whose audit results may not reflect current main — carried forward for next run>

---

## Recommendations for Next Run

<Based on remaining hot spots, unresolved issues, staleness, and patterns observed>
```

---

## Step 8 — Create PRs (unless --dry-run)

If `$ARGUMENTS` contains `--dry-run`:
- Print the PR split plan as a table
- Print the report path
- Stop: "Dry-run complete. Review the plan and report, then re-run `/titan-close` to create PRs."

Otherwise, for each PR group (in dependency order):

### 8a. Create a branch for each PR

```bash
git checkout -b titan/<concern>/<domain> main
```

### 8b. Cherry-pick the commits

```bash
git cherry-pick <sha1> <sha2> ...
```

If a cherry-pick conflicts:
1. Note the conflict in the report
2. Skip the problematic commit: `git cherry-pick --skip`
3. Add the skipped commit to the next PR or flag for manual resolution

### 8c. Push and create the PR

```bash
git push -u origin titan/<concern>/<domain>
```

```bash
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
<bullets from the grouping plan>

## Titan Audit Context
- **Phase:** <concern>
- **Domain:** <domain>
- **Commits:** <count>
- **Depends on:** <PR #N or "none">

## Changes
<file list with brief descriptions>

## Metrics Impact
<relevant before/after metrics for files in this PR>

## Test plan
- [ ] CI passes (lint + build + tests)
- [ ] codegraph check --cycles --boundaries passes
- [ ] No new functions above complexity thresholds
EOF
)"
```

Record each PR URL.

### 8d. Return to the original branch

```bash
git checkout <original-branch>
```

---

## Step 9 — Update the report with PR URLs

Edit the report to add the actual PR URLs to the PR split plan table.

Also write a machine-readable summary:

Write `.codegraph/titan/close-summary.json`:

```json
{
  "phase": "close",
  "timestamp": "<ISO 8601>",
  "version": "<package version>",
  "branch": "<branch name>",
  "reportPath": "generated/titan/<report-name>.md",
  "metrics": {
    "baseline": { "qualityScore": 0, "functionsAboveThreshold": 0, "deadSymbols": 0, "cycles": 0 },
    "final": { "qualityScore": 0, "functionsAboveThreshold": 0, "deadSymbols": 0, "cycles": 0 }
  },
  "audit": { "totalAudited": 0, "pass": 0, "warn": 0, "fail": 0, "decompose": 0 },
  "gate": { "totalRuns": 0, "pass": 0, "warn": 0, "fail": 0, "rollbacks": 0 },
  "issues": { "codegraph": 0, "tooling": 0, "process": 0, "codebase": 0 },
  "prs": [
    { "number": 0, "url": "<url>", "title": "<title>", "concern": "<type>", "domain": "<domain>", "commits": 0 }
  ],
  "commits": { "total": 0, "cherryPickFailures": 0 }
}
```

---

## Step 10 — Final cleanup

1. **Update titan-state.json:** set `currentPhase` to `"close"`, update `lastUpdated`.

2. **Snapshot cleanup:** If the pipeline is fully complete (all PRs created):
   ```bash
   codegraph snapshot delete titan-baseline 2>/dev/null
   ```
   Delete any remaining batch snapshots.

3. **Titan reports are committed to the repo** (not gitignored). The `generated/titan/` directory is tracked so reports are preserved in git history.

---

## Step 11 — Report to user

Print:

```
TITAN CLOSE — Pipeline Complete

Report: generated/titan/<report-name>.md

Metrics Delta:
  Quality Score: X → Y (+Z)
  Functions above threshold: X → Y (-Z)
  Dead symbols: X → Y (-Z)

Audit: <N> audited — <P> pass, <W> warn, <F> fail
Gate:  <N> runs — <P> pass, <W> warn, <F> fail, <R> rollbacks
Issues: <N> logged (<B> codegraph bugs, <T> tooling, <S> suggestions)

PRs Created: <N>
  #1: <title> (<url>)
  #2: <title> (<url>)
  ...

Merge order: PR #1 → #2 → #3 (respect dependencies)

Next: merge PRs in order, then /titan-reset to clean up artifacts.
```

---

## Rules

- **Always use `--json` and `-T`** on codegraph commands.
- **Never paste raw JSON** into your response — parse and extract.
- **Dry-run is safe.** Only `--dry-run` omission triggers branch creation and PR submission.
- **Cherry-pick failures are noted, not fatal.** Skipped commits get flagged in the report.
- **One PR = one concern.** Never mix dead code removal with refactors in the same PR.
- **Dependency order matters.** Create and label PRs so reviewers know the merge sequence.
- **The report is the deliverable.** It must be comprehensive enough for someone who wasn't present to understand what happened.
- **Issue tracker is append-only.** Never modify issues from other phases — only compile them.

## Self-Improvement

This skill lives at `.claude/skills/titan-close/SKILL.md`. Adjust PR grouping logic or report structure after dogfooding.
