---
name: titan-gauntlet
description: Audit codebase files against the 4-pillar quality manifesto using RECON work batches, with batch processing and context budget management (Titan Paradigm Phase 2)
argument-hint: <batch-size (default: 5)>
allowed-tools: Bash, Read, Write, Glob, Grep, Edit
---

# Titan GAUNTLET — The Perfectionist Manifesto

You are running the **GAUNTLET** phase of the Titan Paradigm.

Your goal: audit every high-priority target from the RECON phase against 4 pillars of quality, using work batches to stay within context limits. Each batch writes results to disk before starting the next. If context reaches ~80% capacity, stop and tell the user to re-invoke — the state machine ensures no work is lost.

**Batch size:** `$ARGUMENTS` (default: `5`)

> **Context budget:** Process `$ARGUMENTS` targets per batch. Write results to NDJSON after each batch. If context grows large, save state and stop — the user re-invokes to continue.

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
   If there are merge conflicts, stop: "Merge conflict detected. Resolve conflicts and re-run `/titan-gauntlet`."

3. **Load state.** Read `.codegraph/titan/titan-state.json`. If missing:
   - Warn: "No RECON artifacts. Run `/titan-recon` first for best results."
   - Fall back: `codegraph triage -T --limit 50 --json` for a minimal queue.

4. **Load architecture.** Read `.codegraph/titan/GLOBAL_ARCH.md` for domain context.

5. **Resume logic.** If `titan-state.json` has completed batches, skip them. Start from the first `pending` batch.

6. **Validate state.** If `titan-state.json` fails to parse, stop: "State file corrupted. Run `/titan-reset` to start over, or `/titan-recon` to rebuild."

---

## Step 1 — The Four Pillars

Every file must be checked against all four pillars. A file **FAILS** if it has any fail-level violation.

### Pillar I: Structural Purity & Logic

#### Rule 1 — Complexity (multi-metric)
```bash
codegraph complexity --file <f> --health -T --json
```
This returns ALL metrics in one call — use them all:

| Metric | Warn | Fail | Why it matters |
|--------|------|------|---------------|
| `cognitive` | > 15 | > 30 | How hard to understand |
| `cyclomatic` | > 10 | > 20 | How many paths to test |
| `maxNesting` | > 3 | > 5 | Flatten with guards/extraction |
| `halstead.effort` | > 5000 | > 15000 | Information-theoretic complexity |
| `halstead.bugs` | > 0.5 | > 1.0 | Estimated defect count |
| `mi` (Maintainability Index) | < 50 | < 20 | Composite health score |
| `loc.sloc` | > 50 | > 100 | Function too long — split it |

#### Rule 2 — Async hygiene (every Promise caught)
```bash
codegraph ast --kind await --file <f> -T --json
codegraph ast --kind call --file <f> -T --json
```
Cross-reference: `.then()` calls without `.catch()` on the same chain; async functions without `try/catch` wrapping await calls. Also grep:
```bash
grep -n "\.then(" <f>
grep -n "async " <f>
```
**Fail:** uncaught promise chains or async functions without error handling.

#### Rule 3 — Dependency direction (no upward imports)
```bash
codegraph check --boundaries -T --json
codegraph deps <f> --json
```
Cross-reference with GLOBAL_ARCH.md layer rules. **Fail:** import from a higher layer.

#### Rule 4 — Dead code (no unused exports)
```bash
codegraph roles --role dead --file <f> -T --json
codegraph exports <f> -T --json
```
**Fail:** dead exports or unreferenced symbols.

#### Rule 5 — Resource hygiene
```bash
codegraph ast --kind call --file <f> -T --json
```
Find `addEventListener`, `setInterval`, `setTimeout`, `createReadStream`, `.on(` — verify matching cleanup. **Fail:** resource acquired without cleanup.

#### Rule 6 — Immutability
```bash
codegraph dataflow <f> -T --json
```
Also grep for mutation patterns:
```bash
grep -n "\.push(\|\.splice(\|\.sort(\|\.reverse(\|delete " <f>
```
**Fail:** direct mutation of function arguments or external state.

### Pillar II: Data & Type Sovereignty

#### Rule 7 — Magic values
```bash
codegraph ast --kind string --file <f> -T --json
```
Also grep for numeric literals in logic branches:
```bash
grep -nE "[^a-zA-Z_][0-9]{2,}[^a-zA-Z_]" <f>
```
Filter out imports, log format strings, test assertions. **Warn:** present. **Fail:** in if/switch conditions.

#### Rule 8 — Boundary validation
```bash
codegraph roles --role entry --file <f> -T --json
codegraph where --file <f> -T --json
```
For entry-point functions, verify schema validation before processing. **Fail:** missing validation at system boundaries.

#### Rule 9 — Secret hygiene
```bash
grep -niE "api.?key|secret|password|token|credential" <f>
```
Verify values come from config/env, not literals. **Fail:** hardcoded secret values.

#### Rule 10 — Error integrity (no empty catches)
```bash
grep -nA2 "catch" <f>
```
**Fail:** empty catch block or catch with only `// ignore` or `// TODO`.

### Pillar III: Ecosystem Synergy

#### Rule 11 — DRY (no duplicated logic)
```bash
codegraph search "<function purpose>" -T --json
codegraph co-change <f> -T --json
```
Find semantically similar functions. If `codegraph search` fails (no embeddings), use grep for function signature patterns. **Warn:** similar patterns. **Fail:** near-verbatim copy.

> Note: requires embeddings from `/titan-recon`. If `titan-state.json → embeddingsAvailable` is false, skip semantic search and note it.

#### Rule 12 — Naming symmetry
```bash
codegraph where --file <f> -T --json
```
Scan function names in the domain. Flag mixed `get`/`fetch`/`retrieve` or `create`/`make`/`build` for the same concept. **Warn:** inconsistent. **Advisory** — not a fail condition.

#### Rule 13 — Config over code
```bash
codegraph deps <f> --json
```
Also grep:
```bash
grep -n "process.env\|NODE_ENV\|production\|development" <f>
```
Verify env-specific behavior driven by config, not inline branches. **Warn:** inline env branch.

### Pillar IV: The Quality Vigil

#### Rule 14 — Naming quality
```bash
codegraph where --file <f> -T --json
```
Flag vague names: `data`, `obj`, `temp`, `res`, `val`, `item`, `result`, single-letter vars (except `i/j/k`). **Warn:** present. **Advisory.**

#### Rule 15 — Structured logging
```bash
codegraph ast --kind call --file <f> -T --json
```
Also grep:
```bash
grep -n "console\.\(log\|warn\|error\|info\)" <f>
```
**Warn:** console.log in source files. **Fail:** in production code paths (non-debug, non-test).

#### Rule 16 — Testability
```bash
codegraph fn-impact <fn> -T --json
codegraph query <fn> -T --json
```
High fan-out correlates with many mocks needed. Also read corresponding test file and count mock/stub/spy calls. **Warn:** > 10 mocks. **Fail:** > 15 mocks.

#### Rule 17 — Critical path coverage
```bash
codegraph roles --role core --file <f> -T --json
```
If file contains core symbols (high fan-in), note whether test files exist for it. **Warn:** core symbol with no test file. **Advisory.**

### Audit trail (per file)

For every file, the NDJSON record MUST include:
- **Verdict** and **pillar verdicts** (pass/warn/fail per pillar)
- **All metrics** from `codegraph complexity --health` (cognitive, cyclomatic, nesting, MI, halstead.bugs, halstead.effort, loc.sloc)
- **Violation list** with rule number, detail, and level
- **Recommendation** for FAIL/DECOMPOSE targets

Codegraph provides all the data needed for a verifiable audit — no need to manually traverse files for line counts or nesting proof.

---

## Step 2 — Batch audit loop

For each pending batch (from `titan-state.json`):

### 2a. Save pre-batch snapshot
```bash
codegraph snapshot save titan-batch-<N>
```
Delete the previous batch snapshot if it exists:
```bash
codegraph snapshot delete titan-batch-<N-1>
```

### 2b. Collect all metrics in one call
```bash
codegraph batch complexity <target1> <target2> ... -T --json
```
This returns complexity + health metrics for all targets in one call. Parse the results.

For deeper context on high-risk targets:
```bash
codegraph batch context <target1> <target2> ... -T --json
```

### 2c. Run Pillar I checks
For each file in the batch:
- Parse complexity metrics from batch output (Rule 1 — all 7 metric thresholds)
- Run AST queries for async hygiene (Rule 2), resource cleanup (Rule 5)
- Check boundary violations (Rule 3): `codegraph check --boundaries -T --json`
- Check dead code (Rule 4): `codegraph roles --role dead --file <f> -T --json`
- Check immutability (Rule 6): `codegraph dataflow` + grep

### 2d. Run Pillar II checks
For each file:
- Magic values (Rule 7): `codegraph ast --kind string` + grep
- Boundary validation (Rule 8): check entry points
- Secret hygiene (Rule 9): grep
- Empty catches (Rule 10): grep

### 2e. Run Pillar III checks
- DRY (Rule 11): `codegraph search` (if embeddings available) + `co-change`
- Naming symmetry (Rule 12): `codegraph where --file`
- Config over code (Rule 13): `codegraph deps` + grep

### 2f. Run Pillar IV checks
- Naming quality (Rule 14): `codegraph where --file`
- Structured logging (Rule 15): `codegraph ast --kind call` + grep
- Testability (Rule 16): `codegraph fn-impact` + test file mock count
- Critical path coverage (Rule 17): `codegraph roles --role core`

### 2g. Score each target

| Verdict | Condition |
|---------|-----------|
| **PASS** | No fail-level violations |
| **WARN** | Warn-level violations only |
| **FAIL** | One or more fail-level violations |
| **DECOMPOSE** | Complexity fail + `halstead.bugs` > 1.0 + high fan-out (needs splitting) |

For FAIL/DECOMPOSE targets, capture blast radius:
```bash
codegraph fn-impact <target> -T --json
```

### 2h. Write batch results

Append to `.codegraph/titan/gauntlet.ndjson` (one line per target):

```json
{"target": "<name>", "file": "<path>", "verdict": "FAIL", "pillarVerdicts": {"I": "fail", "II": "warn", "III": "pass", "IV": "pass"}, "metrics": {"cognitive": 28, "cyclomatic": 15, "maxNesting": 4, "mi": 32, "halsteadEffort": 12000, "halsteadBugs": 1.2, "sloc": 85}, "violations": [{"rule": 1, "pillar": "I", "metric": "cognitive", "detail": "28 > 30 threshold", "level": "fail"}], "blastRadius": {"direct": 5, "transitive": 18}, "recommendation": "Split: halstead.bugs 1.2 suggests ~1 defect. Separate validation from I/O."}
```

### 2i. Update state machine

Update `titan-state.json`:
- Set batch status to `"completed"`
- Increment `progress.audited`, `.passed`, `.warned`, `.failed`
- Add entries to `fileAudits` map
- Update `snapshots.lastBatch`
- Update `lastUpdated`

### 2j. Progress check

Print: `Batch N/M: X pass, Y warn, Z fail`

**Context budget:** If context is growing large:
1. Write all state to disk
2. Print: `Context budget reached after Batch N. Run /titan-gauntlet to continue.`
3. Stop.

---

## Step 3 — Clean up batch snapshots

After all batches complete, delete the last batch snapshot:
```bash
codegraph snapshot delete titan-batch-<N>
```
Keep `titan-baseline` — GATE may need it.

If stopping early for context, keep the last batch snapshot for safety.

---

## Step 4 — Aggregate and report

Compute from `gauntlet.ndjson`:
- Pass / Warn / Fail / Decompose counts
- Top 10 worst offenders (by violation count or `halstead.bugs`)
- Most common violations by pillar
- Files with the most failing functions

Write `.codegraph/titan/gauntlet-summary.json`:
```json
{
  "phase": "gauntlet",
  "timestamp": "<ISO 8601>",
  "complete": true,
  "summary": {"totalAudited": 0, "pass": 0, "warn": 0, "fail": 0, "decompose": 0},
  "worstOffenders": [],
  "commonViolations": {"I": [], "II": [], "III": [], "IV": []}
}
```

Set `"complete": false` if stopping early.

Print summary to user:
- Pass/Warn/Fail/Decompose counts
- Top 5 worst (with their `halstead.bugs` and `mi` scores)
- Most common violation per pillar
- Next step: `/titan-gauntlet` to continue (if incomplete) or `/titan-sync`

---

## Rules

- **Batch processing is mandatory.** Never audit more than `$ARGUMENTS` targets at once.
- **Write NDJSON incrementally.** Partial results survive crashes.
- **Always use `--json` and `-T`** on codegraph commands.
- **Use `codegraph batch <command> <targets>`** for multi-target queries — not separate calls.
- **Leverage `--health` and `--above-threshold`** — they give you all metrics in one call.
- **Context budget:** Stop at ~80%, save state, tell user to re-invoke.
- **Lint runs once in GATE**, not per-batch here. Don't run `npm run lint`.
- Advisory rules (12, 14, 17) produce warnings, never failures.
- Dead symbols from RECON should be flagged for removal, not skipped.

## Self-Improvement

This skill lives at `.claude/skills/titan-gauntlet/SKILL.md`. Adjust thresholds or rules after dogfooding.
