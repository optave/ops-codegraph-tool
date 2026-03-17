---
name: titan-sync
description: Identify overlapping fixes across audit results, plan shared abstractions, produce an ordered execution plan with logical commit grouping (Titan Paradigm Phase 3)
argument-hint:
allowed-tools: Bash, Read, Write, Glob, Grep, Edit
---

# Titan GLOBAL SYNC — Cross-Cutting Analysis & Execution Plan

You are running the **GLOBAL SYNC** phase of the Titan Paradigm.

Your goal: analyze GAUNTLET results to find overlapping problems, identify shared abstractions that should be built *before* individual fixes, group changes into logical commits, and produce an ordered execution plan.

> **Context budget:** This phase reads artifacts, not source. Keep codegraph queries targeted — only for specific relationship questions between failing targets.

---

## Step 0 — Pre-flight: find or join the Titan worktree

1. **Locate the Titan session.** Prior phases (RECON, GAUNTLET) may have run in a different worktree or branch. Search for it:

   ```bash
   git worktree list
   ```

   For each worktree, check if it contains Titan artifacts:
   ```bash
   ls <worktree-path>/.codegraph/titan/titan-state.json 2>/dev/null
   ```

   Also check branches:
   ```bash
   git branch -a --list '*titan*'
   ```

   **Decision logic:**
   - **Found exactly one worktree with `titan-state.json` and `currentPhase` is `"gauntlet"`:** GAUNTLET completed — this is the right session. Merge its branch into your worktree.
   - **Found a worktree but `currentPhase` is not `"gauntlet"`:** Suspicious — could be mid-phase or a different run. If `currentPhase` is `"recon"`, GAUNTLET hasn't run yet. If `"sync"` or later, someone else may be ahead. Ask the user: "Found Titan state at `<path>` with phase `<phase>`. Is this the session to continue?"
   - **Found multiple worktrees with `titan-state.json`:** List them with `currentPhase` and `lastUpdated`. Ask the user which to continue.
   - **Found a branch (not worktree) with titan artifacts:** Merge it: `git merge <titan-branch> --no-edit`
   - **Found nothing:** Stop: "No Titan artifacts found. Run `/titan-recon` then `/titan-gauntlet` first."

2. **Ensure worktree isolation:**
   ```bash
   git rev-parse --show-toplevel && git worktree list
   ```
   If not in a worktree, stop: "Run `/worktree` first."

3. **Sync with main:**
   ```bash
   git fetch origin main && git merge origin/main --no-edit
   ```
   If there are merge conflicts, stop: "Merge conflict detected. Resolve conflicts and re-run `/titan-sync`."

4. **Load artifacts.** Read:
   - `.codegraph/titan/titan-state.json` — state, domains, batches, file audits
   - `.codegraph/titan/GLOBAL_ARCH.md` — architecture, dependency flow, shared types
   - `.codegraph/titan/gauntlet.ndjson` — per-target audit details
   - `.codegraph/titan/gauntlet-summary.json` — aggregated results

5. **Validate state.** If `titan-state.json` fails to parse, stop: "State file corrupted. Run `/titan-reset`."

6. **Check GAUNTLET completeness.** If `gauntlet-summary.json` has `"complete": false`:
   > "GAUNTLET incomplete (<N>/<M> batches). SYNC will plan based on known failures only. Run `/titan-gauntlet` first for a complete plan."

7. **Extract.** From artifacts, collect:
   - All FAIL and DECOMPOSE targets with violations and files
   - Common violation patterns by pillar
   - Community assignments
   - Dead symbols (cleanup candidates)
   - Domain boundaries and dependency flow

---

## Step 1 — Drift detection: has main moved since GAUNTLET?

The codebase may have changed between GAUNTLET and now. Detect this before planning on stale audit data.

1. **Compare main SHA:**
   ```bash
   git rev-parse origin/main
   ```
   Compare against `titan-state.json → mainSHA`. If identical, skip to Step 2.

2. **If main has advanced**, find what changed:
   ```bash
   git diff --name-only <mainSHA>..origin/main
   ```

3. **Cross-reference with GAUNTLET results.** Check which changed files overlap with:
   - Files that were audited (`gauntlet.ndjson → file` field)
   - FAIL/DECOMPOSE targets (the ones SYNC plans around)
   - Dead symbols targeted for removal

4. **Classify staleness:**

   | Level | Condition | Action |
   |-------|-----------|--------|
   | **none** | main unchanged | Continue normally |
   | **low** | Changed files don't overlap with any audited targets | Continue — note drift |
   | **moderate** | Some FAIL/DECOMPOSE targets are in changed files (<30% affected) | Continue but **flag affected targets** — their audit results may be outdated. Mark clusters containing them as `"needs-verification"` |
   | **high** | >30% of FAIL targets affected OR shared dependencies changed | **Warn user:** "Main has changed significantly since GAUNTLET. Audit results for N targets may be stale. Recommend `/titan-gauntlet` re-run for affected targets before planning." |
   | **critical** | New files added to src/ that would be in priority queue, or deleted files that were FAIL targets | **Stop:** "Codebase structure changed. Run `/titan-recon` to rebuild baseline, then `/titan-gauntlet`." |

5. **Append drift report** to `.codegraph/titan/drift-report.json` (the file is a JSON array — read existing entries, push the new entry, write back; same schema as GAUNTLET, with `"detectedBy": "sync"`).

6. **Update state:** Set `titan-state.json → mainSHA` to current `origin/main`.

7. **If `moderate`:** Proceed but annotate affected clusters in `sync.json` with `"driftWarning": true`. The execution order should prioritize non-stale targets and defer stale ones pending re-audit.

8. **If re-running SYNC** and a previous `drift-report.json` exists with `reassessmentScope.targets`, re-read GAUNTLET results only for those targets and rebuild affected clusters.

---

## Step 2 — Find dependency clusters among failing targets

For FAIL/DECOMPOSE targets that share a file or community, check connections:

```bash
codegraph path <target1> <target2> -T --json
```

Group connected failures into **clusters**. Also check for cycles among them:

```bash
codegraph cycles --functions --json
```

Filter to cycles including at least one FAIL/DECOMPOSE target.

---

## Step 3 — Identify shared dependencies and ownership

For each cluster, find what they share:

```bash
codegraph deps <key-file> --json
```

Look for:
- **Shared imports:** multiple failures import the same module → interface extraction candidate
- **Shared callers:** multiple failures called by the same function → caller needs updating
- **Common violations:** similar pillar violations across targets

Check **code ownership** for cross-team coordination:

```bash
codegraph owners <file1> <file2> -T --json
```

If different teams own files in the same cluster, note the coordination requirement.

Run **branch structural diff** to see what's already changed:

```bash
codegraph branch-compare main HEAD -T --json
```

Avoid re-auditing or conflicting with in-progress work.

---

## Step 4 — Detect extraction candidates

For DECOMPOSE targets:

```bash
codegraph context <target> -T --json
codegraph ast --kind call --file <file> -T --json
```

Look for:
- Functions with multiple responsibilities (high cognitive + high fan-out + high `halstead.bugs`)
- Repeated patterns across failures (similar call chains)
- God files (many failing functions → split along community boundaries)

---

## Step 5 — Plan shared abstractions

Identify what to build BEFORE individual fixes:

1. **Interface extractions** — shared dependency → extract interface
2. **Utility extractions** — repeated patterns → shared utility
3. **Module splits** — god files → split by community structure
4. **Cycle breaks** — circular deps → identify weakest link

For each, check blast radius:
```bash
codegraph fn-impact <shared-dep> -T --json
```

---

## Step 6 — Build execution order with logical commits

### Phases (in order)

1. **Dead code cleanup** — zero risk, reduces noise
   - Commit: `chore: remove dead code`
2. **Shared abstractions** — before individual fixes
   - One commit per abstraction: `refactor: extract X from Y`
3. **Cycle breaks** — unblocks dependent targets
   - One commit per break: `refactor: break cycle between X and Y`
4. **Decompositions** — highest risk, after abstractions
   - One commit per decomposition: `refactor: split X into A and B`
5. **Fail fixes** — ordered by blast radius (lowest first)
   - Group by domain: `fix: address quality issues in <domain>`
6. **Warn improvements** — optional, lowest priority
   - Group by domain: `refactor: address warnings in <domain>`

### Ordering within each phase
- Dependencies first (if A depends on B, fix B first)
- Lower blast radius first
- Same community together

### Each commit should:
- Touch one domain where possible
- Address one concern
- Be independently revertible
- Run `/titan-gate` before committing

---

## Step 7 — Write the SYNC artifact

Write `.codegraph/titan/sync.json`:

```json
{
  "phase": "sync",
  "timestamp": "<ISO 8601>",
  "clusters": [
    {
      "id": 1,
      "name": "<descriptive>",
      "targets": ["t1", "t2"],
      "sharedDeps": ["mod"],
      "hasCycle": false,
      "owners": ["team-a", "team-b"],
      "proposedAction": "Extract interface"
    }
  ],
  "abstractions": [
    {
      "type": "interface_extraction|utility_extraction|module_split|cycle_break",
      "description": "...",
      "source": "<current location>",
      "unblocks": ["t1", "t2"],
      "blastRadius": 0,
      "commit": "refactor: ..."
    }
  ],
  "executionOrder": [
    {
      "phase": 1,
      "label": "Dead code cleanup",
      "targets": ["sym1", "sym2"],
      "risk": "none",
      "commit": "chore: remove dead code",
      "dependencies": []
    }
  ],
  "deadCodeTargets": ["<from recon>"],
  "cyclesInvolvingFailures": []
}
```

Update `titan-state.json`: set `currentPhase` to `"sync"`.

---

## Step 8 — Report to user

Print:
- Dependency clusters found (count)
- Shared abstractions proposed (count)
- Execution order summary (phases, target counts, estimated commits)
- Key insight: what SYNC prevented (e.g., "3 targets share configLoader — without SYNC, 3 conflicting refactors")
- Path to `sync.json`
- Next step: start Phase 1 (dead code cleanup), validate each commit with `/titan-gate`

---

## Issue Tracking

Throughout this phase, if you encounter any of the following, append a JSON line to `.codegraph/titan/issues.ndjson`:

- **Codegraph bugs:** incorrect path queries, wrong cycle detection, relationship errors
- **Tooling issues:** artifact parsing failures, state inconsistencies
- **Process suggestions:** better clustering strategies, execution order improvements
- **Codebase observations:** cross-cutting concerns not captured by GAUNTLET

Format (one JSON object per line, append-only):

```json
{"phase": "sync", "timestamp": "<ISO 8601>", "severity": "bug|limitation|suggestion", "category": "codegraph|tooling|process|codebase", "description": "<what happened>", "context": "<command, cluster, or artifact involved>"}
```

Log issues as they happen — don't batch them. The `/titan-close` phase compiles these into the final report.

---

## Rules

- **Read artifacts, don't re-scan.** Codegraph commands only for targeted relationship queries.
- **Always use `--json` and `-T`.**
- **The execution order is the key output.**
- **Logical commits matter.** Never mix concerns.
- If GAUNTLET found zero failures, produce minimal plan (dead code + warnings only).
- Keep `codegraph path` queries targeted — same file or community only.
- If any command fails or produces unexpected output, **log it to `issues.ndjson`** before continuing.

## Self-Improvement

This skill lives at `.claude/skills/titan-sync/SKILL.md`. Edit if clustering misses connections or execution order causes conflicts.
