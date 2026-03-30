---
name: titan-run
description: Run the full Titan Paradigm pipeline end-to-end by dispatching each phase to sub-agents with fresh context windows. Orchestrates recon → gauntlet → sync → forge automatically.
argument-hint: <path (default: .)> <--skip-recon> <--skip-gauntlet> <--start-from recon|gauntlet|sync|forge> <--gauntlet-batch-size 5> <--yes>
allowed-tools: Agent, Read, Bash, Glob, Write, Edit
---

# Titan RUN — End-to-End Pipeline Orchestrator

You are the **orchestrator** for the full Titan Paradigm pipeline. Your job is to dispatch each phase to a **sub-agent** (fresh context window), **validate the results**, and loop phases that require multiple invocations — all without human intervention.

> **You are lightweight.** You do NOT run codegraph commands, audit files, or make code changes yourself. You only: (1) spawn sub-agents, (2) read and validate state files, (3) decide what to run next.

**Arguments** (from `$ARGUMENTS`):
- No args → full pipeline from scratch, target `.`
- `<path>` → target path (passed to recon)
- `--skip-recon` → skip recon (assumes artifacts exist)
- `--skip-gauntlet` → skip gauntlet (assumes artifacts exist)
- `--start-from <phase>` → jump to phase: `recon`, `gauntlet`, `sync`, `forge`
- `--gauntlet-batch-size <N>` → batch size for gauntlet (default: 5)
- `--yes` → skip all confirmation prompts in the orchestrator (pre-pipeline, forge checkpoint, and resume prompts) and in forge (per-phase confirmation)

---

## Step 0 — Pre-flight

1. **Worktree check:**
   ```bash
   git rev-parse --show-toplevel && git worktree list
   ```
   The Titan pipeline writes artifacts and makes code changes — worktree isolation is required. If you are NOT in a worktree, **create one automatically** using the `EnterWorktree` tool (fetch it via `ToolSearch` if needed) with name `titan-run`. Do NOT stop and ask the user — just enter the worktree and continue.

2. **Parse arguments.** Determine:
   - `targetPath` (default: `.`)
   - `startPhase` (default: `recon`)
   - `gauntletBatchSize` (default: `5`)
   - `autoConfirm` → `true` if `--yes` is present, otherwise `false`

3. **Check existing state.** Read `.codegraph/titan/titan-state.json` if it exists.
   - If state exists and `--start-from` not specified, ask user: "Existing Titan state found (phase: `<currentPhase>`). Resume from current state, or start fresh with `/titan-reset` first?"
   - If `--yes` is set, resume automatically.

   **Initialize the phase timestamps helper.** Throughout the pipeline, you will record wall-clock timestamps for each phase. Use this helper to write them into `titan-state.json`:

   ```bash
   # Record phase start:
   node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('.codegraph/titan/titan-state.json','utf8'));s.phaseTimestamps=s.phaseTimestamps||{};s.phaseTimestamps['<PHASE>']=s.phaseTimestamps['<PHASE>']||{};s.phaseTimestamps['<PHASE>'].startedAt=new Date().toISOString();fs.writeFileSync('.codegraph/titan/titan-state.json',JSON.stringify(s,null,2));"

   # Record phase completion:
   node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('.codegraph/titan/titan-state.json','utf8'));s.phaseTimestamps=s.phaseTimestamps||{};s.phaseTimestamps['<PHASE>']=s.phaseTimestamps['<PHASE>']||{};s.phaseTimestamps['<PHASE>'].completedAt=new Date().toISOString();fs.writeFileSync('.codegraph/titan/titan-state.json',JSON.stringify(s,null,2));"
   ```

   Replace `<PHASE>` with `recon`, `gauntlet`, `sync`, `forge`, or `close`. **Run the start command immediately before dispatching each phase's first sub-agent, and the completion command immediately after post-phase validation passes.** If resuming a phase (e.g., gauntlet loop iteration 2+), do NOT overwrite `startedAt` — only set it if it doesn't already exist.

4. **Sync with main** (once, before any sub-agent runs):
   ```bash
   git fetch origin main && git merge origin/main --no-edit
   ```
   If merge conflict → stop: "Merge conflict after syncing with main. Resolve conflicts and re-run `/titan-run`."

5. **Print plan:**
   ```
   Titan Pipeline — End-to-End Run
   Target: <path>
   Starting from: <phase>
   Gauntlet batch size: <N>

   Phases: recon → gauntlet (loop) → sync → [PAUSE] → forge (loop)
   Each phase runs in a sub-agent with a fresh context window.
   Forge requires explicit confirmation (analysis phases are safe to automate).
   ```

   Start immediately — do NOT ask for confirmation before analysis phases. The user invoked `/titan-run`; that is the confirmation. Analysis phases (recon, gauntlet, sync) are read-only and safe to automate. The forge checkpoint (Step 3.5b) still applies unless `--yes` is set.

---

## Pre-Agent Gate (run before EVERY sub-agent dispatch)

Before spawning any sub-agent, run these checks. This catches git state drift, concurrent interference, and corruption left by a crashed agent.

### G1. Git health check
```bash
git status --porcelain
```
- **Unexpected dirty files** (files not in `.codegraph/titan/`): Print warning with the file list. Ask user to confirm proceeding, or stop. If `--yes`, log the warning and continue — but do NOT stage or commit these files.
- **Merge conflicts** (lines starting with `UU`, `AA`, `DD`, `AU`, `UA`, `DU`, `UD`): Stop immediately: "Unresolved merge conflict detected. Resolve before continuing."

### G2. Worktree still valid
```bash
git rev-parse --is-inside-work-tree
```
If this fails (worktree was pruned or moved), stop: "Worktree is no longer valid. Create a new one with `/worktree`."

### G3. State file integrity
If `.codegraph/titan/titan-state.json` should exist at this point (i.e., we're past recon):
```bash
node -e "try { JSON.parse(require('fs').readFileSync('.codegraph/titan/titan-state.json','utf8')); console.log('OK'); } catch(e) { console.log('CORRUPT: '+e.message); process.exit(1); }"
```
- If **CORRUPT** → attempt recovery from backup:
  1. Check if `.codegraph/titan/titan-state.json.bak` exists.
  2. If the backup exists, validate it is valid JSON:
     ```bash
     node -e "try { JSON.parse(require('fs').readFileSync('.codegraph/titan/titan-state.json.bak','utf8')); console.log('BACKUP OK'); } catch(e) { console.log('BACKUP CORRUPT: '+e.message); process.exit(1); }"
     ```
  3. If the backup is valid → restore it: `cp .codegraph/titan/titan-state.json.bak .codegraph/titan/titan-state.json`
  4. If the backup is also corrupt or missing → stop: "State file corrupted with no valid backup. Run `/titan-reset` and start over."

### G4. State backup
Before every sub-agent dispatch, back up the current state file:
```bash
cp .codegraph/titan/titan-state.json .codegraph/titan/titan-state.json.bak 2>/dev/null || true
```
If a sub-agent corrupts the state, G3 on the next iteration will detect it and restore from `.bak`.

---

## Step 0.5 — Artifact pre-validation (phase skip)

**Run this step if `--start-from` was specified, `--skip-recon` is set, or `--skip-gauntlet` is set.** Any of these flags cause phases to be skipped — their artifacts must exist and be valid before proceeding. When `--skip-recon` is set, validate recon artifacts. When `--skip-gauntlet` is set, validate both recon and gauntlet artifacts.

For each phase BEFORE `startPhase`, run the corresponding V-checks:

| Skipped phase | Required artifacts + checks |
|---------------|-----------------------------|
| `recon` | V1 structural fields only (domains, batches, priorityQueue, stats — skip `currentPhase == "recon"` check since later phases advance it), V2 (GLOBAL_ARCH.md), V3 (snapshot exists — WARN if missing), V4 (cross-check counts) |
| `gauntlet` | V5 (coverage ≥ 50%), V6 (entry completeness sample), V7 (summary consistency); also run NDJSON integrity check (2c) |
| `sync` | V8 (sync.json structure), V9 (targets trace to gauntlet), V10 (dependency order) |

If ANY required artifact is **missing** → stop: "Cannot start from `<phase>` — `<artifact>` is missing. Run the full pipeline or start from an earlier phase."

If ANY V-check that is normally VALIDATION FAILED would fail → stop with the same message as it would during normal execution.

WARN-level V-checks from skipped phases are surfaced as prefixed warnings: "[skipped-phase pre-validation] <warning text>" — they do not stop the pipeline.

---

## Step 1 — RECON

**Skip if:** `--skip-recon`, `--start-from` is after recon, or `titan-state.json` already has `currentPhase` beyond `"recon"`.

### 1a. Run Pre-Agent Gate (G1-G4)

### 1a.1. Record phase start timestamp
Record `phaseTimestamps.recon.startedAt` (only if not already set — it may exist from a prior crashed run).

### 1b. Dispatch sub-agent

Use the **Agent tool** to spawn a sub-agent:

```
prompt: |
  You are running the Titan RECON phase. Read and follow the skill file at
  .claude/skills/titan-recon/SKILL.md exactly. Target path: <targetPath>.

  IMPORTANT: Skip the worktree check (Step 0.1) — the orchestrator already verified this.
  IMPORTANT: Skip the "sync with main" step (Step 0.2) — the orchestrator already did this.
  Execute Steps 1-13 as documented.
```

### 1c. Post-phase validation

After the agent returns, validate the artifacts:

**V1. titan-state.json structure:**
Read `.codegraph/titan/titan-state.json` and verify ALL of these fields exist and are non-empty:
- `version` — must be a number
- `initialized` — must be an ISO 8601 string
- `currentPhase` — must equal `"recon"`
- `stats.totalNodes` — must be > 0
- `stats.totalEdges` — must be > 0
- `stats.totalFiles` — must be > 0
- `domains` — must be an array with length > 0
- `batches` — must be an array with length > 0
- `priorityQueue` — must be an array with length > 0

If any field is missing, zero, or wrong type → **VALIDATION FAILED.** Print which fields failed and stop: "RECON produced incomplete state. Re-run with `/titan-run --start-from recon`."

**V2. GLOBAL_ARCH.md exists and has content:**
Read `.codegraph/titan/GLOBAL_ARCH.md`:
- Must exist
- Must contain `## Domain Map` heading
- Must have > 10 lines

If missing or empty → **VALIDATION FAILED.**

**V3. Snapshot created:**
```bash
codegraph snapshot list 2>/dev/null | grep titan-baseline || echo "NO_SNAPSHOT"
```
If `NO_SNAPSHOT` → **WARN** (not fatal, but note it: "No baseline snapshot — rollback in GATE will not work").

**V4. Cross-check counts:**
- `titan-state.json → stats.totalFiles` should roughly match the number of targets across all batches (batches are subsets of files, so `sum(batch.files.length)` should be ≤ `totalFiles`)
- `priorityQueue.length` should be > 0 and ≤ `totalNodes`
- **Batch size check:** Every batch must have ≤ 5 files. If any batch exceeds 5, **WARN**: "Batch <id> has <N> files (max 5). Large batches cause context overload in gauntlet sub-agents."

If wildly inconsistent (e.g., 0 batches but 500 nodes) → **WARN** with details.

Print: `RECON validated. Domains: <count>, Batches: <count>, Priority targets: <count>, Quality score: <score>`

Record `phaseTimestamps.recon.completedAt`.

---

## Step 2 — GAUNTLET (loop)

**Skip if:** `--skip-gauntlet` or `--start-from` is after gauntlet.

### 2a. Pre-loop check

Record `phaseTimestamps.gauntlet.startedAt` (only if not already set — gauntlet may be resuming).

Read `.codegraph/titan/gauntlet-summary.json` if it exists:
- If `"complete": true` → run gauntlet post-validation (2d) and skip loop if it passes
- Otherwise, count completed batches from `titan-state.json` for progress tracking

Compute `expectedTargetCount` from `titan-state.json → priorityQueue.length` (or sum of batch file counts). This is the ground truth for "how many targets should gauntlet audit."

### 2b. Gauntlet loop

Set `maxIterations = 50` (safety limit).
Set `stallCount = 0`, `maxStalls = 3` (consecutive no-progress iterations before abort).

```
previousAuditedCount = titan-state.json → progress.audited (or 0)
iteration = 0

while iteration < maxIterations:
    iteration += 1

    # Run Pre-Agent Gate (G1-G4)

    # Dispatch sub-agent
    Agent → "Run /titan-gauntlet with batch size <N>.
             Read .claude/skills/titan-gauntlet/SKILL.md and follow it exactly.
             Batch size: <gauntletBatchSize>.
             Skip worktree check and main sync — already handled.
             Process as many batches as context allows, then save state and stop."

    # Check completion
    Read .codegraph/titan/gauntlet-summary.json (if exists)
    if "complete": true → break

    # Progress tracking
    Read .codegraph/titan/titan-state.json
    currentAuditedCount = progress.audited

    if currentAuditedCount == previousAuditedCount:
        stallCount += 1
        Print: "WARNING: Gauntlet iteration <iteration> made no progress (stall <stallCount>/<maxStalls>)"
        if stallCount >= maxStalls:
            Stop: "Gauntlet stalled for <maxStalls> consecutive iterations at <currentAuditedCount>/<expectedTargetCount> targets. Likely stuck on a problematic target. Check gauntlet.ndjson for the last successful entry and investigate the next target in the batch."
    else:
        stallCount = 0  # reset on any progress

    countBeforeUpdate = previousAuditedCount
    previousAuditedCount = currentAuditedCount

    # Efficiency check: if progress is very slow (< 2 targets per iteration), warn
    # Only fire when stallCount == 0 — if stalled, the stall warning already covers it
    targetsThisIteration = currentAuditedCount - countBeforeUpdate
    if targetsThisIteration == 1 and iteration > 3 and stallCount == 0:
        Print: "WARNING: Only 1 target per iteration — agent may be spending too much context. Consider increasing batch size."

    Print: "Gauntlet iteration <iteration>: <currentAuditedCount>/<expectedTargetCount> targets audited"
```

### 2c. NDJSON integrity check

After the loop completes (or on each iteration if you prefer lightweight checks):

```bash
node -e "
const fs = require('fs');
const path = '.codegraph/titan/gauntlet.ndjson';
if (!fs.existsSync(path)) {
  console.log(JSON.stringify({ valid: 0, corrupt: 0, total: 0, missing: true }));
  process.exit(0);
}
const lines = fs.readFileSync(path,'utf8').trim().split('\n');
let valid = 0, corrupt = 0;
for (const line of lines) {
  try { JSON.parse(line); valid++; } catch { corrupt++; }
}
console.log(JSON.stringify({ valid, corrupt, total: lines.length, missing: false }));
"
```

- If `missing == true`: treat as equivalent to `valid == 0` — the file does not exist yet (expected on first iteration, error if the loop should have produced entries).
- If `corrupt > 0`: Print "WARNING: <corrupt> corrupt lines in gauntlet.ndjson (likely from a crashed sub-agent). These targets may need re-auditing."
- If `valid == 0` and `missing == false`: Stop: "gauntlet.ndjson has no valid entries. Something went wrong."

### 2d. Post-loop validation

**V5. Gauntlet coverage:**
- Count distinct `target` values in `gauntlet.ndjson` (valid lines only)
- Compare against `expectedTargetCount`
- If coverage < 80%: **WARN** "Gauntlet only audited <N>/<M> targets (<pct>%). Consider re-running with `/titan-run --start-from gauntlet`."
- If coverage < 50%: **VALIDATION FAILED.** Stop.

**V6. Gauntlet entry completeness (sample check):**
Read first 5 and last 5 entries from `gauntlet.ndjson`. Each entry MUST have:
- `target` — non-empty string
- `file` — non-empty string
- `verdict` — one of `PASS`, `WARN`, `FAIL`, `DECOMPOSE`
- `pillarVerdicts` — object with keys `I`, `II`, `III`, `IV`
- `metrics` — object with at least `cognitive` and `cyclomatic` (numeric)
- `violations` — array

If any sampled entry is missing required fields → **WARN**: "Gauntlet entry for <target> is incomplete — sub-agent may have skipped rules. Fields missing: <list>."

**V7. Summary consistency:**
Read `gauntlet-summary.json`:
- `summary.totalAudited` should equal the valid NDJSON line count
- `summary.pass + summary.warn + summary.fail + summary.decompose` should equal `summary.totalAudited`

If mismatched → **WARN** with details (not fatal — the NDJSON is the source of truth, summary is derived).

Print: `GAUNTLET validated. Audited: <N>/<M> targets. Pass: <N>, Warn: <N>, Fail: <N>, Decompose: <N>. NDJSON integrity: <valid>/<total> lines OK.`

Record `phaseTimestamps.gauntlet.completedAt`.

---

## Step 3 — SYNC

**Skip if:** `--start-from` is after sync, or `titan-state.json` has `currentPhase: "sync"` with existing `sync.json`.

### 3a. Run Pre-Agent Gate (G1-G4)

### 3a.1. Record phase start timestamp
Record `phaseTimestamps.sync.startedAt`.

### 3b. Dispatch sub-agent

```
Agent → "Run /titan-sync. Read .claude/skills/titan-sync/SKILL.md and follow it exactly.
         Skip worktree check and main sync — already handled.
         Read GAUNTLET artifacts and produce sync.json."
```

### 3c. Post-phase validation

**V8. sync.json structure:**
Read `.codegraph/titan/sync.json` and verify:
- `phase` — must equal `"sync"`
- `executionOrder` — must be an array with length > 0
- Each entry in `executionOrder` must have: `phase` (number), `label` (string), `targets` (array), `commit` (string)
- `executionOrder` phases must be in ascending order
- No duplicate phase numbers

If missing or structurally invalid → **VALIDATION FAILED.** Stop: "SYNC produced invalid plan. Re-run with `/titan-run --start-from sync`."

**V9. Sync targets trace back to gauntlet:**
Collect all target names from `sync.json → executionOrder[*].targets` (flatten).
For each, verify it appears in `gauntlet.ndjson` as a `target` field, OR in `titan-state.json → roles.deadSymbols` (dead code targets come from recon, not gauntlet).

If > 20% of sync targets have no gauntlet entry and aren't dead symbols → **WARN**: "SYNC references <N> targets not found in gauntlet results. The sub-agent may have hallucinated targets."

**V10. Execution order dependency check:**
For entries with `dependencies` arrays, verify that each dependency phase number exists in `executionOrder` and has a lower phase number. Circular dependencies in the execution plan → **VALIDATION FAILED.**

Print: `SYNC validated. Execution phases: <N>, Total targets: <N>, Estimated commits: <N>.`

Record `phaseTimestamps.sync.completedAt`.

---

## Step 3.5 — Pre-forge: Architectural Snapshot + Human Checkpoint

**Skip if:** `--start-from` is `forge` AND `.codegraph/titan/arch-snapshot.json` already exists. The existing snapshot is the correct pre-forge baseline — re-capturing it mid-forge would overwrite it with a state that already includes prior forge commits, making gate A1/A3 comparisons inaccurate.

If `--start-from forge` is used **without** an existing snapshot, run Step 3.5a normally (captures a pre-forge baseline from the current committed state).

### 3.5a. Capture architectural snapshot

Before any code changes, snapshot the codebase's architectural properties. This becomes the baseline for the architectural comparator in `/titan-gate` (Step 5.5).

```bash
codegraph communities -T --json > .codegraph/titan/arch-snapshot-communities.json
codegraph structure --depth 2 --json > .codegraph/titan/arch-snapshot-structure.json
codegraph communities --drift -T --json > .codegraph/titan/arch-snapshot-drift.json
```

Combine into a single snapshot file:

```bash
TITAN_HEAD_SHA=$(git rev-parse HEAD)
node -e "
const fs = require('fs');
try {
  const communities = JSON.parse(fs.readFileSync('.codegraph/titan/arch-snapshot-communities.json','utf8'));
  const structure = JSON.parse(fs.readFileSync('.codegraph/titan/arch-snapshot-structure.json','utf8'));
  const drift = JSON.parse(fs.readFileSync('.codegraph/titan/arch-snapshot-drift.json','utf8'));
  const snapshot = {
    timestamp: new Date().toISOString(),
    capturedBefore: 'forge',
    headSha: '$TITAN_HEAD_SHA',
    communities,
    structure,
    drift
  };
  fs.writeFileSync('.codegraph/titan/arch-snapshot.json', JSON.stringify(snapshot, null, 2));
} catch (e) {
  console.error('WARNING: Failed to build arch-snapshot.json: ' + e.message);
  console.error('Architectural comparison (titan-gate A1/A3/A4) will be skipped.');
}
"
```

Clean up temp files:
```bash
rm -f .codegraph/titan/arch-snapshot-communities.json .codegraph/titan/arch-snapshot-structure.json .codegraph/titan/arch-snapshot-drift.json
```

This snapshot is read by `/titan-gate` Step 5.5 during every commit validation.

### 3.5b. Human checkpoint

**This is a mandatory pause.** Analysis phases (recon, gauntlet, sync) are read-only. FORGE makes real code changes and commits. The user must see the plan.

First, determine the snapshot status from Step 3.5a:
```
snapshotStatus = file_exists('.codegraph/titan/arch-snapshot.json') ? "captured" : "FAILED — gate A1/A3/A4 will be skipped"
```

**Divergence check** — compute before printing the checkpoint so the warning appears inline:
```bash
if git fetch origin main 2>/dev/null; then
  mergeBase=$(git merge-base HEAD origin/main)
  mainAdvance=$(git rev-list --count $mergeBase..origin/main)
else
  mainAdvance="unknown"
fi
```
```
mainAdvanceNote = mainAdvance == "unknown"
  ? "NOTE: Could not fetch origin/main — skipping divergence check."
  : mainAdvance > 0
    ? "WARNING: main has advanced <mainAdvance> commits since initial sync.\nIf significant, consider re-running: /titan-run --start-from recon"
    : ""
```

Print:
```
================================================================
  ANALYSIS COMPLETE — FORGE CHECKPOINT
================================================================

The analysis phases (recon → gauntlet → sync) are done.
FORGE will now make code changes and commit them.

Execution plan summary:
  Phase 1: <label> — <N> targets
  Phase 2: <label> — <N> targets
  ...

Total: <N> phases, <N> targets, <N> estimated commits

Architectural snapshot: <snapshotStatus>
<mainAdvanceNote>

Validation layers per commit:
  1. Diff Review — does the change match the gauntlet recommendation and sync plan?
  2. Titan Gate — structural checks, semantic assertions, architectural comparison, lint/build/test

Proceed with /titan-forge? [y/n]
(Use --yes to skip this checkpoint in future runs)
================================================================
```

If `--yes` is NOT set: **stop and wait for user confirmation.** Do NOT proceed.
If `--yes` IS set: print the summary but continue automatically.

Once the user confirms (or `--yes` was set), `autoConfirm` is already `true` (set from `--yes` at parse time). If the user confirmed interactively (without `--yes`), set `autoConfirm = true` now — forge sub-agents must receive `--yes` to avoid per-phase confirmation prompts that cannot be answered in a sub-agent context.

---

## Step 4 — FORGE (loop)

### 4a. Pre-loop check

Record `phaseTimestamps.forge.startedAt` (only if not already set — forge may be resuming).

Read `.codegraph/titan/sync.json` → count total phases in `executionOrder`.
Read `.codegraph/titan/titan-state.json` → check `execution.completedPhases` (may not exist yet if forge hasn't started).

If `.codegraph/titan/arch-snapshot.json` does not exist:
  Print: "NOTE: No arch-snapshot.json found. Architectural comparison in /titan-gate (Step 5.5) will be skipped for this run. To enable it, run '/titan-run --start-from sync' to re-capture the pre-forge snapshot."

### 4b. Forge loop

Set `maxIterations = 20` (safety limit).
Set `stallCount = 0`, `maxStalls = 2` (forge stalls are more serious — fewer retries).

```
previousCompletedPhases = execution.completedPhases (or [])
previousCompletedTargets = execution.completedTargets (or [])
previousFailedTargets = execution.failedTargets (or [])
iteration = 0

while iteration < maxIterations:
    iteration += 1

    # Run Pre-Agent Gate (G1-G4) — CRITICAL for forge since it commits
    # Context: show recent commits so agent has context for V12 commit audit
    Print: git log --oneline -5
    # Record the HEAD sha before dispatching

    headBefore = $(git rev-parse HEAD)

    # Determine next phase
    Read .codegraph/titan/titan-state.json
    completedPhases = execution.completedPhases (or [])
    totalPhases = len(sync.json.executionOrder)
    if len(completedPhases) >= totalPhases → break

    nextPhase = first phase number NOT in completedPhases

    # Dispatch sub-agent
    yesFlag = "--yes" if autoConfirm else ""
    Agent → "Run /titan-forge --phase <nextPhase> <yesFlag>.
             Read .claude/skills/titan-forge/SKILL.md and follow it exactly.
             Skip worktree check and main sync — already handled.

             For each target, the validation flow is:
             1. Apply code change
             2. Stage files
             3. Diff review (Step 9 in forge) — verify diff matches gauntlet recommendation and sync plan intent
             4. Run tests
             5. Run /titan-gate — read .claude/skills/titan-gate/SKILL.md and follow it exactly.
                Gate now includes semantic assertions (Step 5) and architectural snapshot comparison (Step 5.5).
                The arch snapshot is at .codegraph/titan/arch-snapshot.json.
             6. Commit on success, rollback on failure

             Do NOT skip the diff review step — it catches intent drift before gate even runs."

    # Post-agent checks
    headAfter = $(git rev-parse HEAD)

    # V11. Verify commits were actually made (unless all targets failed)
    Read .codegraph/titan/titan-state.json
    newCompletedPhases = execution.completedPhases (or [])
    newCompletedTargets = execution.completedTargets (or [])
    newFailedTargets = execution.failedTargets (or [])

    # Count total targets processed (succeeded + failed) to distinguish true stalls from all-fail phases
    newProcessedCount = len(newCompletedTargets) + len(newFailedTargets)
    previousProcessedCount = len(previousCompletedTargets) + len(previousFailedTargets)

    if newCompletedPhases == previousCompletedPhases and newProcessedCount == previousProcessedCount:
        stallCount += 1
        Print: "WARNING: Forge iteration <iteration> made no progress (stall <stallCount>/<maxStalls>)"
        if stallCount >= maxStalls:
            Stop: "Forge stalled on phase <nextPhase> for <maxStalls> consecutive iterations. Check titan-state.json → execution.failedTargets for details."
    else:
        stallCount = 0

    previousCompletedPhases = newCompletedPhases
    previousCompletedTargets = newCompletedTargets
    previousFailedTargets = newFailedTargets

    # V12. Commit audit — verify commits match expectations
    if headAfter != headBefore:
        # Get commits made by this agent
        git log --oneline <headBefore>..<headAfter>
        commitCount = number of commits
        Print: "Forge phase <nextPhase>: <commitCount> commits, <completedCount> targets completed, <failedCount> targets failed"
    else:
        # No commits but phase may have completed (all targets failed/skipped)
        Print: "Forge phase <nextPhase>: no commits (all targets failed or skipped)"

    # V13. Test suite still green after forge commits (skip if no commits were made)
    if headAfter != headBefore:
        # Detect test command (same detection as gate Step 4):
        testCmd = node -e "const p=require('./package.json');const s=p.scripts||{};const script=s.test?'test':s['test:ci']?'test:ci':null;if(!script){console.log('NO_TEST_SCRIPT');process.exit(0);}const fs=require('fs');const runner=fs.existsSync('yarn.lock')?'yarn':fs.existsSync('pnpm-lock.yaml')?'pnpm':fs.existsSync('bun.lockb')?'bun':'npm';console.log(runner+(script==='test'?' test':' run '+script));"
        if testCmd == "NO_TEST_SCRIPT":
            Print: "V13: No test script configured — skipping post-forge test run."
        else:
            Run: <testCmd> 2>&1
            if tests fail:
                Print: "CRITICAL: Test suite fails after forge phase <nextPhase>. Stopping pipeline."
                Print: "Commits from this phase: git log --oneline <headBefore>..<headAfter>"
                Print: "Consider reverting: git revert <headBefore>..<headAfter>"
                Stop.
```

### 4c. Post-loop validation

**V14. Final state consistency:**
Read `.codegraph/titan/titan-state.json`:
- `execution.completedPhases` should contain all phase numbers from `sync.json → executionOrder`
- `execution.commits` should be an array (may be empty if all targets failed)
- Every commit SHA in `execution.commits` should exist in git log:
  ```bash
  git cat-file -t <sha>
  ```
  If any SHA doesn't exist → **WARN**: "Commit <sha> recorded in state but not found in git history. State may be out of sync."

**V15. Gate log consistency:**
If `.codegraph/titan/gate-log.ndjson` exists:
- Count PASS vs FAIL entries
- Every FAIL entry with `"rolledBack": true` should NOT have a corresponding commit in `execution.commits`

Print forge summary.

Record `phaseTimestamps.forge.completedAt`.

---

## Step 5 — CLOSE (report + PRs)

After forge completes, dispatch `/titan-close` to produce the final report with before/after metrics and split commits into focused PRs.

### 5a. Run Pre-Agent Gate (G1-G4)

### 5a.1. Record phase start timestamp
Record `phaseTimestamps.close.startedAt`.

### 5b. Dispatch sub-agent

```
Agent → "Run /titan-close. Read .claude/skills/titan-close/SKILL.md and follow it exactly.
         Skip worktree check and main sync — already handled."
```

### 5c. Post-phase validation

After the agent returns, verify:
- `.codegraph/titan/TITAN_REPORT.md` or `generated/titan/titan-report-*.md` exists and has content (> 20 lines)
- Print: "CLOSE complete. Report: <report path>"

If the agent created PRs, print the PR URLs.

Record `phaseTimestamps.close.completedAt`.

---

## Error Handling

- **Sub-agent returns error:** Print the error, stop, and tell the user which phase failed and how to retry (e.g., "Run `/titan-run --start-from gauntlet`").
- **State file missing when expected:** Stop with clear message about which prerequisite phase to run.
- **State file corrupt (JSON parse error):** Attempt restore from `.bak`. If no backup → stop: "State file corrupted. Run `/titan-reset` and start over."
- **NDJSON corrupt lines:** Warn but continue — partial results are better than none. The corrupt lines are logged so the user knows which targets to re-audit.
- **Merge conflict detected by pre-agent gate:** Stop immediately with the conflicting files listed.
- **Tests fail after forge phase:** Stop immediately. Print the failing phase's commits so the user can revert.
- **Validation failure (any V-check marked FAILED):** Stop with details. Warn-level V-checks are logged but don't stop the pipeline.

---

## Rules

- **You are the orchestrator, not the executor.** Never run codegraph commands, edit source files, or make commits yourself. Only spawn sub-agents and read state files. Exceptions (pure validation/snapshot, no code changes): the post-forge test run (V13), NDJSON integrity checks, the V3 baseline snapshot check (`codegraph snapshot list`), and the pre-forge architectural snapshot capture (Step 3.5a) are run directly by the orchestrator.
- **Run the Pre-Agent Gate (G1-G4) before EVERY sub-agent.** No exceptions.
- **One sub-agent at a time.** Phases are sequential — recon before gauntlet, gauntlet before sync, sync before forge.
- **Fresh context per sub-agent.** This is the whole point — each sub-agent gets a clean context window.
- **Read AND validate state files after every sub-agent.** Trust the on-disk state, not the sub-agent's text output — but verify the state is structurally sound.
- **Back up state before every sub-agent.** The `.bak` file is your safety net against mid-write crashes.
- **Mandatory pause before forge** unless `--yes` is set. Analysis is safe; code changes deserve human review.
- **Stall detection is strict for forge** (2 retries) and looser for gauntlet (3 retries) since gauntlet is more likely to hit context limits legitimately.
- **Respect --start-from.** Skip phases before the specified starting point, but verify their artifacts exist AND pass validation.
- **Pass --yes through to forge** if the user provided it, so forge skips its per-phase confirmation prompt. Within the orchestrator, `--yes` also skips the pre-pipeline, forge checkpoint, and resume prompts.

## Self-Improvement

This skill lives at `.claude/skills/titan-run/SKILL.md`. Edit if loop logic needs adjustment, error handling needs improvement, or new phases are added to the pipeline.
