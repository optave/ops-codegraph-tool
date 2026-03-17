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

3. **Load artifacts.** Read:
   - `.codegraph/titan/titan-state.json` — state, domains, batches, file audits
   - `.codegraph/titan/GLOBAL_ARCH.md` — architecture, dependency flow, shared types
   - `.codegraph/titan/gauntlet.ndjson` — per-target audit details
   - `.codegraph/titan/gauntlet-summary.json` — aggregated results

4. **Validate state.** If `titan-state.json` fails to parse, stop: "State file corrupted. Run `/titan-reset`."

5. **Check GAUNTLET completeness.** If `gauntlet-summary.json` has `"complete": false`:
   > "GAUNTLET incomplete (<N>/<M> batches). SYNC will plan based on known failures only. Run `/titan-gauntlet` first for a complete plan."

6. **Extract.** From artifacts, collect:
   - All FAIL and DECOMPOSE targets with violations and files
   - Common violation patterns by pillar
   - Community assignments
   - Dead symbols (cleanup candidates)
   - Domain boundaries and dependency flow

---

## Step 1 — Find dependency clusters among failing targets

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

## Step 2 — Identify shared dependencies and ownership

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

## Step 3 — Detect extraction candidates

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

## Step 4 — Plan shared abstractions

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

## Step 5 — Build execution order with logical commits

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

## Step 6 — Write the SYNC artifact

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

## Step 7 — Report to user

Print:
- Dependency clusters found (count)
- Shared abstractions proposed (count)
- Execution order summary (phases, target counts, estimated commits)
- Key insight: what SYNC prevented (e.g., "3 targets share configLoader — without SYNC, 3 conflicting refactors")
- Path to `sync.json`
- Next step: start Phase 1 (dead code cleanup), validate each commit with `/titan-gate`

---

## Rules

- **Read artifacts, don't re-scan.** Codegraph commands only for targeted relationship queries.
- **Always use `--json` and `-T`.**
- **The execution order is the key output.**
- **Logical commits matter.** Never mix concerns.
- If GAUNTLET found zero failures, produce minimal plan (dead code + warnings only).
- Keep `codegraph path` queries targeted — same file or community only.

## Self-Improvement

This skill lives at `.claude/skills/titan-sync/SKILL.md`. Edit if clustering misses connections or execution order causes conflicts.
