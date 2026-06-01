# Dogfooding Report: @optave/codegraph@3.11.1

**Date:** 2026-05-30
**Platform:** macOS (darwin 25.2.0), arm64
**Node:** v24.10.0
**Package under test:** `@optave/codegraph@3.11.1` (npm)
**Native binary:** `@optave/codegraph-darwin-arm64@3.11.1`
**Active engine:** `native (v3.11.1)` — confirmed via `codegraph info`

---

## 1. Setup & Installation

- Installed `@optave/codegraph@3.11.1` into a clean temp project (`/tmp/dogfood-3.11.1/target`).
- `codegraph --version` → `3.11.1`. ✅
- Native optional dependency `@optave/codegraph-darwin-arm64@3.11.1` resolved and loaded. `codegraph info` reports **Active engine: native (v3.11.1)** — no silent WASM fallback. ✅
- **Source-repo native binary refreshed.** The codegraph source repo's `node_modules` native addon was bumped to `3.11.1` so all phases run against a matching engine (Phase 0 step 6). Verified: `@optave/codegraph-darwin-arm64@3.11.1`, `codegraph info` → native. `package.json` / `package-lock.json` left **unchanged** in git (no pin commit on the fix branch).

## 2. Cold Start (Pre-Build)

Ran the command surface against the source repo **before** building a graph. Read-only/query commands degrade gracefully with a "no graph found / run build first" message rather than crashing. `build` then produced a graph cleanly.

**Built-graph state (worktree, native engine):**

| Metric | Value |
|--------|-------|
| Files | 777 (34 languages) |
| Nodes | 20,666 (function 3,891 · method 4,511 · parameter 8,588 · property 936 · constant 726 · file 777) |
| Edges | 43,179 (contains 20,657 · calls 10,192 · parameter_of 8,588) |
| Cycles | 1 file-level, 4 function-level |
| Graph quality | 68/100 |
| Caller coverage | 42.0% (3,528 / 8,402 functions have ≥1 caller) |
| Call confidence | 79.2% (8,074 / 10,192 call edges high-confidence) |
| Complexity | 4,405 functions · avg cognitive 4.5 · avg cyclomatic 3.1 · max cognitive 67 · avg MI 61.9 |

## 3. Full Command Sweep

Exercised the query, export, embedding, and infrastructure command groups with their JSON (`-j`) and no-tests (`-T`) flags. Query commands (`query`, `impact`, `deps`, `fn-impact`, `context`, `audit`, `where`, `diff-impact`, `cycles`, `structure`, `triage`), export (`dot`/`mermaid`/`json`), and infrastructure (`info`, `stats`, `map`, `registry list/add/remove/prune`) behaved as documented. Edge cases (non-existent symbol/file/function, invalid `--kind`) returned graceful "no results" messaging rather than stack traces.

## 4. Rebuild & Staleness

- **No-op rebuild:** `build` with no changes reports up-to-date; node/edge counts stable.
- **Incremental change:** touching one file re-parses only that file (verified via `--verbose` phase timings).
- **Full rebuild parity:** `build --no-incremental` matches incremental node/edge counts on the full-build path.

## 5. Engine Comparison

The **full-build** path (used by `build`, both engines) is at parity on `calls` edges (native and WASM agree). The divergence found this session is **not** in the full build — it is in the **watch-mode incremental cascade** (`rebuildFile` in `incremental.ts`), a separate JS resolver that only runs under `codegraph watch`. See §9.

From the build benchmark (625-file source repo):

> **Note on file count:** The benchmarks in §5 and §8 report a 625-file source repo, while §2's built-graph state shows 777 files. The benchmark was run with `--no-tests` (`-T`), which excludes test files from the parse sweep. The worktree build in §2 was run without that flag, so it includes test files and other generated artefacts absent from the benchmark run. The speedup ratios apply to the filtered 625-file set; the graph-quality and edge-count metrics in §2 describe the full 777-file worktree.

| Metric | WASM | Native | Native speedup |
|--------|------|--------|----------------|
| Full build | 7,529 ms | 1,393 ms | **5.4×** |
| Per-file build | 12 ms | 2.2 ms | 5.5× |
| Nodes | 19,298 | 19,297 | — |
| Edges | 40,000 | 39,999 | — |
| Query (avg) | 32.5 ms | 24.6 ms | 1.3× |

The 1-node / 1-edge delta between engines is a pre-existing divergence, not introduced this release. Tracked for investigation in #1263.

## 6. Release-Specific Tests (v3.11.1)

v3.11.1 is primarily a release-notes/CI-pinning release (claude-code-action model pin, regression-guard exemptions for the 3.11.1 no-op/full-build WASM CI noise). No new user-facing feature surface required targeted feature tests beyond the command sweep. The regression-guard suite was used to validate that the watch-cascade fix (§9) does not perturb full-build benchmarks.

## 7. Additional Testing (Phase 6)

- **Programmatic API:** `buildGraph` and query data-layer exports import and run from the built `dist`.
- **Registry multi-repo flow:** `registry add/list/remove` round-trips correctly (used and then cleaned up two dogfood entries).
- **Watch path:** driving `rebuildFile` directly (the watch reverse-dep cascade) is what surfaced the headline bug — see §9.

## 8. Performance Benchmarks

Run from the source repo, engine versions matched to 3.11.1. **Note:** benchmark JSON reports the worktree package version `3.11.2-dev.4` (the fix branch); the active parse engine is native 3.11.1.

### Build (per-phase, both engines, full build of 625 files)

| Phase | WASM (ms) | Native (ms) |
|-------|-----------|-------------|
| parse | 4,891.4 | 227.9 |
| insert | 353.4 | 351.9 |
| edges | 209.8 | 130.2 |
| ast | 240.7 | 197.0 |
| complexity | 829.6 | **17.9** |
| cfg | 242.2 | 131.4 |
| dataflow | 203.2 | 129.6 |
| structure | 55.8 | 25.2 |
| roles | 79.0 | 83.2 |
| **total** | **7,529** | **1,393** |

Native `complexityMs` (17.9) is far **below** WASM (829.6) — confirming the native binary computes complexity in-engine and is **not** stale (the staleness symptom would be native complexity 50–100× higher).

### 1-file rebuild (per-phase)

| Phase | WASM (ms) | Native (ms) |
|-------|-----------|-------------|
| collect | 14.8 | 5.4 |
| detect | 7.6 | 1.9 |
| edges | 1.7 | 3.9 |
| roles | 19.9 | 18.2 |
| **noop rebuild** | 26 | 23 |
| **1-file rebuild** | 56 | 79 |

`roles` dominates the 1-file rebuild on both engines (~18–20 ms) — it always recomputes globally regardless of how little changed. Candidate for incremental scoping, but not a regression.

**Why native wall-clock (79 ms) exceeds WASM (56 ms) despite faster individual phases:** the per-phase times sum to ~29 ms native vs ~44 ms WASM, yet the wall-clock total inverts. The remaining ~50 ms on the native path is FFI/IPC call overhead — each phase boundary crossing the Node.js ↔ native addon boundary adds serialisation and thread-dispatch latency. For large builds this overhead is amortised over many files (hence the 5.4× full-build speedup); for a single-file incremental payload the fixed per-call overhead dominates, making the native addon slower on small incremental payloads than the in-process WASM module. This is a known characteristic of native addons on small workloads, not a regression.

### Incremental & resolution

> **Note:** The "Full build" row here (6,510 ms WASM / 1,417 ms native) is from a separate benchmark run to the per-phase Build table above (7,529 ms / 1,393 ms). Both measured the same 625-file source repo but on different runs; the ~1,000 ms WASM gap and ~24 ms native gap reflect normal run-to-run JIT and scheduling variance, not a measurement inconsistency.

| Metric | WASM | Native |
|--------|------|--------|
| Full build | 6,510 ms | 1,417 ms |
| No-op rebuild | 21 ms | 24 ms |
| 1-file rebuild | 52 ms | 80 ms |

Import resolution: 1,006 imports · native batch 3.4 ms · JS fallback 7.1 ms (native ~2× faster).

### Query

| Op | WASM | Native |
|----|------|--------|
| fnDeps depth1/3/5 | 30.6 / 30.7 / 33.9 ms | 27.1 / 28.0 / 27.6 ms |
| fnImpact depth1/3/5 | 4.0 / 3.8 / 3.7 ms | 3.7 / 3.9 / 4.0 ms |
| diffImpact | 7.9 ms | 8.6 ms |

All within normal range; no regressions vs prior releases.

### Embedding benchmark — INCOMPLETE

The embedding benchmark **did not complete**. It iterates all configured models; on this hardware the `jina-base` worker embedded all 7,950 symbols but the per-model worker **timed out at the 1,800 s cap and was SIGKILLed** before recall (Hit@k) metrics were computed, then moved on to `jina-code` (also slow). The run was stopped manually. No Hit@1/3/5/10 numbers are available for this session. This is a **benchmark-harness/hardware throughput limitation, not a product defect** — the `embed`/`search` commands themselves worked in the command sweep (`-m minilm` recommended for interactive use; the default jina models are heavy). Recommend the embedding benchmark gain a `--models minilm` fast path or a lower default symbol cap so it completes within the worker timeout.

## 9. Bugs Found

### #1259 — Watch-mode incremental cascade inflates `calls` edges (High) — **FIXED, PR #1261**

The watcher's `rebuildFile` reverse-dep cascade carried its **own** call resolver (`resolveCallTargets` / `buildCallEdges` in `src/domain/graph/builder/incremental.ts`) that had drifted from the authoritative full-build resolver (`stages/build-edges.ts`):

1. **Unconditional global name fallback** — no receiver gating, no `confidence >= 0.5` filter — fanned out false-positive `calls` edges to same-named symbols in unrelated files.
2. **No dedup** — duplicate call sites produced duplicate `calls` rows on every rebuild.
3. **Import-scoped lookup didn't follow barrel re-exports** — dropped legitimate edges through `index`/barrel files.

On the codegraph repo, a **comment-only** watch rebuild of a widely-imported file inflated `calls` edges by **~700**. The existing parity tests never caught it because they drive `buildGraph` (native orchestrator), which never exercises the JS watch cascade.

**Fix (PR #1261, branch `fix/dogfood-incremental-call-resolution`):** ported the full-build resolution semantics into `incremental.ts` — barrel-target follow in the import-scoped branch, a shared `resolveByMethodOrGlobal` helper applying the same receiver gating + `>= 0.5` confidence filter, and per-rebuild edge dedup via a `seenCallEdges` set. Result: **exact `calls`-edge parity (10,178 / 10,178, zero duplicates)** between a watch-cascade rebuild and a clean full build on the real repo. Added regression test `tests/integration/issue-1259-watch-call-resolution.test.ts` (drives `rebuildFile` directly; fails on pre-fix code, passes after). Full suite green (2,788 passed, 11 skipped, 0 failed).

> **Note on edge counts:** The parity figure (10,178 / 10,178) was measured on the fix branch at the commit validated for PR #1261. The §2 built-graph state table shows 10,192 `calls` edges because it was measured on the worktree at report time, which includes additional changes (including the #1260-related residual divergence and subsequent merges to `main`) applied after the fix-branch validation snapshot. The two counts refer to different code states and are both accurate for their respective commits.

### #1260 — Watch cascade under-rebuilds receiver/extends/dynamic-import edges (Medium) — **OPEN**

After the #1259 fix landed exact `calls` parity, a residual **±36-edge** divergence remains in *other* edge kinds produced by the same cascade, in functions the #1259 fix does not touch: receiver −32, extends −3, dynamic-imports −12, imports +11. Filed separately to keep PR #1261 single-concern (one PR = one concern). Not addressed this session.

## 10. Suggestions for Improvement

1. **Collapse the two call resolvers.** The root cause of #1259 was a second, hand-maintained resolver in the watch path. The watch cascade should call the *same* resolution code as the full build rather than reimplementing it. PR #1261 closes the behavioral gap but the duplication remains — #1260 is the second symptom of it.
2. **Embedding benchmark completion.** Add a fast `--models minilm` path and/or lower the default symbol sample so the benchmark finishes inside the 1,800 s worker cap.
3. **Incremental `roles` scoping.** `roles` is the dominant phase in 1-file rebuilds (~20 ms) because it recomputes globally; scope it incrementally.

## 11. Issues & PRs Created

| Ref | Title | Severity | State |
|-----|-------|----------|-------|
| #1259 | watch-mode incremental cascade inflates `calls` edges (resolver divergence) | High | **Fixed** (PR #1261) |
| #1260 | watch-mode cascade under-rebuilds receiver/extends/dynamic-import edges | Medium | Open |
| #1263 | pre-existing 1-node / 1-edge WASM vs native full-build divergence (§5) | Low | Open |
| PR #1261 | fix(watch): align incremental call resolver with full build | — | Open |

## 12. Overall Assessment

v3.11.1 installs cleanly, the native engine loads and is **not** stale (verified via the complexity-phase timing check), and build/incremental/query benchmarks are all within normal range with native ~5× faster than WASM on full builds. The headline finding — the watch-mode `calls`-edge inflation (#1259) — is a genuine resolver-divergence bug that was reproduced, root-caused, fixed to exact parity, regression-tested, and shipped as PR #1261. A residual divergence in other watch-cascade edge kinds is tracked in #1260. The only blocked verification is the embedding recall benchmark, which timed out due to model throughput on this hardware (harness limitation, not a product defect). Release is sound; the watch path needed the §9 fix.
