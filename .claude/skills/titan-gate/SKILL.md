---
name: titan-gate
description: Validate staged changes — codegraph checks + project lint/build/test, auto-rollback on failure, pass/fail commit gate (Titan Paradigm Phase 4)
argument-hint: <--force to skip warnings>
allowed-tools: Bash, Read, Write, Edit, Grep
---

# Titan GATE — Change Validation & State Machine

You are running the **GATE** phase (State Machine) of the Titan Paradigm.

Your goal: validate staged changes against codegraph quality checks AND the project's own lint/build/test. Produce a clear PASS/WARN/FAIL verdict. Auto-rollback on failure.

> **Context budget:** Lightweight — only checks staged changes. Should complete quickly.

**Force mode:** If `$ARGUMENTS` contains `--force`, warnings are downgraded (failures still block).

---

## Step 0 — Pre-flight: find Titan state and validate

1. **Locate the Titan session (if not already in one).** If `.codegraph/titan/titan-state.json` does not exist locally, search for it:

   ```bash
   git worktree list
   ```

   For each worktree, check:
   ```bash
   ls <worktree-path>/.codegraph/titan/titan-state.json 2>/dev/null
   ```

   Also check branches:
   ```bash
   git branch -a --list '*titan*'
   ```

   **Decision logic:**
   - **Found a worktree/branch with Titan state:** Merge its branch into your worktree to pick up the artifacts: `git merge <titan-branch> --no-edit`
   - **Found multiple:** Pick the one with the most recent `lastUpdated` and `currentPhase` closest to `"sync"` (GATE runs after SYNC). If ambiguous, ask the user.
   - **Found nothing:** That's fine — GATE can run standalone. Proceed with defaults.

2. **Worktree check:**
   ```bash
   git rev-parse --show-toplevel && git worktree list
   ```
   If not in a worktree, stop: "Run `/worktree` first."

3. **Staged changes?**
   ```bash
   git diff --cached --name-only
   ```
   If nothing staged, stop: "Nothing staged. Use `git add` first."

4. **Load state (optional).** Read `.codegraph/titan/titan-state.json` if it exists — use for thresholds, baseline comparison, and sync alignment. If missing or corrupt, proceed with defaults.

---

## Step 1 — Drift detection: has main moved since last gate run?

GATE may run many times across a long pipeline. Check for upstream changes each time.

1. **Compare main SHA:**
   ```bash
   git rev-parse origin/main
   ```
   Compare against `titan-state.json → mainSHA` (if state exists). If identical, skip to Step 2.

2. **If main has advanced**, find what changed:
   ```bash
   git diff --name-only <mainSHA>..origin/main
   ```

3. **Cross-reference with staged files:**
   - Do any staged files also appear in the main diff? If yes, there may be **merge conflicts waiting** after the commit.
   - Did main change files that are callers/callees of staged changes? Use diff-impact to check.

4. **Classify staleness:**

   | Level | Condition | Action |
   |-------|-----------|--------|
   | **none** | main unchanged | Continue normally |
   | **low** | Main changed but no overlap with staged files or their callers | Continue — note drift |
   | **moderate** | Main changed files that are callers/callees of staged changes | **Warn:** "Main has changes that interact with your staged files. Consider merging main first: `git merge origin/main`" |
   | **high** | Main changed the same files you're staging | **Warn strongly:** "Main modified files you're about to commit. Merge main first to avoid conflicts downstream." |

5. **Write/update drift report** (same schema, `"detectedBy": "gate"`).

6. **Update state:** Set `titan-state.json → mainSHA` to current `origin/main`.

7. **If `sync.json` exists:** Check if main's changes invalidate any execution phases. If a phase's targets were changed on main, add a drift warning to the gate-log entry.

---

## Step 2 — Structural validation (codegraph)

Run the full change validation predicates in one call:

```bash
codegraph check --staged --cycles --blast-radius 30 --boundaries -T --json
```

This checks: manifesto rules, new cycle introduction, blast radius threshold, and architecture boundary violations. Exit code 0 = pass, 1 = fail.

Also run detailed impact analysis:

```bash
codegraph diff-impact --staged -T --json
```

Extract: changed functions (count + names), direct callers affected, transitive blast radius, historically coupled files.

---

## Step 3 — Cycle check

```bash
codegraph cycles --json
```

Compare against RECON baseline (if `titan-state.json` exists):
- **New cycles?** → FAIL
- **Cycles resolved?** → Note as positive

---

## Step 4 — Complexity delta

For each changed file (from diff-impact):

```bash
codegraph complexity --file <changed-file> --health -T --json
```

Check all metrics against thresholds:
- `cognitive` > 30 → FAIL
- `halstead.bugs` > 1.0 → FAIL (estimated defect)
- `mi` < 20 → FAIL
- Function moved from PASS → FAIL on any metric? → FAIL
- Function improved but still above threshold? → WARN

---

## Step 5 — Lint, build, and test

Detect project tools from `package.json`:

```bash
node -e "const p=require('./package.json');console.log(JSON.stringify(Object.keys(p.scripts||{})))"
```

Run in order — stop on first failure:

```bash
npm run lint 2>&1 || echo "LINT_FAILED"
```

```bash
npm run build 2>&1 || echo "BUILD_FAILED"
```
(Skip if no `build` script.)

```bash
npm test 2>&1 || echo "TEST_FAILED"
```

If any fail → overall verdict is FAIL → proceed to auto-rollback.

---

## Step 6 — Branch structural diff

```bash
codegraph branch-compare main HEAD -T --json
```

Cumulative structural impact of all changes on this branch (broader than `diff-impact --staged`). Detect cumulative drift.

---

## Step 7 — Sync plan alignment

If `.codegraph/titan/sync.json` exists:
- Are changed files part of the current execution phase?
- Are dependencies for these targets already completed?
- Skipping ahead in execution order? → WARN

Advisory — prevents jumping ahead and creating conflicts.

---

## Step 8 — Blast radius check

From diff-impact results:
- Transitive blast radius > 30 → FAIL
- Transitive blast radius > 15 → WARN
- Historically coupled file NOT staged? → WARN ("consider also updating X")

---

## Step 9 — Verdict and auto-rollback

Aggregate all checks:

| Verdict | Meaning |
|---------|---------|
| **PASS** | Safe to commit |
| **WARN** | Warnings only — commit at your discretion |
| **FAIL** | Failures present — auto-rollback triggered |

### Auto-rollback on FAIL (build/test/lint failures only)

1. **Restore graph** to the most recent snapshot:
   ```bash
   codegraph snapshot restore titan-batch-<N>   # or titan-baseline if no batch snapshot
   ```
   Check `titan-state.json → snapshots.lastBatch` first; fall back to `snapshots.baseline`.

2. **Unstage changes** (preserve in working tree):
   ```bash
   git reset HEAD
   ```

3. **Rebuild graph** for current working tree state:
   ```bash
   codegraph build
   ```

> "GATE FAIL: [reason]. Graph restored, changes unstaged but preserved. Fix and re-stage."

For structural-only failures (Steps 2-4, 6-8), do NOT auto-rollback — report and let user decide.

### Snapshot cleanup on pipeline completion

When the full Titan pipeline is done (all SYNC phases complete, final GATE passes):

```bash
codegraph snapshot delete titan-baseline
codegraph snapshot delete titan-batch-<N>   # if any remain
```

> "All Titan snapshots cleaned up. Codebase is in its final validated state."

---

## Step 10 — Update state machine

Append to `.codegraph/titan/gate-log.ndjson`:

```json
{
  "timestamp": "<ISO 8601>",
  "verdict": "PASS|WARN|FAIL",
  "stagedFiles": ["file1.js"],
  "changedFunctions": 3,
  "blastRadius": 12,
  "checks": {
    "manifesto": "pass|fail",
    "cycles": "pass|fail",
    "complexity": "pass|warn|fail",
    "lint": "pass|fail|skipped",
    "build": "pass|fail|skipped",
    "tests": "pass|fail|skipped",
    "syncAlignment": "pass|warn|skipped",
    "blastRadius": "pass|warn|fail"
  },
  "rolledBack": false
}
```

Update `titan-state.json` (if exists): increment `progress.fixed`, update `fileAudits` for fixed files.

---

## Step 11 — Report to user

**PASS:**
```
GATE PASS — safe to commit
  Changed: 3 functions across 2 files
  Blast radius: 12 transitive callers
  Lint: pass | Build: pass | Tests: pass
  Complexity: all within thresholds (worst: halstead.bugs 0.3)
```

**WARN:**
```
GATE WARN — review before committing
  Changed: 5 functions across 3 files
  Warnings:
  - utils.js historically co-changes with config.js (not staged)
  - parseConfig MI improved 18 → 35 but still below 50
```

**FAIL:**
```
GATE FAIL — changes unstaged, graph restored
  Failures:
  - Tests: 2 suites failed
  - New cycle: parseConfig → loadConfig → parseConfig
  Fix issues, re-stage, re-run /titan-gate
```

---

## Issue Tracking

During validation, if you encounter any of the following, append a JSON line to `.codegraph/titan/issues.ndjson`:

- **Codegraph bugs:** wrong diff-impact, false cycle detection, incorrect complexity after changes
- **Tooling issues:** check command failures, snapshot errors, build tool problems
- **Process suggestions:** threshold adjustments, missing checks, workflow improvements
- **Codebase observations:** test gaps, flaky tests, build warnings worth noting

Format (one JSON object per line, append-only):

```json
{"phase": "gate", "timestamp": "<ISO 8601>", "severity": "bug|limitation|suggestion", "category": "codegraph|tooling|process|codebase", "description": "<what happened>", "context": "<command, check, or file involved>"}
```

Log issues as they happen. The `/titan-close` phase compiles these into the final report.

---

## Rules

- **Fast execution.** Only staged changes, not full codebase.
- **Always use `--json` and `-T`.**
- **Never auto-commit.** Verdict only — user decides.
- **Auto-rollback is gentle** — `git reset HEAD`, never `git checkout`. Work preserved.
- **Append to gate-log.ndjson** — the audit trail.
- **Force mode** downgrades WARN → PASS but cannot override FAIL.
- **Run the project's own lint/build/test** — codegraph checks are necessary but not sufficient.
- **Use the correct check flags:** `--cycles`, `--blast-radius <n>`, `--boundaries`.
- If any check produces unexpected output, **log it to `issues.ndjson`** before continuing.

## Self-Improvement

This skill lives at `.claude/skills/titan-gate/SKILL.md`. Adjust thresholds or rollback behavior after dogfooding.
