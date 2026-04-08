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

> **Context budget:** One forge phase per invocation. Process all targets from one forge phase's commits, then stop. User re-runs for the next phase.

**Arguments** (from `$ARGUMENTS`):
- No args → process the next unground forge phase
- `--phase N` → process a specific forge phase
- `--target <name>` → run single target only (for retrying failures)
- `--dry-run` → analyze and report without making changes
- `--yes` → skip confirmation prompt (typically passed by `/titan-run` orchestrator)

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
   If merge conflicts → stop: "Merge conflict detected. Resolve and re-run `/titan-grind`."

3. **Load artifacts.** Read:
   - `.codegraph/titan/titan-state.json` — current state (required)
   - `.codegraph/titan/sync.json` — execution plan (required)
   - `.codegraph/titan/gate-log.ndjson` — gate verdicts (optional)
   - `.codegraph/titan/grind-targets.ndjson` — persisted grind analysis (optional, exists on resume)

4. **Validate state.** Grind runs after forge. Check:
   - `titan-state.json → execution` block exists
   - `execution.completedPhases` has at least one entry
   - If no `execution` block → stop: "No forge execution found. Run `/titan-forge` first."

5. **Initialize grind state** (if `grind` block doesn't exist in `titan-state.json`). Merge into `titan-state.json`:
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
       "deadSymbolBaseline": null,
       "deadSymbolCurrent": null
     }
   }
   ```

6. **Ensure graph is current.** Rebuild if stale:
   ```bash
   codegraph build
   ```

7. **Capture dead-symbol baseline** (only if `grind.deadSymbolBaseline` is null):
   ```bash
   codegraph roles --role dead -T --json | node -e "const d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{const items=JSON.parse(Buffer.concat(d));console.log(JSON.stringify({total:items.length,byRole:items.reduce((a,i)=>{a[i.role]=(a[i.role]||0)+1;return a},{})}));})"
   ```
   Store the total in `grind.deadSymbolBaseline`. Write `titan-state.json` immediately.

8. **Determine next phase.** Use `--phase N` if provided, otherwise find the lowest forge phase number not in `grind.completedPhases`.

9. **Update state.** Set `grind.currentPhase` to the target phase number. Write `titan-state.json`.

10. **Print plan and ask for confirmation** (unless `--yes`):
    ```
    GRIND — Phase N: <label>
    Forge made N commits for this phase.
    Dead symbol baseline: <N>
    Previously processed: <N> targets (<N> adopted, <N> failed)
    
    Will: identify new dead symbols, find adoption opportunities, wire helpers into consumers.
    Proceed? [y/n]
    ```

---

## Step 1 — Identify forge's new symbols

**Skip if:** `.codegraph/titan/grind-targets.ndjson` already has entries for this phase (resume case). Load existing entries and skip to Step 3.

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

If any of these apply → classify as **false-positive**.

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

**Persist each classification immediately** to `.codegraph/titan/grind-targets.ndjson` (one JSON object per line):
```json
{"target":"<name>","file":"<file>","phase":N,"classification":"adopt|re-export|promote|false-positive|intentionally-private|remove","reason":"<why>","consumers":["file1.ts"],"pattern":"<what to search for>","timestamp":"<ISO 8601>"}
```

This ensures resume works — if interrupted, re-running loads existing entries and skips already-classified targets.

If zero actionable grind targets (only false-positives and intentionally-private) → print "Phase N: no dead helpers to adopt. Forge wired everything correctly (or all dead symbols are false positives)." Mark phase complete, stop.

---

## Step 3 — Execute adoptions (per-target loop)

For each grind target classified as **adopt**, **re-export**, **promote**, or **remove**:

1. **Skip if done.** Check if target is already in `grind.processedTargets`. If so, skip.

2. **Update state.** Set `grind.currentTarget` in `titan-state.json`. Write immediately.

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

5. **Check if still dead.** The target may have been adopted by a previous grind commit in this phase:
   ```bash
   codegraph roles --role dead -T --file <target-file> --json
   ```
   If the target is no longer dead → skip with note: "Target already adopted by a prior grind commit."

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

9. **Verify impact before committing:**
   ```bash
   codegraph diff-impact --staged -T --json
   ```
   Review the blast radius. If transitive callers > 30 for a simple adoption, something is wrong — review the change carefully.

10. **Run /titan-gate:**
    Use the Skill tool to invoke `titan-gate`.
    - If FAIL on **cycle/test/lint/build** → go to rollback (step 13).
    - If FAIL on **other checks** → unstage with `git restore --staged $(git diff --cached --name-only)`, add to `grind.failedTargets` with reason, continue to next target.

11. **Commit on success:**
    ```bash
    git commit -m "grind(<scope>): adopt <helper> across <N> consumers"
    ```
    For removals:
    ```bash
    git commit -m "grind(<scope>): remove unused <helper>"
    ```

12. **Update state on success.** Write `titan-state.json` immediately after each commit:
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

13. **On failure (test or gate rollback):**
    ```bash
    # Discover dirty files at rollback time
    git restore --staged $(git diff --cached --name-only) 2>/dev/null
    git checkout -- $(git diff --name-only) 2>/dev/null
    ```
    - Add to `grind.failedTargets`: `{ "target": "<name>", "reason": "<why>", "phase": N }`
    - Add target to `grind.processedTargets` (so it's not retried on resume)
    - Clear `grind.currentTarget`
    - Write `titan-state.json`
    - **Continue to next target** — don't block the whole phase

14. **Rebuild graph** after changes to keep it current for the next target:
    ```bash
    codegraph build
    ```

For **false-positive** and **intentionally-private** targets: add to `grind.processedTargets` and `grind.falsePositives`, write state, but make no code changes. These inform future improvements to codegraph's dead-code detection.

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

---

## Step 6 — Report

Print:

```
## Grind Phase N Complete: <label>

Dead symbols: <baseline> → <current> (delta: <+/-N>)
Targets: <processed>/<total> processed, <failed> failed
Adoptions: <N> helpers wired into <M> consumers
Removals: <N> unused helpers deleted
False positives: <N> (codegraph resolution bugs)
Intentionally private: <N>

### Adoptions:
- <helper>: adopted by <N> consumers (<classification>)
  Commit: <sha>

### Removals:
- <helper>: removed (no adoption opportunity)
  Commit: <sha>

### Failed targets (if any):
- <target>: <reason>

### False positives (codegraph bugs to investigate):
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

- **Interrupted mid-target:** On re-run, `grind.currentTarget` is set. Check if target has uncommitted changes (`git status`). If dirty → rollback dirty files, then re-process the target. If clean → the commit succeeded but state wasn't updated; check `git log -1` to see if the last commit matches, and update state accordingly.
- **Interrupted mid-classification (Step 2):** On re-run, `grind-targets.ndjson` has partial entries. Load existing entries, skip already-classified targets, continue from the next unclassified candidate.
- **No dead helpers in a phase:** Skip with note. Some forge phases may have wired everything correctly.
- **Helper is used via dynamic import:** Classify as false-positive. Note for codegraph bug tracking.
- **Helper is in Rust, consumers are TypeScript (or vice versa):** Cross-language helpers cannot be adopted across the FFI boundary. Classify as intentionally-private if used within their language, or false-positive if the dead flag is from FFI resolution limits.
- **Gate fails on adoption:** Rollback, record failure, continue. A failed adoption may indicate the helper's semantics don't match the inline pattern exactly.
- **Helper was adopted by a previous target in this phase:** Check `codegraph roles --role dead` before applying — if no longer dead, skip.
- **`--target <name>`:** Run single target only. Useful for retrying entries in `grind.failedTargets`.
- **`--dry-run`:** Walk through all targets, classify them, persist to `grind-targets.ndjson`, print the adoption plan, but make no code changes or commits.

---

## Rules

- **One forge phase per invocation.** Stop after the phase completes. User re-runs for next.
- **Resumable.** State is written after every target. If interrupted, re-running picks up from `grind.currentTarget` and `grind.processedTargets`. Already-committed adoptions are skipped.
- **Always use `--json` and `-T`** for codegraph commands.
- **Use codegraph to understand before editing.** Run `codegraph context`, `codegraph audit --quick`, `codegraph fn-impact`, and `codegraph where` before touching any code. Run `codegraph diff-impact --staged` before committing.
- **Gate before commit.** Every commit must pass `/titan-gate`. No exceptions.
- **Stage only specific files.** Never `git add .` or `git add -A`.
- **Never change control flow.** Adoptions must be semantically identical to the code they replace. If the helper does something slightly different from the inline pattern, skip it.
- **Rollback on failure is gentle** — `git restore --staged` to unstage, `git checkout --` to revert working tree. Never `git reset --hard`.
- **Persist state after every target.** Write `titan-state.json` after each commit, failure, or classification. The `.ndjson` file is append-only — never rewrite it.
- **Dead-symbol delta is advisory, not blocking.** Some increase from type-level symbols is expected. The gate catches real problems.
- **Log false positives.** These are codegraph bugs. The report feeds back into improving dead-code detection.

## Relationship to Other Skills

| Skill | Relationship |
|-------|-------------|
| `/titan-forge` | Grind runs after forge — processes forge's output |
| `/titan-gate` | Called per-commit for validation (same as forge) |
| `/titan-close` | Runs after grind — includes grind metrics in final report |
| `/titan-sync` | Grind reads sync.json to map commits to phases |
| `/titan-recon` | Grind reads titan-state.json produced by recon |

## Self-Improvement

This skill lives at `.claude/skills/titan-grind/SKILL.md`. Edit if adoption strategies need refinement or the dead-symbol delta thresholds need adjustment after dogfooding.
