---
name: titan-grind
description: Adopt extracted helpers — find dead symbols from forge, wire them into consumers, replace duplicated inline patterns, and gate on dead-symbol delta (Titan Paradigm Phase 4.5)
argument-hint: <--dry-run> <--phase N> <--target name> <--yes>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent
---

# Titan GRIND — Adopt Extracted Helpers

You are running the **GRIND** phase of the Titan Paradigm.

Forge shapes the metal. Grind smooths the rough edges. Your goal: find helpers that forge extracted but never wired into consumers, adopt them across the codebase, and gate on a non-positive dead-symbol delta.

> **Why this phase exists:** Forge decomposes god-functions into smaller helpers, but those helpers are only called within their own file. The dead symbol count inflates with every forge phase because the adoption loop is never closed. Grind closes it.

> **Context budget:** One forge phase per invocation. Process all targets from one forge phase's commits, then stop. If context reaches ~80% capacity mid-phase, write all state to disk, print a progress message, and stop — user re-runs for remainder.

**Arguments** (from `$ARGUMENTS`):
- No args → process the next unground forge phase
- `--phase N` → process a specific forge phase
- `--target <name>` → run single target only (for retrying failures)
- `--dry-run` → analyze and classify without making code changes (classifications ARE persisted to `grind-targets.ndjson`)
- `--yes` → skip confirmation prompt (typically passed by `/titan-run` orchestrator)

---

## Step 0 — Pre-flight

1. **Worktree check:**
   ```bash
   git rev-parse --show-toplevel && git worktree list
   ```
   If not in a worktree, stop: "Run `/worktree` first."

2. **Session discovery.** Check all worktrees for titan artifacts:
   ```bash
   git worktree list
   ```
   For each worktree, check:
   ```bash
   ls <worktree-path>/.codegraph/titan/titan-state.json 2>/dev/null
   ```
   - **Found artifacts in a different worktree:** Read its `titan-state.json → currentPhase` and `execution` block. If forge completed there but grind hasn't run, merge its branch: `git merge <branch> --no-edit`
   - **Found artifacts in current worktree:** Proceed normally.
   - **Found nothing:** Stop: "No Titan session found. Run `/titan-forge` first."

3. **Sync with main:**
   ```bash
   git fetch origin main && git merge origin/main --no-edit
   ```
   If merge conflicts → stop: "Merge conflict detected. Resolve and re-run `/titan-grind`."

4. **Validate state file integrity:**
   ```bash
   node -e "try { JSON.parse(require('fs').readFileSync('.codegraph/titan/titan-state.json','utf8')); console.log('OK'); } catch(e) { console.log('CORRUPT: '+e.message); process.exit(1); }"
   ```
   If CORRUPT → check `.codegraph/titan/titan-state.json.bak`:
   - Backup valid → restore: `cp .codegraph/titan/titan-state.json.bak .codegraph/titan/titan-state.json`
   - Backup also corrupt or missing → stop: "State file corrupted with no valid backup. Run `/titan-reset` and start over."

5. **Load artifacts.** Read:
   - `.codegraph/titan/titan-state.json` — current state (required)
   - `.codegraph/titan/sync.json` — execution plan (required)
   - `.codegraph/titan/gate-log.ndjson` — gate verdicts (optional)
   - `.codegraph/titan/grind-targets.ndjson` — persisted grind analysis (optional, exists on resume)
   - `.codegraph/titan/arch-snapshot.json` — pre-forge architectural snapshot (optional — if missing, gate's A1/A3/A4 checks will be skipped; print: "NOTE: No arch-snapshot.json found. Gate architectural comparisons will be skipped.")
   - `.codegraph/titan/issues.ndjson` — cross-phase issue tracker (optional, for appending)

6. **Validate state.** Grind runs after forge. Check:
   - `titan-state.json → execution` block exists
   - `execution.completedPhases` has at least one entry
   - If no `execution` block → stop: "No forge execution found. Run `/titan-forge` first."

7. **Initialize grind state** (if `grind` block doesn't exist in `titan-state.json`). Merge into `titan-state.json`:
   ```json
   {
     "grind": {
       "completedPhases": [],
       "currentPhase": null,
       "currentTarget": null,
       "processedTargets": [],
       "failedTargets": [],
       "adoptions": [],
       "removals": [],
       "falsePositives": [],
       "diffWarnings": [],
       "deadSymbolBaseline": null,
       "deadSymbolCurrent": null
     }
   }
   ```

8. **Update top-level state.** Set `currentPhase` to `"grind"` in `titan-state.json`. Write immediately.

9. **Back up state:**
   ```bash
   cp .codegraph/titan/titan-state.json .codegraph/titan/titan-state.json.bak
   ```

10. **Ensure graph is current.** Rebuild if stale:
    ```bash
    codegraph build
    ```

11. **Take a graph snapshot** before making changes:
    ```bash
    codegraph snapshot save titan-grind-baseline 2>/dev/null || true
    ```

12. **Capture dead-symbol baseline** (only if `grind.deadSymbolBaseline` is null):
    ```bash
    codegraph roles --role dead -T --json | node -e "const d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{const items=JSON.parse(Buffer.concat(d));console.log(JSON.stringify({total:items.length,byRole:items.reduce((a,i)=>{a[i.role]=(a[i.role]||0)+1;return a},{})}));})"
    ```
    Store the total in `grind.deadSymbolBaseline`. Write `titan-state.json` immediately.

13. **Drift detection.** Compare `titan-state.json → mainSHA` against current origin/main:
    ```bash
    git rev-list --count <mainSHA>..origin/main
    ```
    If main has advanced, check if any forge-touched files were modified:
    ```bash
    git diff --name-only <mainSHA>..origin/main
    ```
    Cross-reference against files from forge's `execution.commits`. If >20% of grind candidate files changed on main → **WARN**: "Main has advanced <N> commits since forge. <M> grind candidate files were modified. Some helpers may already be adopted or removed on main. Consider re-running `/titan-recon`." Continue unless >50% affected, then stop.

14. **Determine next phase.** Use `--phase N` if provided, otherwise find the lowest forge phase number not in `grind.completedPhases`.

15. **Update state.** Set `grind.currentPhase` to the target phase number. Write `titan-state.json`.

16. **Record phase timestamp** (only if not already set — may exist from a prior crashed run):
    ```bash
    node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('.codegraph/titan/titan-state.json','utf8'));s.phaseTimestamps=s.phaseTimestamps||{};s.phaseTimestamps['grind']=s.phaseTimestamps['grind']||{};if(!s.phaseTimestamps['grind'].startedAt){s.phaseTimestamps['grind'].startedAt=new Date().toISOString();fs.writeFileSync('.codegraph/titan/titan-state.json',JSON.stringify(s,null,2));}"
    ```

17. **Print plan and ask for confirmation** (unless `--yes`):
    ```
    GRIND — Phase N: <label>
    Forge made N commits for this phase.
    Dead symbol baseline: <N>
    Previously processed: <N> targets (<N> adopted, <N> failed)
    Drift: <fresh|N commits behind>
    
    Will: identify new dead symbols, find adoption opportunities, wire helpers into consumers.
    Proceed? [y/n]
    ```

---

## Step 1 — Identify forge's new symbols

**Skip if:** `.codegraph/titan/grind-targets.ndjson` already has entries for this phase (resume case). Validate NDJSON integrity first:

```bash
node -e "
const fs = require('fs');
const path = '.codegraph/titan/grind-targets.ndjson';
if (!fs.existsSync(path)) { console.log(JSON.stringify({ valid: 0, corrupt: 0, total: 0, missing: true })); process.exit(0); }
const lines = fs.readFileSync(path,'utf8').trim().split('\n');
let valid = 0, corrupt = 0;
for (const line of lines) { try { JSON.parse(line); valid++; } catch { corrupt++; } }
console.log(JSON.stringify({ valid, corrupt, total: lines.length, missing: false }));
"
```

- If `corrupt > 0`: Print "WARNING: <corrupt> corrupt lines in grind-targets.ndjson (likely from a crashed write). These targets will be re-classified."
- If existing valid entries cover this phase → load them and skip to Step 3.

For the target forge phase, get the commits from `titan-state.json → execution.commits` that belong to this phase (cross-reference with `sync.json → executionOrder[phase].targets`).

For each commit, identify changed files:
```bash
git diff-tree --no-commit-id --name-only -r <commit-sha>
```

For each changed file, inventory the symbols:
```bash
codegraph where --file <changed-file> -T --json
```

Collect all symbols defined in files touched by this forge phase. These are the **candidate symbols** — forge created or modified them.

---

## Step 2 — Find and classify dead helpers

Run dead-code detection scoped to the candidate files:

```bash
codegraph roles --role dead -T --file <changed-file> --json
```

For each file touched by forge in this phase, collect symbols flagged as dead. Filter to:
- **Functions** and **constants** only (skip interfaces, parameters, type aliases — these are typically false positives from TypeScript type-level usage)
- **Symbols that are exported** (file-local helpers called within their own file are not dead — they're just private)
- **Symbols NOT in the public API barrel** (`src/index.ts`) unless they have zero external consumers

For each candidate dead symbol, run the full analysis:

### 2a. Understand the helper

```bash
codegraph where <helper-name>
codegraph context <helper-name> -T --json
codegraph audit --quick <helper-name> -T --json
```

Read the helper's source file to understand its signature, parameters, and behavior. This is critical — you cannot classify or adopt a helper you don't understand.

### 2b. Check if actually dead (false-positive detection)

```bash
codegraph fn-impact <helper-name> -T --json
codegraph ast --kind call <helper-name> -T --json
```

Check for:
- **Dynamic imports** (`await import(...)`) that call this symbol — codegraph can't trace these
- **Re-export chains** (`export { X } from './foo.js'`) — codegraph may not count re-exports as references
- **Closure-local usage** — the symbol is assigned to a variable and called within the same function
- **Template literal usage** — the symbol is referenced inside a string template (e.g., HTML renderer)

If any of these apply → classify as **false-positive**. Append to `.codegraph/titan/issues.ndjson`:
```json
{"phase":"grind","timestamp":"<ISO 8601>","severity":"bug","category":"codegraph","description":"False positive dead-code detection: <symbol> in <file> — <reason>","context":"<detection method that failed>"}
```

### 2c. Duplicate-logic scan

Search the codebase for inline code that duplicates what the helper does:

```bash
codegraph query <helper-name> -T --json
```

Read the helper's source to extract its key pattern. Then search for that pattern:

```bash
# Use Grep with patterns derived from the helper's implementation
# Example: if helper is toSymbolRef({ name, kind, file, line }),
# search for the inline pattern it replaces
```

Use `Grep` with patterns derived from the helper's implementation. Look for:
- Identical multi-line patterns (e.g., object literal mappings)
- Equivalent `.map()` callbacks that the helper could replace
- Hand-rolled loops that duplicate the helper's logic
- Similar function signatures doing the same work in a different module

### 2d. Consumer-wiring scan

Check if the helper should be called by existing code that currently does the same work:

```bash
codegraph fn-impact <helper-name> -T --json
codegraph path <helper-name> <potential-consumer> -T --json
```

If the helper wraps a common operation (error construction, AST traversal, data mapping), search for call sites of the underlying operation that could use the wrapper instead:

```bash
codegraph ast --kind call <underlying-function> -T --json
```

### 2e. Re-export check

If the helper is in a module with a barrel file (index.ts, mod.rs), check if it needs to be re-exported:

```bash
codegraph exports <barrel-file> -T --json
```

### 2f. Classify and persist

For each grind target, assign one of:

| Classification | Action |
|---------------|--------|
| **adopt** | Found N sites where this helper replaces duplicated code. Wire it in. |
| **re-export** | Helper is consumed internally but missing from barrel. Add re-export. |
| **promote** | Helper is file-local but useful elsewhere. Export and wire consumers. |
| **false-positive** | Not actually dead (dynamic import, closure, re-export chain). Skip. |
| **intentionally-private** | Helper is file-local and only used within its file. Remove export or leave as-is. |
| **remove** | Helper is genuinely unused and has no adoption opportunity. Delete it. |

**Persist each classification immediately** to `.codegraph/titan/grind-targets.ndjson` (one JSON object per line, append-only):
```json
{"target":"<name>","file":"<file>","phase":N,"classification":"adopt|re-export|promote|false-positive|intentionally-private|remove","reason":"<why>","consumers":["file1.ts"],"pattern":"<what to search for>","timestamp":"<ISO 8601>"}
```

This ensures resume works — if interrupted, re-running loads existing entries and skips already-classified targets.

If zero actionable grind targets (only false-positives and intentionally-private) → print "Phase N: no dead helpers to adopt. Forge wired everything correctly (or all dead symbols are false positives)." Mark phase complete, skip to Step 5.

---

## Step 3 — Execute adoptions (per-target loop)

For each grind target classified as **adopt**, **re-export**, **promote**, or **remove**:

1. **Skip if done.** Check if target is already in `grind.processedTargets`. If so, skip.

2. **Update state.** Set `grind.currentTarget` in `titan-state.json`. Write immediately. Back up:
   ```bash
   cp .codegraph/titan/titan-state.json .codegraph/titan/titan-state.json.bak
   ```

3. **Reload grind-targets.ndjson** entry for this target to get classification, consumers, and pattern.

4. **Understand before touching.** Run codegraph commands to get current state (code may have changed since classification):
   ```bash
   codegraph context <target> -T --json
   codegraph fn-impact <target> -T --json
   ```

   For adopt targets, also understand each consumer site:
   ```bash
   codegraph audit --quick <consumer-file> -T --json
   codegraph where --file <consumer-file> -T --json
   ```

5. **Check if still dead.** The target may have been adopted by a previous grind commit or by changes merged from main:
   ```bash
   codegraph roles --role dead -T --file <target-file> --json
   ```
   If the target is no longer dead → skip with note: "Target already adopted (by prior grind commit or main merge)."

6. **Read source file(s).** Read the helper source and each consumer site. Understand the code before editing.

7. **Apply the change** based on classification:

   - **adopt**: Replace inline duplications with calls to the helper. Add imports at each consumer. Verify semantic equivalence — the replacement must produce identical behavior.
   - **re-export**: Add the symbol to the barrel file's export list.
   - **promote**: Add `export` keyword (or `pub` visibility in Rust), add to barrel if applicable, then wire consumers as in **adopt**.
   - **remove**: Delete the symbol. Clean up orphaned imports. Verify no consumers with `codegraph fn-impact <target> -T --json` first.

8. **Stage changed files:**
   ```bash
   git add <specific changed files>
   ```
   Never `git add .` or `git add -A`.

9. **Diff review (intent verification):**

   Collect the context:
   ```bash
   git diff --cached --stat
   git diff --cached
   ```

   **DR1. Scope — only expected files touched:**
   Compare staged file paths against the consumer list from `grind-targets.ndjson`. Flag any file NOT associated with the current target or its known consumers.
   - File in a completely different domain → **DIFF FAIL**
   - File is a direct dependency of the target (import chain) → **OK** (expected ripple)
   - Test file for the target → **OK**

   **DR2. Intent match — diff aligns with classification:**
   - `adopt` → diff should show new import statements and replaced inline patterns, not new logic
   - `re-export` → diff should only touch the barrel file
   - `promote` → diff should add export + barrel entry + consumer imports
   - `remove` → diff should show only deletions (no new functions added)
   If the diff does something **entirely different** from the classification → **DIFF FAIL**

   **DR3. Deletion audit (for remove targets):**
   If lines removed > 10, verify deleted symbols have no active callers not updated in this diff:
   ```bash
   codegraph fn-impact <deleted-symbol> -T --json 2>/dev/null
   ```
   If deleted symbol has callers not in the staged diff → **DIFF FAIL**: "Deleted <symbol> still has <N> callers not updated."

   **On DIFF FAIL:**
   ```bash
   git restore --staged $(git diff --cached --name-only)
   git checkout -- $(git diff --name-only)
   ```
   Add to `grind.failedTargets` with reason `"diff-review: <detail>"`. Continue to next target.

   **On DIFF WARN:** Log to `grind.diffWarnings`:
   ```json
   { "target": "<name>", "check": "<DR1|DR2|DR3>", "message": "<warning text>", "phase": N }
   ```
   Proceed to tests.

10. **Verify impact:**
    ```bash
    codegraph diff-impact --staged -T --json
    ```
    Review the blast radius. If transitive callers > 30 for a simple adoption, something is wrong — review the change carefully.

11. **Run tests (fast-fail before gate):**
    ```bash
    testCmd=$(node -e "const p=require('./package.json');const s=p.scripts||{};const script=s.test?'test':s['test:ci']?'test:ci':null;if(!script){console.log('NO_TEST_SCRIPT');process.exit(0);}const fs=require('fs');const runner=fs.existsSync('yarn.lock')?'yarn':fs.existsSync('pnpm-lock.yaml')?'pnpm':fs.existsSync('bun.lockb')?'bun':'npm';console.log(runner+(script==='test'?' test':' run '+script));")
    ```
    - If `testCmd == "NO_TEST_SCRIPT"` → skip pre-gate test run.
    - Otherwise run: `$testCmd 2>&1`. If tests fail → go to rollback (step 15).

12. **Run /titan-gate:**
    Use the Skill tool to invoke `titan-gate`.
    - If FAIL on **cycle/test/lint/build** (gate auto-rolls back staged changes) → go to rollback (step 15) to also revert working tree.
    - If FAIL on **other checks** (complexity, semantic, structural/arch) — gate does NOT auto-rollback → unstage AND revert:
      ```bash
      git restore --staged $(git diff --cached --name-only) 2>/dev/null
      git checkout -- $(git diff --name-only) 2>/dev/null
      ```
      Add to `grind.failedTargets` with reason, continue to next target. Do NOT go to step 15.

13. **Commit on success:**
    ```bash
    git commit -m "grind(<scope>): adopt <helper> across <N> consumers"
    ```
    For removals:
    ```bash
    git commit -m "grind(<scope>): remove unused <helper>"
    ```
    For re-exports:
    ```bash
    git commit -m "grind(<scope>): re-export <helper> from barrel"
    ```

14. **Update state on success.** Write `titan-state.json` immediately after each commit:
    - Add target to `grind.processedTargets`
    - Record in `grind.adoptions` (or `grind.removals`):
      ```json
      {
        "target": "<helper-name>",
        "classification": "adopt|re-export|promote|remove",
        "consumers": ["file1.ts", "file2.ts"],
        "commit": "<sha>",
        "phase": N
      }
      ```
    - Clear `grind.currentTarget`
    - Back up state:
      ```bash
      cp .codegraph/titan/titan-state.json .codegraph/titan/titan-state.json.bak
      ```

15. **On failure (test or gate cycle/test/lint/build rollback):**
    ```bash
    # Restore graph snapshot
    codegraph snapshot restore titan-grind-baseline 2>/dev/null || true
    # Revert working tree
    git restore --staged $(git diff --cached --name-only) 2>/dev/null
    git checkout -- $(git diff --name-only) 2>/dev/null
    # Rebuild graph from clean state
    codegraph build
    ```
    - Add to `grind.failedTargets`: `{ "target": "<name>", "reason": "<why>", "phase": N }`
    - Add target to `grind.processedTargets` (so it's not retried on resume)
    - Clear `grind.currentTarget`
    - Write `titan-state.json`
    - Back up state
    - **Continue to next target** — don't block the whole phase

16. **Rebuild graph** after successful changes to keep it current for the next target:
    ```bash
    codegraph build
    ```

17. **Take a fresh snapshot** for the next target's rollback safety:
    ```bash
    codegraph snapshot save titan-grind-baseline 2>/dev/null || true
    ```

For **false-positive** and **intentionally-private** targets: add to `grind.processedTargets` and `grind.falsePositives`, write state and backup, but make no code changes.

---

## Step 4 — Dead-symbol delta gate

After all targets in the phase are processed:

```bash
codegraph build
codegraph roles --role dead -T --json | node -e "const d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{const items=JSON.parse(Buffer.concat(d));console.log(JSON.stringify({total:items.length,byRole:items.reduce((a,i)=>{a[i.role]=(a[i.role]||0)+1;return a},{})}));})"
```

Store in `grind.deadSymbolCurrent`. Write `titan-state.json`.

Compute delta: `current - baseline`.

| Delta | Verdict |
|-------|---------|
| delta < 0 | **PASS** — grind reduced dead symbols |
| delta == 0 | **PASS** — neutral (all new helpers were adopted or removed) |
| delta > 0, delta <= 10 | **WARN** — slight increase, likely false positives from type-level symbols |
| delta > 10 | **FAIL** — forge created helpers that grind couldn't adopt. Review `grind.adoptions` for missed opportunities |

On FAIL: print the new dead symbols that were not addressed and their files. Do NOT block — log the warning and continue.

---

## Step 5 — Phase completion

1. Add phase number to `grind.completedPhases`
2. Update `grind.deadSymbolBaseline` to `grind.deadSymbolCurrent` (rolling baseline for next phase)
3. Clear `grind.currentPhase`
4. Clear `grind.currentTarget`
5. Write updated `titan-state.json`
6. Back up state:
   ```bash
   cp .codegraph/titan/titan-state.json .codegraph/titan/titan-state.json.bak
   ```

When ALL forge phases are ground (all entries in `execution.completedPhases` are in `grind.completedPhases`):
7. Record `phaseTimestamps.grind.completedAt`:
   ```bash
   node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('.codegraph/titan/titan-state.json','utf8'));s.phaseTimestamps=s.phaseTimestamps||{};s.phaseTimestamps['grind']=s.phaseTimestamps['grind']||{};s.phaseTimestamps['grind'].completedAt=new Date().toISOString();fs.writeFileSync('.codegraph/titan/titan-state.json',JSON.stringify(s,null,2));"
   ```
8. Clean up grind snapshot:
   ```bash
   codegraph snapshot delete titan-grind-baseline 2>/dev/null || true
   ```

---

## Step 6 — Report

Print:

```
## Grind Phase N Complete: <label>

Dead symbols: <baseline> → <current> (delta: <+/-N>)
Targets: <processed>/<total> processed, <failed> failed
Adoptions: <N> helpers wired into <M> consumers
Removals: <N> unused helpers deleted
False positives: <N> (codegraph resolution bugs → logged to issues.ndjson)
Intentionally private: <N>

### Adoptions:
- <helper>: adopted by <N> consumers (<classification>)
  Commit: <sha>

### Removals:
- <helper>: removed (no adoption opportunity)
  Commit: <sha>

### Failed targets (if any):
- <target>: <reason>

### Diff review warnings (if any):
- <target>: <check> — <message>

### False positives (codegraph bugs — issues filed):
- <symbol>: <reason> (dynamic import / re-export chain / closure)

### Next: Phase M — <label>
Run /titan-grind to continue.
```

If all phases are complete:

```
## All grind phases complete

Dead symbols: <initial baseline> → <final> (total delta: <+/-N>)
Total adoptions: <N> across <M> consumers
Total removals: <N>
Total false positives: <N>
Total failed: <N>

Run /titan-close to finalize.
```

---

## Edge Cases

- **Interrupted mid-target:** On re-run, `grind.currentTarget` is set. Check if target has uncommitted changes (`git status`). If dirty → restore graph snapshot, rollback dirty files, then re-process the target. If clean → the commit succeeded but state wasn't updated; check `git log -1` to see if the last commit matches, and update state accordingly.
- **Interrupted mid-classification (Step 2):** On re-run, validate `grind-targets.ndjson` integrity. Load valid entries, skip already-classified targets, continue from the next unclassified candidate. Corrupt lines are re-classified.
- **State file corrupt on resume:** G4-style recovery from `.bak` file (Step 0.4).
- **No dead helpers in a phase:** Skip with note. Some forge phases may have wired everything correctly.
- **Helper is used via dynamic import:** Classify as false-positive. Log to `issues.ndjson` as a codegraph bug.
- **Helper is in Rust, consumers are TypeScript (or vice versa):** Cross-language helpers cannot be adopted across the FFI boundary. Classify as intentionally-private if used within their language, or false-positive if the dead flag is from FFI resolution limits.
- **Gate fails on adoption:** Restore snapshot, rollback, record failure, continue. A failed adoption may indicate the helper's semantics don't match the inline pattern exactly.
- **Helper was adopted by a previous target in this phase:** Check `codegraph roles --role dead` before applying — if no longer dead, skip.
- **Helper was adopted on main since forge ran:** Drift detection (Step 0.13) warns about this. Per-target dead check (Step 3.5) catches it.
- **Merge conflict with main:** Stop with conflicting files listed. User resolves and re-runs.
- **`--target <name>`:** Run single target only. Useful for retrying entries in `grind.failedTargets`.
- **`--dry-run`:** Walk through all targets, classify them, persist to `grind-targets.ndjson`, print the adoption plan. No code changes, no commits, no graph mutations. Note: dry-run DOES write to `grind-targets.ndjson` (classifications are useful even without code changes).
- **Context budget exhausted:** If context reaches ~80% capacity mid-phase, write all state to disk (including partially processed targets), print progress, and stop. User re-runs to continue.
- **Sync plan alignment:** Before modifying a file, check if it's scheduled for a later forge phase in `sync.json`. If so, **WARN**: "File <file> is scheduled for forge phase <N> — grind modifications may conflict." Proceed but log the warning.

---

## Rules

- **One forge phase per invocation.** Stop after the phase completes. User re-runs for next.
- **Resumable.** State is written after every target. If interrupted, re-running picks up from `grind.currentTarget` and `grind.processedTargets`. Already-committed adoptions are skipped.
- **Always use `--json` and `-T`** for codegraph commands.
- **Use codegraph to understand before editing.** Run `codegraph context`, `codegraph audit --quick`, `codegraph fn-impact`, `codegraph where`, and `codegraph query` before touching any code. Run `codegraph diff-impact --staged` before committing.
- **Diff review before gate.** Every change goes through DR1-DR3 checks. DIFF FAIL = rollback without running gate.
- **Test before gate.** Run the project's test suite as fast-fail before invoking `/titan-gate`.
- **Gate before commit.** Every commit must pass `/titan-gate`. No exceptions.
- **Stage only specific files.** Never `git add .` or `git add -A`.
- **Never change control flow.** Adoptions must be semantically identical to the code they replace. If the helper does something slightly different from the inline pattern, skip it.
- **Rollback restores graph snapshot** — `codegraph snapshot restore`, then `git restore --staged` + `git checkout --`, then `codegraph build`. Never `git reset --hard`.
- **Persist state after every target.** Write `titan-state.json` after each commit, failure, or classification. Back up after every write. The `.ndjson` files are append-only — never rewrite them.
- **Log false positives to issues.ndjson.** These are codegraph bugs. Close phase compiles them into the report and opens GitHub issues.
- **Dead-symbol delta is advisory, not blocking.** Some increase from type-level symbols is expected. The gate catches real problems.
- **Update top-level currentPhase.** Set to `"grind"` at start. Close phase reads this to know grind ran.

## Relationship to Other Skills

| Skill | Relationship |
|-------|-------------|
| `/titan-forge` | Grind runs after forge — processes forge's output |
| `/titan-gate` | Called per-commit for validation (same as forge) |
| `/titan-close` | Runs after grind — reads `grind` state block, `grind-targets.ndjson`, and grind entries in `issues.ndjson` for the final report |
| `/titan-sync` | Grind reads sync.json to map commits to phases and check alignment |
| `/titan-recon` | Grind reads titan-state.json produced by recon |
| `/titan-run` | Orchestrator that dispatches grind as Step 4.5 between forge and close |
| `/titan-reset` | Cleans grind artifacts (`grind-targets.ndjson`, `titan-grind-baseline` snapshot) |
| `/titan-gauntlet` | Gauntlet recommendations inform what forge extracted, which is what grind processes |

## Self-Improvement

This skill lives at `.claude/skills/titan-grind/SKILL.md`. Edit if adoption strategies need refinement or the dead-symbol delta thresholds need adjustment after dogfooding.
