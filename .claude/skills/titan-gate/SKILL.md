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
# Detect test command from package.json scripts (npm test, yarn test, pnpm test, etc.)
<test-runner> test 2>&1 || echo "TEST_FAILED"
```

If any fail → overall verdict is FAIL → proceed to auto-rollback.

---

## Step 5 — Semantic assertions (API compatibility)

Verify that code changes don't silently break callers by changing public contracts. This goes beyond structural checks — it catches signature changes, removed exports, and new forbidden dependencies.

### 5a. Export signature stability

Get the list of changed files from diff-impact (Step 1):

```bash
codegraph exports <changed-file> -T --json
```

For each **exported** symbol in changed files:
- Check if the symbol existed before this change: `git show HEAD:<file>` and compare function signatures
- If a function's **parameter list changed** (added required params, removed params, changed types):
  ```bash
  codegraph fn-impact <symbol> -T --json
  ```
  Count callers. If callers > 0 and callers are NOT also staged → **FAIL**: "Signature change in `<symbol>` breaks <N> callers not updated in this commit: <caller list>"
- If an **export was removed entirely** and callers exist → **FAIL**: "Removed export `<symbol>` still imported by <N> files"

### 5b. Import resolution integrity

From the diff-impact results already collected in Step 1, extract any edges where the target symbol or file no longer exists (i.e., the import points to a removed or renamed symbol).

For each such broken edge where the importing file is NOT part of this commit's staged changes → **FAIL**: "Change broke import resolution for <file>: <import>"

> **Note:** `codegraph check` does not include import resolution predicates — its checks cover cycles, blast-radius, boundaries, and manifesto rules. Import resolution runs during `codegraph build`. This step relies on diff-impact's edge data to detect broken imports indirectly by identifying edges that reference removed symbols.

### 5c. Dependency direction assertions

From the diff-impact results already collected in Step 1, extract any **new** edges (imports that didn't exist before).

For each new dependency:
- Check against `GLOBAL_ARCH.md` layer rules (if Titan artifacts exist)
- Check the Step 1 `codegraph check --staged --boundaries` results for violations on this edge (already collected — do not re-run)
- New dependency from a lower layer to a higher layer → **FAIL**: "New upward dependency: `<source>` → `<target>` violates layer boundary"
- New dependency on a module flagged in sync.json as "to be removed" or "to be split" → **WARN**: "New dependency on `<module>` which is scheduled for decomposition"

### 5d. Re-export chain validation

If the change modifies an index/barrel file (e.g., `index.js`, `mod.rs`):

Capture the pre-change export list from the committed version (write the temp path to a sidecar file so it persists across Bash invocations):
```bash
BARREL_EXT="${barrel_file##*.}"
BARREL_TMP=$(mktemp "/tmp/titan-barrel-XXXXXX.${BARREL_EXT}")
echo "$BARREL_TMP" > .codegraph/titan/.barrel-tmp
git show HEAD:<barrel-file> > "$BARREL_TMP"
codegraph exports "$BARREL_TMP" -T --json
```

Then capture the current (staged) export list:
```bash
codegraph exports <barrel-file> -T --json
```

Compare export count before and after. If exports were **accidentally dropped** (count decreased and the removed exports have callers) → **FAIL**: "Barrel file `<barrel-file>` dropped <N> exports that have active callers: <export list>. Use `codegraph exports <barrel-file> -T` to review."

Clean up the temp file (recover path from sidecar). **This MUST run even if Step 5d produced a FAIL verdict — run it before proceeding to Step 9:**
```bash
BARREL_TMP=$(cat .codegraph/titan/.barrel-tmp 2>/dev/null)
if [ -n "$BARREL_TMP" ]; then rm -f "$BARREL_TMP"; fi
rm -f .codegraph/titan/.barrel-tmp
```

---

## Step 5.5 — Architectural snapshot comparison

Compare the codebase's architectural properties before and after this change. This catches "technically correct but architecturally wrong" changes — e.g., a valid refactor that puts code in the wrong layer.

### Load pre-forge snapshot

Read `.codegraph/titan/arch-snapshot.json` if it exists (created by `/titan-run` before forge begins). If missing, skip this step — it only works within the orchestrated pipeline.

### Capture current state

Use `mktemp -d` to create a unique temporary directory that persists across Bash invocations (shell variables like `$TITAN_TMP_ID` do not survive between separate Bash tool calls):

```bash
TITAN_ARCH_DIR=$(mktemp -d /tmp/titan-arch-XXXXXX)
echo "$TITAN_ARCH_DIR" > .codegraph/titan/.arch-tmpdir
codegraph communities -T --json > "$TITAN_ARCH_DIR/current-communities.json" || echo '{"ARCH_CAPTURE_FAILED":"communities"}' > "$TITAN_ARCH_DIR/current-communities.json"
codegraph structure --depth 2 --json > "$TITAN_ARCH_DIR/current-structure.json" || echo '{"ARCH_CAPTURE_FAILED":"structure"}' > "$TITAN_ARCH_DIR/current-structure.json"
codegraph communities --drift -T --json > "$TITAN_ARCH_DIR/current-drift.json" || echo '{"ARCH_CAPTURE_FAILED":"drift"}' > "$TITAN_ARCH_DIR/current-drift.json"
```

> The path is written to `.codegraph/titan/.arch-tmpdir` so subsequent Bash invocations can recover it via `TITAN_ARCH_DIR=$(cat .codegraph/titan/.arch-tmpdir)`.

### Compare

> **Before comparing:** Check each captured file for `ARCH_CAPTURE_FAILED`. If a file contains this marker, skip the corresponding assertion (A1/A3/A4) and report: "Skipping <assertion> — codegraph <command> failed during capture."

In a new Bash invocation, recover the temp dir path first:
```bash
TITAN_ARCH_DIR=$(cat .codegraph/titan/.arch-tmpdir)
```

**A1. Community stability:**
Use the drift output (which uses content-based matching, not raw IDs, to track community movements across runs):

Read `.codegraph/titan/arch-snapshot.json → drift` (the pre-forge drift baseline) and compare against `$TITAN_ARCH_DIR/current-drift.json`:
- For each **new** drift warning in current that was NOT present in the snapshot: if the drifted symbol was NOT touched in the diff → **WARN**: "Symbol `<name>` drifted community as a side effect"
- If > 5 untouched symbols appear in new drift warnings → **FAIL**: "Significant community restructuring detected — <N> symbols drifted communities. This change may have unintended architectural impact."

**A2. Dependency direction between domains:**
From `GLOBAL_ARCH.md`, extract the expected dependency direction between domains (e.g., "presentation depends on features, not the reverse").

Check if any new cross-domain dependency violates the expected direction. Use the Step 1 diff-impact results to extract only the edges introduced by the staged changes — do not re-run `codegraph deps` on the full file (that returns all dependencies including pre-existing ones). For each new edge in the diff-impact output, the source and target file paths are already present in the edge data. Resolve the domain/layer of each endpoint by matching its file path against the domain map in `GLOBAL_ARCH.md` (e.g., `src/presentation/` → presentation layer, `src/features/` → features layer). No additional codegraph command is needed — the diff-impact edge output contains the file paths directly.
- New upward dependency (lower layer importing higher layer) introduced in this diff → **FAIL**
- Pre-existing boundary violations not surfaced by Step 5c's staged-diff results → advisory-only (not gating)
- New lateral dependency within the same layer → **OK**

**A3. Cohesion delta:**
Compare directory cohesion scores from `structure`:
- If any directory's cohesion dropped by > 0.2 → **WARN**: "Directory `<dir>` cohesion dropped from <X> to <Y>"
- If a directory went from above 0.5 to below 0.3 → **FAIL**: "Directory `<dir>` became tangled (cohesion <X> → <Y>)"

**A4. Resolved drift warnings (positive signal):**
Compare drift warnings between snapshot and current. A1 already covers new drift warnings — A4 only reports resolved ones:
- If any drift warning that was present in the snapshot is absent from `$TITAN_ARCH_DIR/current-drift.json` → note as positive: "Symbol `<name>` community drift resolved — architecture improved"

> **Note:** A3 and A4 compare the pre-forge baseline against the *committed* state at gate-run time (the graph DB does not include staged-but-uncommitted changes). They catch cumulative architectural drift across all forge commits made so far, not the individual staged change being validated in this gate run. A1 and A2 use staged-change-aware data (diff-impact) and catch per-change violations.

### Cleanup (MUST run even on failure or early exit)

This cleanup block MUST execute regardless of the verdict — including FAIL paths and early exits. Run it before proceeding to Step 9 (verdict aggregation), not after.

```bash
TITAN_ARCH_DIR=$(cat .codegraph/titan/.arch-tmpdir 2>/dev/null)
if [ -n "$TITAN_ARCH_DIR" ]; then
  rm -rf "$TITAN_ARCH_DIR"
fi
rm -f .codegraph/titan/.arch-tmpdir
```

### Verdict integration

Architectural failures are reported as part of the overall gate verdict. They participate in the PASS/WARN/FAIL aggregation like all other checks.

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

For structural-only and semantic failures (Steps 1-3, 5, 5.5, 6-8), do NOT auto-rollback — report and let user decide.

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
    "semanticAssertions": "pass|warn|fail|skipped",
    "archSnapshot": "pass|warn|fail|skipped",
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
  Structural: pass | Semantic: pass | Architecture: pass
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
  - Semantic: new dependency on module scheduled for decomposition
  - Architecture: directory src/domain/ cohesion dropped 0.6 → 0.45
```

**FAIL (test/lint/build failures — rollback triggered):**
```
GATE FAIL — changes unstaged, graph restored
  Failures:
  - Tests: 2 suites failed
  - New cycle: parseConfig → loadConfig → parseConfig
  Fix issues, re-stage, re-run /titan-gate
```

**FAIL (structural/semantic failures — no rollback):**
```
GATE FAIL — changes preserved for review — manual unstage if needed
  Failures:
  - Semantic: removed export `parseConfig` still imported by 3 files
  - Architecture: new upward dependency presentation/ → domain/
  Staged changes are intact. Fix the issues above, or manually run `git reset HEAD` to unstage.
  Re-stage and re-run /titan-gate when ready.
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
