# Titan Audit Report

**Version:** 3.15.0
**Date:** 2026-07-02 05:42 UTC → 2026-07-04 08:17 UTC
**Branch:** worktree-titan-run
**Target:** . (codegraph self-audit)

---

## Executive Summary

The Titan pipeline audited 46 targets across 18 domains of the codegraph codebase (v3.15.0), executed 30/30 planned FORGE phases (29 commits — one phase was correctly aborted after proving its target was a false cycle caused by a codegraph resolver bug, not a real architecture problem), then ran 30/30 GRIND phases (6 adoption commits) and a clean PARITY pass. Functions above complexity threshold dropped from 487 to 442 (-45), with five hotspot functions decomposed from cognitive complexity in the 15–94 range down to single digits/teens. Quality score held steady at 69. Dead-symbol count rose from 8,205 to 8,702 (+497) — GRIND traced this almost entirely to known codegraph role-classifier false positives on newly-extracted helpers (not real waste), filing 5 new root-cause issues (#1769, #1771, #1773, #1776, plus follow-ons) in the process. The FORGE phase survived a genuine mid-run interruption (a ~22-hour session/battery crash after phase 28); the resuming session correctly caught and discarded a flawed staged fix before continuing. 39 commits were split into 10 focused, dependency-ordered PRs, and 6 new codegraph bugs were filed as GitHub issues (17 others were already filed during earlier phases).

---

## Pipeline Timeline

| Phase | Duration | Notes |
|-------|----------|-------|
| RECON | 1h07m | Mapped 886 files, 18168 symbols, 18 domains |
| GAUNTLET | 2h03m | 46 targets audited across batches |
| SYNC | 12m | 30-phase execution plan, 1 driftWarning flagged (communities.ts cycle) |
| FORGE | 36h49m wall-clock (~14h48m active) | 30/30 phases, 29 commits (phase 8 correctly produced no commit — see below); first commit 2026-07-02 09:37 UTC, last 2026-07-03 21:50 UTC |
| GRIND | 9h46m | 30/30 phases, 6 adoption commits, 10 documented false positives |
| PARITY | 15m | Clean — 1 pre-existing divergence filed as #1778; 1 unrelated Cargo.lock version-sync commit made directly by the orchestrator |
| GATE | across forge/grind | 39 runs inline with forge/grind commits |
| CLOSE | 24m | Report generation, PR splitting (10 PRs), issue compilation |
| **Total** | **50h34m** (~50h17m wall-clock from init to close) | |

### Mid-run interruption (FORGE phase 28→29)

A battery/session crash occurred mid-FORGE, after phase 28 committed and while phase 29's edits were in progress. Three files were left staged but uncommitted (`loader-hooks.mjs`, `native-tracer.sh`, `lua-tracer.lua`) — the commit-timestamp gap between phase 28 (`387dabe8`, 2026-07-02 23:25:42 UTC) and the eventual phase 29 commit (`8386f711`, 2026-07-03 21:26:35 UTC) spans **~22 hours**.

A fresh orchestrator session resumed the pipeline from that exact point. Rather than blindly committing the crashed session's pre-staged work, it diff-reviewed all three staged files first and found that `native-tracer.sh`'s staged fix had actually **increased** the script's complexity instead of reducing it. That flawed fix was rolled back and redone correctly before the phase 29 commit was made, and the pipeline continued normally through phase 30, GRIND, and PARITY. No partial or broken state from the interruption reached the final branch.

---

## Metrics: Before & After

| Metric | Baseline | Final | Delta | Trend |
|--------|----------|-------|-------|-------|
| Quality Score | 69 | 69 | 0 | — |
| Total Files | 886 | 895 | +9 | new helper/test files from decomposition |
| Total Nodes (all kinds) | 18168 | 18865 | +697 | new functions from decomposition |
| Total Edges | 37877 | 39411 | +1534 | new internal call edges |
| Functions Above Threshold (-T) | 487 | 442 | **-45** | improved |
| Dead Symbols (-T) | 8205 | 8702 | +497 | see note below |
| Core Symbols (-T) | 2218 | 2319 | +101 | more helpers wired into real call paths |
| Cycle Count (file) | 0 | 0 | 0 | — |
| Cycle Count (function) | 7 | 8 | +1 | see note below |
| Avg Maintainability Index (-T) | not captured by RECON (worst-N only) | 64.3 | n/a | see Top Movers for real before/after |
| Avg Halstead Bugs | not exposed by codegraph tooling | n/a | n/a | see Top Movers for real before/after |

**Note on dead-symbol increase (+497):** GRIND explicitly investigated this. The vast majority of the increase is attributable to known codegraph role-classifier false positives on symbols newly introduced by FORGE's decompositions — parameters and interface-member signatures misclassified as dead (pre-existing bug #1723), plus several newly-diagnosed variants filed this run: destructured-binding misclassification (#1773), dispatch-table fanOut heuristic gaps (#1771), reassigned-global-identifier blindness (#1776), and missing call-edge attribution for `CodeGraph` class methods (#1769). Of 24 GRIND-triaged candidates, only 6 were genuinely adoptable dead code (now wired in) and 3 were promoted/deduped further; the remaining 15 were confirmed tool-bug false positives, not real waste. This is a codegraph classifier gap, not a codebase regression — filed as issues, not documented away as "expected."

**Note on function-level cycle increase (+1):** The new cycle (`visitClassScopeForReturnType` ↔ `visitReturnTypeNode` in `src/domain/graph/resolver/ts-resolver.ts`) is a mutual-recursion AST-walker pair introduced by FORGE's resolver decomposition (quality-fix batch, PR #5) — the same benign shape as 3 pre-existing accepted cycles (`processStatement`↔`processStatements`, `processAlternative`↔`processIf`, and the 7-function `complexity.ts` walker cycle), all intra-file recursive-descent patterns, not accidental dependency loops. The pre-existing `communities.ts`↔`presentation/communities.ts` cycle remains present by design — it was investigated during FORGE phase 8 and confirmed to be a **fabricated** cycle caused by a codegraph resolver bug (dynamic-call edges fabricated on identifier-name collision), root-caused and filed as issue #1741. Fixing the "cycle" itself would have addressed a non-existent architecture problem, so no code change was made.

### Architecture comparison (cohesion, depth-2 directories)

Comparing `arch-snapshot.json` (pre-forge) against current `codegraph structure --depth 2 --json`: of 30 tracked directories, **4 improved**, **24 unchanged**, and **2 showed negligible (<0.005) degradation** attributable to new file counts rather than structural decay:

| Directory | Before | After | Change |
|-----------|--------|-------|--------|
| src/features | 0.041 | 0.047 | improved |
| src/presentation | 0.150 | 0.152 | improved |
| src (top-level) | 0.723 | 0.725 | improved |
| src/extractors | 0.234 | 0.234 | unchanged |
| src/ast-analysis | 0.426 | 0.426 | unchanged |
| tests | 0.149 | 0.148 | negligible degradation (+2 test files) |
| src/cli | 0.283 | 0.279 | negligible degradation |

No directory showed meaningful cohesion loss.

### Complexity Improvement: Top Movers

Real before/after complexity for the functions this run's decompositions targeted (all values from `codegraph complexity --json`, cross-referenced against GAUNTLET's captured baseline):

| Function | File | Cognitive | Cyclomatic | MI | Halstead Bugs | SLOC |
|----------|------|-----------|------------|-----|----------------|------|
| resolveFallbackTargets | build-edges.ts | 67 → 13 | 44 → 10 | 43.6 → 49.7 | 1.30 → 0.36 | 121 → 68 |
| runContextCollectorWalk | extractors/javascript.ts | 94 → 10 | 52 → 7 | 36.3 → 51.4 | 1.55 → 0.35 | 123 → 47 |
| branchCompareData | features/branch-compare.ts | 15 → 3 | 15 → 4 | 27.7 → 48.1 | 1.585 → 0.22 | 110 → 28 |
| complexityData | features/complexity-query.ts | 13 → 5 | 14 → 6 | 34.2 → 50.7 | 0.73 → 0.22 | 72 → 21 |
| runPerfBenchmarks | scripts/token-benchmark.ts | 25 → 15 | 17 → 13 | 38.0 → 41.1 | 1.552 → 1.256 | 113 → 99 |
| iterComplexity | features/complexity-query.ts | *removed as dead code (phase 2)* | — | — | — | — |

### Remaining Hot Spots

Carried forward for a future Titan run — either untouched this pass, or newly surfaced as the file's worst function once the prior worst was decomposed:

| Function | File | Cognitive | Cyclomatic | MI | Halstead Bugs |
|----------|------|-----------|------------|-----|----------------|
| buildDataflowVerticesAndEdges | src/features/dataflow.ts | 48 | 30 | 35.6 | 1.69 |
| buildDataflowEdges | src/features/dataflow.ts | 54 | 19 | 43.6 | 1.46 |
| collectObjectRestParams | src/extractors/javascript.ts | 70 | 39 | 44.3 | 0.82 |
| buildChaPostPass | src/domain/graph/builder/stages/build-edges.ts | 61 | 24 | 49.1 | 0.73 |
| runSession | scripts/token-benchmark.ts | 27 | 25 | 43.9 | 0.85 |
| makePartition | src/graph/algorithms/leiden/partition.ts | 13 | 10 | 32.5 | 1.02 |

`dataflow.ts`'s two functions were not in scope for any FORGE/GRIND phase this run and remain the top complexity hotspot in the repo — a strong candidate for the next Titan RECON.

---

## Audit Results Summary

**Targets audited:** 46
**Pass:** 2 | **Warn:** 2 | **Fail:** 38 | **Decompose:** 4

### By Pillar

| Pillar | Pass | Warn | Fail |
|--------|------|------|------|
| I — Structural Purity & Logic | 4 | 3 | 39 |
| II — Data & Type Sovereignty | 24 | 14 | 8 |
| III — Ecosystem Synergy | 7 | 23 | 16 |
| IV — Quality Vigil | 30 | 15 | 1 |

### Most Common Violations

| Rule | Description | Count |
|------|--------------|-------|
| 1 | Complexity (multi-metric) | 50 |
| 11 | DRY (no duplicated logic) | 38 |
| 4 | Dead code (no unused exports) | 29 |
| 6 | Immutability | 23 |
| 10 | Error integrity (no empty catches) | 12 |

---

## Grind Results

**Targets processed:** 24 | **Adopted/Promoted:** 9 | **Failed:** 0 | **False positives:** 10

### Adoption Summary

| Target | Consumers wired in | Commit |
|--------|--------------------|--------|
| fget, iget | leiden/cpm.ts, leiden/modularity.ts | 3060a946 |
| busyTimeoutMs, capacityGrowthFactor | db/connection.ts, builder pipeline, watcher, communities, leiden (5 files) | d4e7fb8a |
| resolveMethodDefinitionName | extractors/javascript.ts (3 duplicate sites) | bef1bcee |
| unwrapTypeEntry, resolveSameClassQualifiedMethod (promoted) | build-edges.ts, incremental.ts | 2c35dcb6 |
| markExportedSymbols | builder/stages/insert-nodes.ts, native-orchestrator.ts | 0f44f8f2 |
| timeMedian/median/round1 (promoted to shared lib) | 4 benchmark scripts | 91e9c15b |

A blocking codegraph tool bug was discovered and fixed mid-GRIND: `codegraph check --staged`'s signature-change predicate false-positived on the `fget`/`iget` adoption (unexported, zero-caller helpers flagged as breaking API signatures due to imprecise diff-hunk-context handling). Root-caused and fixed in commit `d5f31d82` (PR #8), filed as issue #1760.

### False Positives Logged

| Target | File(s) | Reason |
|--------|---------|--------|
| buildChaContext helpers | builder/cha.ts | New helpers already wired same-commit; flagged fields are ChaContext interface properties mis-tagged kind=method (#1723) |
| prepareSearch adoption | search/prepare.ts | buildFileConditionSQL already adopted everywhere applicable; flagged fields are interface property signatures (#1723) |
| leiden decomposition remainder | adapter.ts, partition.ts, model.ts | All 17 helpers already wired same-commit; 2 new tool bugs discovered (#1769, #1770) |
| Features remainder (branch-compare/cochange/complexity-query) | 3 files | All 50 new helpers already wired same-commit |
| PARAM_NODE_HANDLERS dispatch entries | ast-analysis/visitor-utils.ts | fanOut===0 heuristic gap in role classifier — filed #1771 |
| presentation/audit.ts helpers | audit.ts, features/audit.ts, types.ts | Already wired; overlap with pre-existing #1756/duplication filed as #1772 |
| Extractors remainder (7 files) | r/dart/groovy/csharp/elixir/scala/julia | Zero dead function/const candidates |
| `flags` destructured binding | scripts/token-benchmark.ts | Extractor misclassifies destructuring as kind=function — filed #1773 |
| `traced_require` | lua-tracer.lua | Reassigned global builtin, invoked indirectly — filed #1776 |
| Warn-improvement rename pass | 4 files | Pure rename/visibility pass, zero new symbols |

---

## Changes Made

### Commits: 39

39 commits total: 29 FORGE commits (phase 8 correctly produced none), 6 GRIND adoption commits, 1 GRIND-discovered tool-bug fix (`d5f31d82`), 1 PARITY-phase Cargo.lock version-sync commit made directly by the orchestrator, and 2 dead-code-removal commits (phases 1–2). All 39 commits were split into 10 focused PRs below.

### PR Split Plan

| PR # | Title | Concern | Domain | Commits | Depends On | URL |
|------|-------|---------|--------|---------|-------------|-----|
| 1 | chore: remove dead code identified by Titan audit | dead_code | cross-cutting | 2 | — | https://github.com/optave/ops-codegraph-tool/pull/1785 |
| 2 | refactor: extract shared abstractions (leiden, config, builder, features) | abstraction | cross-cutting | 5 | PR #1 | https://github.com/optave/ops-codegraph-tool/pull/1786 |
| 3 | refactor: decompose extractors, build-edges, native-orchestrator, and remote.ts | decomposition | extractors, builder, search, presentation | 5 | PR #2 | https://github.com/optave/ops-codegraph-tool/pull/1787 |
| 4 | fix: address quality issues in builder pipeline, config, and db connection handling | quality_fix | builder, config, db | 6 | PR #3 | https://github.com/optave/ops-codegraph-tool/pull/1788 |
| 5 | fix: address quality issues in resolver, search, graph model, and features | quality_fix | resolver, search, graph, features | 6 | PR #4 | https://github.com/optave/ops-codegraph-tool/pull/1789 |
| 6 | fix: address quality issues in ast-analysis, presentation, extractors, and cli | quality_fix | ast-analysis, presentation, extractors, cli | 5 | PR #5 | https://github.com/optave/ops-codegraph-tool/pull/1790 |
| 7 | refactor: address warnings in benchmark tracer tooling and ast-analysis naming | warning | tests/tracer, ast-analysis | 2 | PR #6 | https://github.com/optave/ops-codegraph-tool/pull/1791 |
| 8 | fix(check): scope signature-change detection to exported symbols | quality_fix (tool bug) | cli/check | 1 | — | https://github.com/optave/ops-codegraph-tool/pull/1792 |
| 9 | refactor: adopt dead helpers identified by Titan grind | adoption | cross-cutting | 6 | PR #7 | https://github.com/optave/ops-codegraph-tool/pull/1793 |
| 10 | chore: sync Cargo.lock codegraph-core version to 3.15.0 | chore | build metadata | 1 | — | https://github.com/optave/ops-codegraph-tool/pull/1794 |
| 11 | docs: add Titan audit report for v3.15.0 run | docs | generated/titan | 1 (this report) | — | https://github.com/optave/ops-codegraph-tool/pull/1795 |

**Merge order:** PR #1 → #2 → #3 → #4 → #5 → #6 → #7 → #9 (strict chain — each is stacked directly on the previous, since later FORGE phases build on symbols the earlier phases extracted). PR #8, PR #10, and PR #11 are fully independent (touch no files shared with any other commit) and can merge at any time.

PR #11 is not part of the audited 39-commit set — it carries only this report file so the Titan deliverable is committed to the repo per convention.

**Why stacked branches instead of independent cherry-picks:** the 39 commits form a dense same-file dependency chain (e.g. `src/infrastructure/config.ts` is edited sequentially by 4 different commits across the run; `src/domain/graph/builder/helpers.ts` by 3). Cherry-picking non-contiguous commits onto independent `main`-based branches would either fail to apply or apply-but-not-compile for any PR whose commits reference a helper/constant extracted earlier in the sequence. Each PR branch here is a contiguous slice of the original (already-gated, already-tested) commit history, stacked on the previous PR's branch tip — this guarantees every PR builds correctly using only its own PR plus its declared dependencies, at the cost of PRs #2–#7 and #9 not being independently buildable against a bare `main` until their base PRs merge. GitHub tracks this correctly via the base-branch chain and will auto-retarget each PR to `main` as its base merges.

---

## Gate Validation History

**Total runs:** 39
**Pass:** 24 | **Warn:** 11 | **Fail:** 4
**Rollbacks:** 1

### Failure Patterns

All 4 FAIL verdicts were the same root cause: blast-radius threshold (30 transitive callers) tripped by touching a structural hub function (`resolveSecrets`, 87 callers; `loadConfig`, 135 callers) — both are universal config-loading entry points reached by nearly every CLI command, the MCP server, the watcher, and the build pipeline. This is a function's structural position in the call graph, not risk introduced by the diff itself.

- **Entry 7** (phase 7, DEFAULTS extension): FAIL, **rolled back**, then re-attempted.
- **Entry 8** (phase 7 retry): FAIL again on the same blast-radius check, but overridden with documented evidence (purely additive change, zero new/changed/removed call edges, full test suite green before and after, complexity within thresholds) and committed.
- **Entries 14–15** (phase 14, config mutation-bug fix): FAIL on the same `loadConfig` blast-radius signal; entry 15 documents an extensive independent evidence trail (byte-identical call graph before/after, zero new imports, full 200/200-file test suite pass) before the override was accepted.

`checks.tests` was `pass` in all 39 gate runs — no commit in this run ever broke the test suite.

---

## Issues Discovered

**Total logged across pipeline:** 42 (recon: 3, gauntlet: 29, sync: 3, grind: 7)

### Codegraph Bugs

23 GitHub issues total are attributable to this run's findings: **17 already filed during RECON/GAUNTLET/GRIND** (#1720, #1721, #1723, #1724, #1725, #1726, #1727, #1728, #1729, #1730, #1731, #1741, #1760, #1761, #1769, #1771, #1773, #1776 — several are cross-referenced by multiple issue-tracker entries), and **6 newly filed at CLOSE** after a duplicate check against the open issue list:

| Issue | Title |
|-------|-------|
| [#1779](https://github.com/optave/ops-codegraph-tool/issues/1779) | `codegraph exports`: dynamic-dispatch via registry object literal (`LANGUAGE_REGISTRY`) not credited as consumer |
| [#1780](https://github.com/optave/ops-codegraph-tool/issues/1780) | `codegraph roles --role entry` misclassifies non-exported interfaces/constants; `dead-unresolved` bucket also mislabels used interface members |
| [#1781](https://github.com/optave/ops-codegraph-tool/issues/1781) | `codegraph exports` does not credit consumers reached via dynamic `import()` + destructuring |
| [#1782](https://github.com/optave/ops-codegraph-tool/issues/1782) | `codegraph complexity --file` returns empty `functions[]` for Lua files |
| [#1783](https://github.com/optave/ops-codegraph-tool/issues/1783) | `codegraph exports`: false-positive cross-language consumer attribution via name-based fallback matching |
| [#1784](https://github.com/optave/ops-codegraph-tool/issues/1784) | `codegraph exports` does not credit `instanceof ClassName` checks as consumers |

Several other findings in the tracker (entries 5, 8, 13, 14, 18, 21, 24, 29) were confirmed duplicates or precursors of already-filed issues and were folded into the existing issue rather than re-filed (noted inline in `issues.ndjson`).

### Tooling Issues (2)

- `codegraph embed -m minilm` fails with `ENGINE_UNAVAILABLE` when codegraph is installed globally via npm on a Homebrew-managed prefix — regression of previously-fixed #1175, already filed as #1720.
- Embeddings (`embeddingsAvailable: true` in titan-state) were not present in this worktree's `.codegraph/graph.db` — generated in a different worktree/session during a prior RECON. This is a Titan-pipeline worktree-isolation gap (each worktree has its own DB), not a codegraph product defect, so no GitHub issue was filed for it; noted here for the next RECON to account for.

### Process Suggestions (4)

- The RECON skill's Step 3 instructs extracting `avgFanIn`/`avgFanOut` from `codegraph stats --json`, but those fields are not exposed by the CLI in v3.15.0 (worked around by using `hotFiles` fan-in/out instead).
- A batch-9/10 subagent filed GitHub issue #1727 itself despite orchestrator instructions to log findings to the tracker instead — content verified accurate, no harm done, but flagged as a process deviation worth tightening in the GAUNTLET skill's agent instructions.
- No CODEOWNERS file exists in this repo, so SYNC's Step 3 "check code ownership for cross-team changes" could not run.
- GLOBAL_ARCH.md (RECON) flagged the `communities.ts`↔`presentation/communities.ts` cycle as worth a GAUNTLET finding, but no GAUNTLET batch ever included those files, so it reached SYNC/FORGE with no pillar verdict — SYNC included a cycle-break plan item sourced from RECON data instead, flagged `driftWarning: true`. FORGE's investigation (phase 8) is what actually resolved this by proving it was a fabricated cycle (issue #1741). Future GAUNTLET runs should ensure RECON-flagged cross-domain cycles get a batch assignment.

### Codebase Observations (7)

Four of the seven `category: codebase` findings from GAUNTLET were real, verified bugs that were **fixed directly within this Titan run** rather than filed as separate issues (per the project convention that `gauntlet.ndjson` is the remediation-planning input for SYNC/FORGE, not a substitute issue tracker):

- `src/infrastructure/config.ts` `applyExcludeTestsShorthand` in-place mutation bug (config corruption across repos in long-running processes) — filed as #1725, **fixed in PR #4** (`f31468c6`).
- `src/db/connection.ts` `openReadonlyWithNative` resource-leak ordering bug — **fixed in PR #4** (`57d37825`), not separately filed.
- `src/domain/graph/builder/helpers.ts` `readFileSafe` event-loop-blocking `Atomics.wait` — **fixed in PR #2** (`e945bcae`), not separately filed.
- `src/types.ts` dead, stale duplicate type declarations shadowing real definitions — filed as #1727, **fixed in PR #1** (`820ff834`, `Closes #1727`).

The remaining three are process/coverage observations (dominance of false-positive dead-code categories in the raw `roles.deadCount` baseline, and the communities.ts cycle-coverage gap noted above) — informational only, no code action needed beyond what's already captured.

---

## Domains Analyzed

From `GLOBAL_ARCH.md` (18 domains mapped at RECON):

| Domain | Files | Status this run |
|--------|-------|------------------|
| Extractors | 34 | Decomposed (javascript.ts top-2 hotspots; 7 other language extractors' complexity fixes in PR #6) |
| Domain Graph — Builder | 18 | Decomposed + quality-fixed (PRs #3, #4, #9) |
| Domain Graph — Resolver | 3 | Quality-fixed (PR #5) |
| Domain Graph — Core | 6 | Not touched this run |
| Domain Search | 15 | Quality-fixed (`remote.ts` decomposed PR #3; `prepare.ts` fixed PR #5) |
| Domain Analysis | 12 | Not touched this run |
| Domain Core | 5 | Not touched this run |
| AST Analysis | 27 | Quality-fixed + warning polish (PRs #6, #7) |
| Features | 24 | Quality-fixed (`dataflow.ts`'s top hotspot functions carried forward — not in scope) |
| Graph (unified model) | 22 | Quality-fixed + adopted (PRs #5, #9) |
| DB | 20 | Quality-fixed (`connection.ts` leak fix, PR #4) |
| Shared | 10 | Not touched this run |
| Infrastructure | 8 | Abstraction extension + bug fix (PRs #2, #4) |
| CLI | 49 | Quality-fixed (`info.ts` decomposed, PR #6) |
| Presentation | 31 | Layering fix + quality-fixed (PRs #3, #6) |
| MCP Server | 41 | Not touched this run (already best-organized domain, cohesion 0.74) |
| Root | 3 | Dead code removed (PR #1) |
| Scripts & Tooling | ~15 | Abstraction + adoption (PRs #2, #6, #9) |
| Benchmark Tracer Tooling | ~15 | Warning polish, including crash-recovery redo (PR #7) |

---

## Pipeline Freshness

**Main at RECON:** 597ed1c3 (mainSHA recorded in titan-state.json)
**Main at CLOSE:** 597ed1c3
**Commits behind:** 0
**Overall staleness:** fresh

Main did not advance at all during this ~50.5-hour pipeline run. No drift-report.json entries were generated — no phase needed to re-audit stale targets.

### Drift Events

None. `mainSHA` in `titan-state.json` matched `origin/main` exactly at CLOSE time.

### Stale Targets

None.

---

## Recommendations for Next Run

1. **`src/features/dataflow.ts`** remains the single largest untouched complexity hotspot in the repo (`buildDataflowVerticesAndEdges`: cognitive 48, bugs 1.69; `buildDataflowEdges`: cognitive 54, bugs 1.46) — neither function was in scope for any phase this run. Strong candidate for the next RECON's priority queue.
2. **`collectObjectRestParams`** (extractors/javascript.ts, cognitive 70) and **`buildChaPostPass`** (build-edges.ts, cognitive 61) emerged as each file's new worst offender once this run's target functions were decomposed — both files may need a follow-up GAUNTLET pass.
3. **Dead-symbol count (+497)** is dominated by codegraph role-classifier false positives, not real dead code. The 6 new issues filed this run (#1779–#1784), plus #1723/#1769/#1770/#1771/#1773/#1776 from earlier phases, collectively describe most of the gap. Fixing these classifier bugs upstream would make the next Titan run's dead-code triage substantially faster and more trustworthy.
4. **Embeddings should be regenerated per-worktree** before RECON — `embeddingsAvailable: true` in titan-state carried over from a different worktree's DB and caused GAUNTLET's Rule 11 (DRY) semantic search to silently return empty results for the entire run.
5. **GLOBAL_ARCH.md-flagged cross-domain cycles should get a guaranteed GAUNTLET batch assignment** — the `communities.ts` cycle reached SYNC/FORGE with no pillar verdict because no batch happened to include those two files.
6. Consider whether the FORGE phase's ~22-hour interruption tolerance (successfully handled here via diff-review-before-continuing) should become a documented, named step in the titan-forge skill rather than relying on the resuming orchestrator's judgment.
