---
name: titan-forge
description: Execute the sync.json plan — refactor code, validate with /titan-gate, commit, and advance state (Titan Paradigm Phase 4)
argument-hint: <--phase N> <--target name> <--dry-run>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent
---

# Titan FORGE — Execute Sync Plan

You are running the **FORGE** phase of the Titan Paradigm.

Your goal: read `sync.json`, find the next incomplete execution phase, make the actual code changes for each target, validate with `/titan-gate`, commit, and advance state.

> **Context budget:** One phase per invocation. Do not attempt all phases in one session — the context window will fill. Run one phase, report, stop. User re-runs for the next phase.

**Arguments** (from `$ARGUMENTS`):
- No args → run next incomplete phase
- `--phase N` → jump to specific phase
- `--target <name>` → run single target only (for retrying failures)
- `--dry-run` → show what would be done without changing code

---

## Step 0 — Pre-flight

1. **Worktree check:**
   ```bash
   git rev-parse --show-toplevel && git worktree list
   ```
   If not in a worktree, stop: "Run `/worktree` first."

2. **Sync with main:**
   ```bash
   git fetch origin main && git merge origin/main --no-edit
   ```
   If there are merge conflicts, stop: "Merge conflict detected. Resolve conflicts and re-run `/titan-forge`."

3. **Load artifacts.** Read:
   - `.codegraph/titan/sync.json` — execution plan (if missing: "Run `/titan-sync` first.")
   - `.codegraph/titan/titan-state.json` — current state
   - `.codegraph/titan/gauntlet.ndjson` — per-target audit details
   - `.codegraph/titan/gauntlet-summary.json` — aggregated results

4. **Validate state.** If `titan-state.json` has `currentPhase` other than `"sync"` and no existing `execution` block, stop: "State not ready. Run `/titan-sync` first."

5. **Initialize execution state** (if first run). Add to `titan-state.json`:
   ```json
   {
     "execution": {
       "currentPhase": 1,
       "completedPhases": [],
       "currentTarget": null,
       "completedTargets": [],
       "failedTargets": [],
       "commits": []
     }
   }
   ```

6. **Determine next phase.** Use `--phase N` if provided, otherwise find the lowest phase number not in `completedPhases`.

7. **Print plan:**
   > Phase N: \<label\> — N targets, estimated N commits

8. **Ask for confirmation** before starting (unless `$ARGUMENTS` contains `--yes`).

---

## Step 1 — Phase-specific execution strategies

Each phase type requires different code-change logic:

### Phase 1: Dead code cleanup
- Delete the symbol/export
- Verify no consumers: `codegraph fn-impact <target> -T --json`
- Remove any orphaned imports
- Run lint to clean up

### Phase 2: Shared abstractions
- Extract function/interface to new or existing file
- Update imports in all consumers
- Verify with: `codegraph exports <file> -T --json`

### Phase 3: Empty catches / error handling
- Replace `catch {}` with `catch (e) { logger.debug(...) }` or explicit fallback
- Use contextually appropriate error handling
- Subphases: each distinct catch pattern = one commit

### Phase 4: Extractor decomposition
- Split large `walkXNode` switch cases into handler functions
- Keep dispatcher thin — handler per node kind
- Subphases: each extractor = one commit

### Phase 5: General decomposition
- Read the gauntlet recommendation for the specific target
- Apply the recommended decomposition strategy
- Subphases: each function split = one commit

### Phase 6: Small FAIL fixes
- Read the gauntlet recommendation for the specific target
- Apply the recommended fix (complexity reduction, metric improvement)
- Group by domain where possible

---

## Step 2 — Per-target execution loop

For each target in the current phase:

1. **Skip if done.** Check if target is already in `execution.completedTargets`. If so, skip.

2. **Update state.** Set `execution.currentTarget` in `titan-state.json`.

3. **Read gauntlet entry.** Find this target in `gauntlet.ndjson` → get recommendation, violations, metrics.

4. **Understand before touching.** Run codegraph commands:
   ```bash
   codegraph context <target> -T --json
   ```
   If blast radius > 0:
   ```bash
   codegraph fn-impact <target> -T --json
   ```

5. **Check if already fixed.** If the file has changed since gauntlet ran, re-check metrics:
   ```bash
   codegraph complexity --file <file> --health -T --json
   ```
   If the target now passes all thresholds, skip with note: "Target already passes — skipping."

6. **Read source file(s).** Understand the code before editing.

7. **Apply the change** based on phase strategy (Step 1) + gauntlet recommendation.

8. **Run tests:**
   ```bash
   npm test 2>&1
   ```
   If tests fail → go to rollback (step 10).

9. **Run /titan-gate:**
   Use the Skill tool to invoke `titan-gate`. If FAIL → go to rollback (step 10).

10. **On success:**
    ```bash
    git add <specific changed files>
    git commit -m "<commit message from sync.json>"
    ```
    - Record commit SHA in `execution.commits`
    - Add target to `execution.completedTargets`
    - Update `titan-state.json`

11. **On failure (test or gate):**
    ```bash
    git checkout -- <changed files>
    ```
    - Add to `execution.failedTargets` with reason: `{ "target": "<name>", "reason": "<why>", "phase": N }`
    - Clear `execution.currentTarget`
    - **Continue to next target** — don't block the whole phase

---

## Step 3 — Phase completion

When all targets in the phase are processed:

1. Add phase number to `execution.completedPhases`
2. Advance `execution.currentPhase` to the next phase number
3. Clear `execution.currentTarget`
4. Write updated `titan-state.json`

---

## Step 4 — Report

Print:

```
## Phase N Complete: <label>

Targets: X/Y completed, Z failed
Commits: N
Files changed: N

### Failed targets (if any):
- <target>: <reason>

### Next: Phase M — <label> (N targets)
Run /titan-forge to continue.
```

If all phases are complete:

```
## All phases complete

Total commits: N
Total targets: X completed, Y failed
Failed targets: <list or "none">

Run /titan-gate on the full branch to validate.
```

---

## Edge Cases

- **Test failure mid-phase:** Revert target, mark failed, continue. Don't block the whole phase.
- **Merge conflict with main:** Stop, report, ask user to resolve.
- **Gate detects new cycle:** Stop immediately — this is a real problem, not skippable.
- **Target already fixed on main:** Check if file has changed since gauntlet. If metrics now pass, skip with note.
- **Interrupted mid-phase:** Re-running picks up from `execution.currentTarget`. Already-committed targets are skipped.
- **`--dry-run`:** Walk through all targets, print what would be done (phase strategy, gauntlet recommendation, files affected), but make no changes.
- **`--target <name>`:** Run only that target. Useful for retrying entries in `failedTargets`.

---

## Rules

- **One phase per invocation.** Stop after the phase completes. User re-runs for next.
- **Resumable.** If interrupted, re-running picks up where it left off.
- **Always use `--json` and `-T`** for codegraph commands.
- **Gate before commit.** Every commit must pass `/titan-gate`. No exceptions.
- **One commit per logical unit.** Use commit messages from `sync.json`.
- **Stage only specific files.** Never `git add .` or `git add -A`.
- **Rollback on failure is gentle** — `git checkout -- <files>`, not `git reset --hard`.
- **Subphase awareness** — phases 3-6 have subphases. Each subphase = one commit. Track at subphase level.
- **Never skip `/titan-gate`.** Even for "trivial" changes.

## Relationship to Other Skills

| Skill | Produces | Used by /titan-forge |
|-------|----------|---------------------|
| `/titan-recon` | `titan-state.json`, `GLOBAL_ARCH.md` | State tracking, domain context |
| `/titan-gauntlet` | `gauntlet.ndjson`, `gauntlet-summary.json` | Per-target recommendations |
| `/titan-sync` | `sync.json` | Execution plan (phases, targets, commits) |
| `/titan-gate` | Gate verdict | Called per-commit for validation |
| `/titan-reset` | Clean slate | Removes all artifacts |

## Self-Improvement

This skill lives at `.claude/skills/titan-forge/SKILL.md`. Edit if phase strategies need refinement or execution loop needs adjustment after dogfooding.
