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

## Step 0 — Pre-flight

1. **Worktree check:**
   ```bash
   git rev-parse --show-toplevel && git worktree list
   ```
   If not in a worktree, stop: "Run `/worktree` first."

2. **Staged changes?**
   ```bash
   git diff --cached --name-only
   ```
   If nothing staged, stop: "Nothing staged. Use `git add` first."

3. **Load state (optional).** Read `.codegraph/titan/titan-state.json` if it exists — use for thresholds, baseline comparison, and sync alignment. If missing or corrupt, proceed with defaults.

---

## Step 1 — Structural validation (codegraph)

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

## Step 2 — Cycle check

```bash
codegraph cycles --json
```

Compare against RECON baseline (if `titan-state.json` exists):
- **New cycles?** → FAIL
- **Cycles resolved?** → Note as positive

---

## Step 3 — Complexity delta

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

## Step 4 — Lint, build, and test

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

## Step 5 — Branch structural diff

```bash
codegraph branch-compare main HEAD -T --json
```

Cumulative structural impact of all changes on this branch (broader than `diff-impact --staged`). Detect cumulative drift.

---

## Step 6 — Sync plan alignment

If `.codegraph/titan/sync.json` exists:
- Are changed files part of the current execution phase?
- Are dependencies for these targets already completed?
- Skipping ahead in execution order? → WARN

Advisory — prevents jumping ahead and creating conflicts.

---

## Step 7 — Blast radius check

From diff-impact results:
- Transitive blast radius > 30 → FAIL
- Transitive blast radius > 15 → WARN
- Historically coupled file NOT staged? → WARN ("consider also updating X")

---

## Step 8 — Verdict and auto-rollback

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

For structural-only failures (Steps 1-3, 5-7), do NOT auto-rollback — report and let user decide.

### Snapshot cleanup on pipeline completion

When the full Titan pipeline is done (all SYNC phases complete, final GATE passes):

```bash
codegraph snapshot delete titan-baseline
codegraph snapshot delete titan-batch-<N>   # if any remain
```

> "All Titan snapshots cleaned up. Codebase is in its final validated state."

---

## Step 9 — Update state machine

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

## Step 10 — Report to user

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

## Rules

- **Fast execution.** Only staged changes, not full codebase.
- **Always use `--json` and `-T`.**
- **Never auto-commit.** Verdict only — user decides.
- **Auto-rollback is gentle** — `git reset HEAD`, never `git checkout`. Work preserved.
- **Append to gate-log.ndjson** — the audit trail.
- **Force mode** downgrades WARN → PASS but cannot override FAIL.
- **Run the project's own lint/build/test** — codegraph checks are necessary but not sufficient.
- **Use the correct check flags:** `--cycles`, `--blast-radius <n>`, `--boundaries`.

## Self-Improvement

This skill lives at `.claude/skills/titan-gate/SKILL.md`. Adjust thresholds or rollback behavior after dogfooding.
