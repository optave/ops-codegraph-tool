---
name: bench-check
description: Run benchmarks against a saved baseline, detect performance regressions, and update the baseline — guards against silent slowdowns
argument-hint: "[--save-baseline | --compare-only | --threshold 15]  (default: compare + save)"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
---

# /bench-check — Performance Regression Check

Run the project's benchmark suite, compare results against a saved baseline, flag regressions beyond a threshold, and optionally update the baseline. Prevents silent performance degradation between releases.

## Arguments

- `$ARGUMENTS` may contain:
  - `--save-baseline` — run benchmarks and save as the new baseline (no comparison)
  - `--compare-only` — compare against baseline without updating it
  - `--threshold N` — regression threshold percentage (default: 15%)
  - No arguments — compare against baseline, then update it if no regressions

## Phase 0 — Pre-flight

1. Confirm we're in the codegraph repo root
2. Check that benchmark scripts exist:
   - `scripts/benchmark.js` (build speed, query latency)
   - `scripts/incremental-benchmark.js` (incremental build tiers)
   - `scripts/query-benchmark.js` (query depth scaling)
   - `scripts/embedding-benchmark.js` (search recall) — optional, skip if embedding deps missing
3. Parse `$ARGUMENTS`:
   - `SAVE_ONLY=true` if `--save-baseline`
   - `COMPARE_ONLY=true` if `--compare-only`
   - `THRESHOLD=N` from `--threshold N` (default: 15)
4. Check for existing baseline at `generated/bench-check/baseline.json`
   - If missing and not `--save-baseline`: warn that this will be an initial baseline run

## Phase 1 — Run Benchmarks

Run each benchmark script and collect results. Each script outputs JSON to stdout.

### 1a. Build & Query Benchmark

```bash
output=$(timeout 300 node scripts/benchmark.js 2>&1)
exit_code=$?
```

If `exit_code` is 124: record `"timeout"` for this suite and skip to the next suite.
Else if `exit_code` is non-zero: record `"error: $output"` for this suite and skip to the next suite.

Extract:
- `buildTime` (ms) — per engine (native, WASM)
- `queryTime` (ms) — per query type
- `nodeCount`, `edgeCount` — graph size

### 1b. Incremental Benchmark

```bash
output=$(timeout 300 node scripts/incremental-benchmark.js 2>&1)
exit_code=$?
```

If `exit_code` is 124: record `"timeout"` for this suite and skip to the next suite.
Else if `exit_code` is non-zero: record `"error: $output"` for this suite and skip to the next suite.

Extract:
- `noOpRebuild` (ms) — time for no-change rebuild
- `singleFileRebuild` (ms) — time after one file change
- `importResolution` (ms) — resolution throughput

### 1c. Query Depth Benchmark

```bash
output=$(timeout 300 node scripts/query-benchmark.js 2>&1)
exit_code=$?
```

If `exit_code` is 124: record `"timeout"` for this suite and skip to the next suite.
Else if `exit_code` is non-zero: record `"error: $output"` for this suite and skip to the next suite.

Extract:
- `fnDeps` scaling by depth
- `fnImpact` scaling by depth
- `diffImpact` latency

### 1d. Embedding Benchmark (optional)

```bash
output=$(timeout 300 node scripts/embedding-benchmark.js 2>&1)
exit_code=$?
```

If `exit_code` is 124: record `"timeout"` for this suite and skip to the next suite.
Else if `exit_code` is non-zero: record `"error: $output"` for this suite and skip to the next suite.

Extract:
- `embeddingTime` (ms)
- `recall` at Hit@1, Hit@3, Hit@5, Hit@10

> **Timeout:** Each benchmark gets 5 minutes max (`timeout 300`). Exit code 124 indicates timeout — record `"timeout"` for that suite and continue.

> **Errors:** If a benchmark script fails (non-zero exit), record `"error: <message>"` and continue with remaining benchmarks.

## Phase 2 — Normalize Results

Build a flat metrics object from all benchmark results:

```json
{
  "timestamp": "<ISO 8601>",
  "version": "<from package.json>",
  "gitRef": "<current HEAD short SHA>",
  "metrics": {
    "build.native.ms": 1234,
    "build.wasm.ms": 2345,
    "query.fnDeps.depth3.ms": 45,
    "query.fnImpact.depth3.ms": 67,
    "query.diffImpact.ms": 89,
    "incremental.noOp.ms": 12,
    "incremental.singleFile.ms": 34,
    "incremental.importResolution.ms": 56,
    "graph.nodes": 500,
    "graph.edges": 1200,
    "embedding.time.ms": 3000,
    "embedding.recall.hit1": 0.85,
    "embedding.recall.hit5": 0.95
  }
}
```

Adapt the metric keys to match whatever the benchmark scripts actually output — the above are representative. The goal is a flat key→number map for easy comparison.

## Phase 3 — Compare Against Baseline

Skip this phase if `SAVE_ONLY=true` or no baseline exists.

For each metric in the current run:

1. Look up the same metric in the baseline
2. Guard against division-by-zero: if `baseline == 0`, mark the delta as `"N/A — baseline was zero"` and treat the metric as **informational only** (not a regression or improvement)
3. Otherwise compute: `delta_pct = ((current - baseline) / baseline) * 100`
4. Classify:
   - **Regression**: metric increased by more than `THRESHOLD`% (for time metrics) or decreased by more than `THRESHOLD`% (for recall/quality metrics)
   - **Improvement**: metric decreased by more than `THRESHOLD`% (time) or increased (quality)
   - **Stable**: within threshold

> **Direction awareness:** For latency metrics (ms), higher = worse. For recall/quality metrics, higher = better. For count metrics (nodes, edges), changes are informational only — not regressions.

### Regression table

| Metric | Baseline | Current | Delta | Status |
|--------|----------|---------|-------|--------|
| build.native.ms | 1200 | 1500 | +25% | REGRESSION |
| query.fnDeps.depth3.ms | 45 | 43 | -4.4% | stable |

## Phase 4 — Verdict

Based on comparison results:

### No regressions found
- Print: `BENCH-CHECK PASSED — no regressions beyond {THRESHOLD}% threshold`
- If not `COMPARE_ONLY`: update baseline with current results

### Regressions found
- Print: `BENCH-CHECK FAILED — {N} regressions detected`
- List each regression with metric name, baseline value, current value, delta %
- Do NOT update the baseline
- Suggest investigation:
  - `git log --oneline <baseline-ref>..HEAD` to find what changed
  - `codegraph diff-impact <baseline-ref> -T` to find structural changes
  - Re-run individual benchmarks to confirm (not flaky)

### First run (no baseline)
- If `COMPARE_ONLY` is set: print a warning that no baseline exists and **stop here — do not proceed to Phase 5 or Phase 6**. No baseline is saved and no report is written.
- Otherwise: print `BENCH-CHECK — initial baseline saved` and save current results as baseline

### Save-baseline with existing baseline (`--save-baseline`)
- Print: `BENCH-CHECK — baseline overwritten (previous: <old gitRef>, new: <new gitRef>)`
- Save current results as the new baseline (overwrite existing)

## Phase 5 — Save Baseline

**Skip this phase if `COMPARE_ONLY` is set.** Compare-only mode never writes or commits baselines.
**Skip this phase if regressions were detected in Phase 4.** The baseline is only updated on a clean run.

When saving (initial run, `--save-baseline`, or passed comparison):

Write to `generated/bench-check/baseline.json`:
```json
{
  "savedAt": "<ISO 8601>",
  "version": "<package version>",
  "gitRef": "<HEAD short SHA>",
  "threshold": $THRESHOLD,
  "metrics": { ... }
}
```

Also append a one-line summary to `generated/bench-check/history.ndjson`:
```json
{"timestamp":"...","version":"...","gitRef":"...","metrics":{...}}
```

This creates a running log of benchmark results over time.

After writing both files, commit the baseline so it is a shared reference point:
```bash
git add generated/bench-check/baseline.json generated/bench-check/history.ndjson
git diff --cached --quiet -- generated/bench-check/baseline.json generated/bench-check/history.ndjson || git commit generated/bench-check/baseline.json generated/bench-check/history.ndjson -m "chore: update bench-check baseline (<gitRef>)"
```

> `git add` first so that newly created files (first run) are staged; `--cached` then detects them correctly. Without this, `git diff --quiet` ignores untracked files and the baseline is never committed on the first run.

## Phase 6 — Report

**Skip this phase (write no report) if `COMPARE_ONLY` was set and no baseline existed.** That case was already handled in Phase 4 with an early exit — writing a "BASELINE SAVED" report here would be misleading since no baseline was saved.

Write a human-readable report to `generated/bench-check/BENCH_REPORT_<date>.md`.

**If `SAVE_ONLY` is set or no prior baseline existed (first run):** write a shortened report — omit the "Comparison vs Baseline" and "Regressions" sections since no comparison was performed:

```markdown
# Benchmark Report — <date>

**Version:** X.Y.Z | **Git ref:** abc1234 | **Threshold:** $THRESHOLD%

## Verdict: BASELINE SAVED — no comparison performed

## Raw Results

<!-- Full JSON output from each benchmark -->
```

**Otherwise (comparison was performed):** write the full report with comparison and verdict:

```markdown
# Benchmark Report — <date>

**Version:** X.Y.Z | **Git ref:** abc1234 | **Threshold:** $THRESHOLD%

## Verdict: PASSED / FAILED

## Comparison vs Baseline

<!-- Full comparison table with all metrics -->

## Regressions (if any)

<!-- Detail each regression with possible causes -->

## Trend (if history.ndjson has 3+ entries)

<!-- Show trend for key metrics: build time, query time, graph size -->

## Raw Results

<!-- Full JSON output from each benchmark -->
```

## Phase 7 — Cleanup

1. If report was written, print its path
2. If baseline was updated, print confirmation
3. Print one-line summary: `PASSED (0 regressions) | FAILED (N regressions) | BASELINE SAVED`

## Rules

- **Never skip a benchmark** — if it fails, record the failure and continue
- **Timeout is 5 minutes per benchmark** — use appropriate timeout flags
- **Don't update baseline on regression** — the user must investigate first
- **Recall/quality metrics are inverted** — a decrease is a regression
- **Count metrics are informational** — graph growing isn't a regression
- **The baseline file is committed to git** — it's a shared reference point; Phase 5 commits it on clean (non-regressed) runs where COMPARE_ONLY is not set
- **history.ndjson is append-only** — never truncate or rewrite it
- Generated files go in `generated/bench-check/` — create the directory if needed
