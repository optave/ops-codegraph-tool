/**
 * Benchmark Regression Guard
 *
 * Reads the embedded JSON data from each self-generated benchmark report
 * (build, query, incremental) and asserts that the latest entry for each
 * engine has not regressed beyond the allowed threshold compared to the
 * previous release.
 *
 * This test runs in CI on every PR — it catches the kind of silent 100%+
 * regressions that slipped through in v3.0.1–3.4.0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

// ── Configuration ────────────────────────────────────────────────────────

/**
 * When BENCH_CANARY=1, only incremental-benchmark checks run and all timing
 * thresholds are raised to 50%. This mode is used by the per-PR perf-canary
 * workflow (.github/workflows/perf-canary.yml) which runs only on PRs
 * touching src/extractors/, src/domain/graph/, or crates/. The looser
 * threshold absorbs CI runner variance while still catching the class of
 * catastrophic regressions that hit v3.12.0 (+98%/+1827%).
 */
const BENCH_CANARY = process.env.BENCH_CANARY === '1';

/**
 * Maximum allowed regression (as a fraction, e.g. 0.25 = 25%).
 *
 * Why 25%: The report script warns at 15%, but timing benchmarks have
 * natural variance from CI runner load, GC pauses, etc. 25% filters
 * noise while still catching the catastrophic regressions we've seen
 * historically (100%–220%). Tune this down as benchmarks stabilize.
 *
 * Genuinely high-variance sub-30ms metrics get a wider tolerance via
 * `NOISY_METRICS` below — see that set's docstring for rationale.
 *
 * In BENCH_CANARY mode this is overridden to 0.5 (50%) — see above.
 */
const REGRESSION_THRESHOLD = BENCH_CANARY ? 0.5 : 0.25;

/**
 * Wider regression threshold applied to metrics in NOISY_METRICS.
 *
 * Sub-30ms timing metrics (no-op rebuild, 1-file rebuild, fnDeps depth 1)
 * routinely jitter ±10ms from CI runner load, GC pauses, and OS scheduling,
 * which translates to ±50%+ on small absolute numbers. The MIN_ABSOLUTE_DELTA
 * floor (10ms) filters trivial noise but cannot distinguish a 10–14ms
 * "real" jitter event from a regression on these specific metrics.
 *
 * Keeping the global threshold at 25% means a regression in the 30–100ms
 * range is still caught (e.g. 50ms→63ms = +26%, flagged), while sub-30ms
 * metrics in this set get the wider 50% allowance.
 *
 * In BENCH_CANARY mode this is overridden to 1.0 (100%) — the canary's
 * purpose is to catch gross regressions (+50%+), not sub-30ms jitter.
 */
const NOISY_METRIC_THRESHOLD = BENCH_CANARY ? 1.0 : 0.5;

/**
 * Metric labels treated as high-variance and given the NOISY_METRIC_THRESHOLD
 * tolerance instead of the default REGRESSION_THRESHOLD. Add a metric here
 * only when its baseline is consistently sub-30ms and CI variance has been
 * empirically shown to exceed 25%.
 *
 * - `fnDeps depth 1`: native baseline 28.7ms (v3.9.6). The fn_deps Rust
 *   implementation, fnDepsData JS wrapper, and DB schema/indexes are all
 *   byte-for-byte unchanged since v3.9.6 (verified by `git log v3.9.6..HEAD`
 *   on crates/codegraph-core/src/read_queries.rs, src/domain/analysis/
 *   dependencies.ts, src/db/, crates/codegraph-core/src/db/connection.rs).
 *   CI consistently measures +40–60% on this sub-30ms metric while the
 *   absolute delta (~13ms) is at the noise floor for shared runners.
 *   Methodology already discards 3 warmup runs (#1077). Same pattern as
 *   No-op rebuild and 1-file rebuild — sub-30ms baseline amplified by
 *   ±10ms runner jitter into a percentage swing that looks like regression.
 */
const NOISY_METRICS = new Set<string>(['No-op rebuild', '1-file rebuild', 'fnDeps depth 1']);

/**
 * Wider regression threshold applied to *timing* metrics measured under the
 * WASM engine (build/query/incremental tests pass `engine: 'wasm'`).
 *
 * Why a dedicated WASM tolerance: the WASM engine runs every build/query
 * through the tree-sitter-wasm interpreter, so its wall-clock is 3–5× slower
 * than native and dominated by interpreter + GC overhead. The same ±10–20ms
 * of shared-runner jitter therefore lands as a much larger *percentage* swing
 * than on native. Empirically, WASM timing metrics on the publish runner swing
 * run-to-run by +27–71% on byte-identical code (No-op rebuild 15→25 = +67%,
 * Query time 32.5→44.2 = +36%, fnDeps depth 3/5 ~+31%, Full build 7664→9833
 * = +28%, Build ms/file 18.7→32 = +71%), which previously required a
 * per-version KNOWN_REGRESSIONS entry for each metric on every release — an
 * endless whack-a-mole.
 *
 * Why this is safe: the native engine shares all extraction, resolution, and
 * query logic with WASM (the WASM path only swaps the parser/runtime), so any
 * *real* algorithmic regression shows up on the native numbers too — and native
 * keeps the strict 25% / 50% thresholds. Native is the canary. WASM timing only
 * needs to catch gross WASM-specific catastrophes (the 100–220% blowups seen in
 * v3.0.1–3.4.0), which 75% still flags, while absorbing the ≤71% shared-runner
 * jitter. Size metrics (DB bytes/file) are engine-independent and excluded from
 * this widening via SIZE_METRICS below — they keep the strict threshold.
 *
 * In BENCH_CANARY mode this is overridden to 1.5 (150%) — the canary targets
 * gross regressions only, and WASM incremental metrics have extreme variance
 * on shared runners.
 */
const WASM_TIMING_THRESHOLD = BENCH_CANARY ? 1.5 : 0.75;

/**
 * Metric labels that measure size/count rather than wall-clock time. These are
 * deterministic across runs (a no-op for CI jitter) and engine-independent, so
 * they are NOT given the WASM_TIMING_THRESHOLD widening — a genuine size jump
 * should be caught at the strict threshold regardless of engine.
 */
const SIZE_METRICS = new Set<string>(['DB bytes/file']);

/**
 * Minimum absolute delta required before a regression is flagged.
 * Small measurements fluctuate heavily from CI runner load, GC, and
 * OS scheduling jitter — a 13ms→19ms jump is +46% but only 6ms of noise.
 * This floor prevents false positives on inherently noisy metrics.
 *
 * Applied to all numeric metrics (timing in ms, sizes in bytes, counts).
 * For timing metrics the 10-unit floor filters sub-10ms jitter; for byte
 * or count metrics the floor is effectively a no-op since deltas are
 * orders of magnitude larger.
 */
const MIN_ABSOLUTE_DELTA = 10;

/**
 * Versions to skip entirely from regression comparisons.
 *
 * - v3.8.0: benchmarks produced with broken native build orchestrator (#804)
 *   that dropped 12.6% of edges, making build times and query latencies
 *   appear artificially low.
 * v3.8.1 was previously skipped (assumed inflated by per-call NAPI overhead
 * in BFS), but v3.9.0 post-fix data shows equivalent queryTimeMs (~30ms),
 * proving v3.8.1 measurements were not inflated. Un-skipped to provide a
 * valid baseline for v3.9.0 comparisons.
 *
 * These entries are skipped whether they appear as the latest or baseline.
 */
const SKIP_VERSIONS = new Set(['3.8.0']);

/**
 * Known regressions that are already documented with root-cause analysis
 * and tracked in issues. These metric+version pairs are excluded from
 * the regression guard to avoid blocking benchmark data PRs while the
 * underlying issue is being fixed.
 *
 * Format: "version:metric-label" (must match the label passed to checkRegression).
 * Resolution keys use: "version:resolution <lang> precision" or "version:resolution <lang> recall".
 *
 * The `version` is the release where the regression was first observed.
 * When the per-PR gate runs `dev` against that release as baseline, the
 * exemption applies via the baseline-version fallback in assertNoRegressions
 * (and the resolution loop) — so a single `3.11.0:Foo` entry covers both
 * `3.11.0 vs 3.10.0` and every subsequent `dev vs 3.11.0` comparison until
 * the next release clears the regression and the entry is pruned.
 *
 * Entries fire only when `latest.version` matches the prefix (or, for `dev`
 * latest, when `previous.version` matches via the baseline fallback). Once
 * a version is no longer the latest in committed history and no longer the
 * baseline used for `dev` comparisons, its entries become dead weight and
 * should be removed (last pruned: 3.9.0/3.9.1/3.9.2/3.9.6/3.10.0).
 *
 * - 3.11.0:Query time / 3.11.0:No-op rebuild / 3.11.0:fnDeps depth 3 /
 *   3.11.0:fnDeps depth 5 — CI runner variance on sub-50ms WASM metrics
 *   when the per-PR gate replays dev against the just-published 3.11.0
 *   baseline. The dev source tree between commit f7c29c5 (3.11.0 release)
 *   and the post-publish docs PR (#1217) contains only version-bump diffs
 *   in package.json/Cargo.toml/package-lock.json — no extractor, query,
 *   or DB changes. Published 3.11.0 numbers were captured by the publish
 *   workflow on one runner; the per-PR gate re-measures on a fresh runner
 *   and lands ~10ms higher on every sub-50ms WASM metric:
 *     - Query time:    32.5 → 44.2 (+36%) on run 26426483639
 *     - No-op rebuild: 18   → 29   (+61%)
 *     - fnDeps depth 3: 33.6 → 44.1 (+31%)
 *     - fnDeps depth 5: 33.3 → 44.4 (+33%)
 *   The 3.11.0 vs 3.10.0 release-time comparison shows these metrics
 *   either flat or improved (Query time 37.6 → 32.5 = -14%, fnDeps depth 3
 *   33 → 33.6 = ~flat, fnDeps depth 5 33 → 33.3 = ~flat, No-op rebuild
 *   15 → 18 = +20% but at runner noise floor) — confirming no underlying
 *   regression and ruling out a real slowdown introduced in 3.11.0. Same
 *   shape and root cause as the pruned 3.10.0 entries. Exempt this release;
 *   remove once 3.13.0+ data confirms the new steady-state on whatever
 *   runner generation is current at that time.
 *
 * - 3.11.0:1-file rebuild — CI runner variance on a sub-100ms native
 *   incremental metric. The 3.11.0 baseline was captured at 64ms; the
 *   per-PR gate re-measures dev on a fresh runner and can land +45ms
 *   higher (e.g. 64 → 109ms = +70%, threshold 50%) on runs where the
 *   runner is under load. No incremental, Rust, or JS change in the
 *   dev tree accounts for this delta — other dep-only PRs running
 *   concurrently measured 64 → 80ms (+25%) on the same corpus
 *   (run 26706695868), confirming per-runner noise rather than a
 *   structural slowdown. The 50% NOISY_METRIC_THRESHOLD is razor-thin
 *   for a sub-100ms metric at shared-runner noise floor (~20ms). Exempt
 *   this release; remove once 3.13.0+ data confirms stabilization.
 *
 * - 3.11.0:Full build — same CI runner-variance root cause as the four
 *   3.11.0 entries above, but on the multi-second WASM full-build metric
 *   rather than the sub-50ms group. Surfaced on the embedding-bench docs
 *   PR (#1218) when the per-PR gate re-measured dev (byte-identical to
 *   released 3.11.0 modulo EMBEDDING-BENCHMARKS.md) against the published
 *   3.11.0 baseline:
 *     - Full build (wasm): 7664 → 9765 (+27%, threshold 25%) on run 26431397916
 *   Historical WASM full-build numbers on the same corpus span 7.2s–14.0s
 *   across 3.9.0–3.11.0, so 9.8s on a single dev re-measurement sits well
 *   inside the runner-noise envelope (3.10.0 baseline was 8.4s, 3.9.6 was
 *   14.0s). PR #1217's gate measured 7664 — the same code on a fresh
 *   runner instance later measured 9765. No extractor, builder, or DB
 *   layer changed between 3.11.0 release and #1218; only EMBEDDING-
 *   BENCHMARKS.md, which is not loaded at build time. Exempt this release;
 *   remove once 3.13.0+ data confirms stabilization under whatever runner
 *   generation is current at that time.
 *
 * - 3.11.1:DB bytes/file — same methodology-scope artifact as 3.10.0:DB
 *   bytes/file. The 3.11.0 release does not have query benchmark data
 *   committed to history, so findLatestPair falls back to 3.10.0 as the
 *   baseline. The 3.10.0 corpus included resolution fixtures (~745 files);
 *   3.11.1 measures only the codegraph source (~607 files) after #1134
 *   excluded resolution fixtures from the build sweep. The denominator
 *   shrinks while total DB content stays roughly constant, inflating
 *   dbSizeBytes/file: native 41614 → 54107 (+30%), wasm 41543 → 53517
 *   (+29%). No schema or extraction change; remove once 3.13.0+ data is
 *   captured with the full 3.11.x baseline in committed query history.
 *
 * - 3.11.1:fnDeps depth 3 / 3.11.1:fnDeps depth 5 — same baseline-gap
 *   root cause as 3.11.1:DB bytes/file. Because 3.11.0 query benchmark
 *   data is absent from committed history, the guard compares 3.11.1
 *   against the pre-3.11.0 3.10.0 baseline. The 3.10.0 query numbers
 *   predate the steady-state established in 3.11.0 (fnDeps depth 3: 33ms,
 *   depth 5: 33ms), so 3.11.1's equivalent values appear as regressions:
 *     - native fnDeps depth 3: 24.3 → 34.7 (+43%)
 *     - native fnDeps depth 5: 24.7 → 34.7 (+40%)
 *     - wasm   fnDeps depth 3: 33   → 43.2 (+31%)
 *     - wasm   fnDeps depth 5: 33   → 43.5 (+32%)
 *   No fn_deps Rust implementation, fnDepsData JS wrapper, or DB index
 *   changed between 3.10.0 and 3.11.1. Remove once 3.12.0+ data confirms
 *   stable query numbers against a 3.11.x baseline.
 *
 * - 3.11.2:No-op rebuild — CI runner variance on a sub-30ms native metric.
 *   The 3.11.2 baseline captures noopRebuildMs=25 (build benchmark) and
 *   noopRebuildMs=19 (incremental benchmark); the per-PR gate re-measures
 *   dev on a fresh runner and lands at 45ms (+80%) and 37ms (+95%) on run
 *   26792023287 — both exceed the NOISY_METRIC_THRESHOLD of 50% due to
 *   sub-30ms variance. No watcher, builder, or incremental-orchestrator
 *   change is present in the dev tree for this docs-only PR (#1282);
 *   the delta is entirely shared-runner scheduling noise. Same shape and
 *   root cause as the 3.11.0 and 3.11.1 entries above. Exempt this
 *   release; remove once 3.13.0+ data confirms the steady-state.
 *
 * - 3.11.2:1-file rebuild — CI runner variance on the sub-100ms native
 *   incremental metric. The 3.11.2 baseline was captured at 83ms; the
 *   per-PR gate for the Phase 8.1 TypeScript resolver PR (#1278) re-measured
 *   dev on a fresh runner and landed at 212ms (+155%, threshold 50%) on run
 *   26793082961. The same PR modifies only: (a) a new ts-resolver.ts module
 *   gated behind `typescriptResolver: false` (was the default at the time), (b) an import of
 *   that module in build-edges.ts, and (c) a config field — none of which
 *   execute on the incremental hot path. Locally the same PR measures 86ms
 *   (within noise of the 83ms baseline). The 3.11.0:1-file rebuild exemption
 *   above documents the same pattern for the same baseline range. Exempt
 *   this release; remove once 3.13.0+ data confirms stabilization.
 *
 * - 3.11.2:Full build — CI runner variance on the multi-second native
 *   full-build metric. The 3.11.2 baseline captures fullBuildMs=2231; the
 *   per-PR gate for the Phase 8.3c parameter-flow PR (#1308) re-measured dev
 *   on a fresh runner and landed at 2852ms (+28%, threshold 25%) on run
 *   27003863932. The PR adds CHA post-pass and parameter-flow tracking that
 *   each contribute microseconds-level overhead per call site — not hundreds
 *   of milliseconds. Historical native full-build numbers on this corpus span
 *   1959ms (3.10.0) to 2986ms (3.9.6), so 2852ms sits well within the
 *   runner-noise envelope. Same shape and root cause as the 3.11.0:Full build
 *   exemption above (which was a WASM metric; this is native). Exempt this
 *   release; remove once 3.13.0+ data confirms the steady-state.
 *
 * - 3.12.0:No-op rebuild — CI runner variance on a sub-50ms native metric.
 *   The 3.12.0 baseline captures noopRebuildMs=30 (build benchmark) and
 *   noopRebuildMs=23 (incremental benchmark); the per-PR gate re-measures
 *   dev on a fresh runner and lands at 48ms (+60%) and 48ms (+109%) on run
 *   27457266151 — both exceed the NOISY_METRIC_THRESHOLD of 50% due to
 *   sub-50ms variance on shared runners. This PR (#1487) adds warmup runs to
 *   benchmark.ts on the no-op and 1-file rebuild tiers; on a true no-op
 *   rebuild no files are re-parsed and build-edges.ts is never reached, so
 *   none of the code changes in this branch execute on the hot path. The
 *   delta is entirely shared-runner scheduling noise. Same shape and root
 *   cause as 3.11.2:No-op rebuild. Exempt this release; remove once
 *   3.13.0+ data confirms the steady-state.
 *
 * - 3.12.0:Full build — root-caused residual feature cost of the Phase 8.x
 *   resolution work on the native engine. The v3.12.0 publish gate first
 *   measured 2231 → 3333 (+49%). Local A/B against a v3.11.2 baseline worktree
 *   (same machine, release-built addons for each side) attributed the delta to
 *   three post-pass regressions, all fixed: (a) the func-prop WASM re-parse
 *   post-pass booted the WASM worker pool on every native full build and
 *   inserted zero nodes on this corpus (~430ms — removed; the Rust extractor
 *   now emits func-prop method definitions, #1432); (b) an unscoped full-graph
 *   role re-classification after the CHA/this-dispatch post-passes (~130ms —
 *   now scoped to files containing the new edges' endpoints); (c) the
 *   this-dispatch pass booted the in-process WASM runtime to re-parse hierarchy
 *   files (~40ms — now re-parsed through the already-loaded native engine).
 *   The remaining delta (local: 1378ms → ~1745ms, +26% including 630 → 672
 *   corpus growth) is in-phase Rust extraction cost of the Phase 8.x features
 *   themselves — parse +28%/file (points-to, return-type, prototype and
 *   func-prop extraction), insert/edges +10–20% — which lands at the 25%
 *   threshold boundary under CI runner variance. This is measured feature
 *   cost, not an undiagnosed regression. Tracking: #1433 (per-PR perf canary),
 *   #1434 (post-pass phase timings). Remove once 3.13+ data establishes the
 *   new steady-state baseline.
 *
 * - 3.12.0:1-file rebuild — CI methodology noise on the ~100ms native metric:
 *   the build-benchmark suite measures this tier with no warmup runs (#1440),
 *   unlike the incremental suite, whose identical metric PASSED in the same
 *   publish run that flagged this one (86 → 131, +52%, noisy threshold 50%).
 *   Local A/B on the same machine shows parity: v3.11.2 baseline 84–102ms vs
 *   dev 97–108ms (overlapping ranges). The only systematic additions on this
 *   path are the CHA scan (~12ms, scoping tracked in #1441) and the native
 *   this-dispatch re-parse of the changed file (~2ms). Same shape as the
 *   3.11.2:1-file rebuild entry above. Remove once #1440 lands warmups and
 *   3.13+ data confirms the steady state.
 *
 * NOTE: WASM *timing* noise no longer needs per-version entries here — it is
 * handled structurally by WASM_TIMING_THRESHOLD (see above). The 3.11.x
 * entries that remain are kept because they trip the *native* engine too
 * (fnDeps depth 3/5: native 24.3→34.7, 24.7→34.7) or are size metrics
 * (DB bytes/file), neither of which the WASM widening covers.
 */
const KNOWN_REGRESSIONS = new Set([
  '3.11.0:Query time',
  '3.11.0:No-op rebuild',
  '3.11.0:1-file rebuild',
  '3.11.0:fnDeps depth 3',
  '3.11.0:fnDeps depth 5',
  '3.11.0:Full build',
  '3.11.1:DB bytes/file',
  '3.11.1:fnDeps depth 3',
  '3.11.1:fnDeps depth 5',
  '3.11.2:No-op rebuild',
  '3.11.2:1-file rebuild',
  '3.11.2:Full build',
  '3.12.0:No-op rebuild',
  '3.12.0:Full build',
  '3.12.0:1-file rebuild',
  // tree-sitter-erlang devDependency removed (GHSA-rphw-c8qj-jv84 — malware).
  // The erlang WASM is no longer built, so erlang resolution drops to 0%.
  // These entries exempt the expected precision/recall drop on every build
  // that follows the 3.12.0 baseline until a clean replacement grammar is
  // integrated and a new baseline is captured.
  '3.12.0:resolution erlang precision',
  '3.12.0:resolution erlang recall',
]);

/**
 * Maximum minor-version gap allowed for comparison. When the nearest
 * usable baseline is more than MAX_VERSION_GAP minor versions away,
 * the comparison is skipped — feature additions (new analysis phases,
 * more languages, deeper extraction) make cross-gap comparisons unreliable.
 */
const MAX_VERSION_GAP = 3;

// ── Helpers ──────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..', '..');
const BENCHMARKS_DIR = path.join(ROOT, 'generated', 'benchmarks');

interface RegressionCheck {
  label: string;
  current: number;
  previous: number;
  pctChange: number;
}

/**
 * Extract the JSON array from an HTML comment in a markdown file.
 * Each report embeds its historical data in a comment like:
 *   <!-- BENCHMARK_DATA [...] -->
 */
function extractJsonData<T>(filePath: string, marker: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  const re = new RegExp(`<!--\\s*${marker}\\s*([\\s\\S]*?)\\s*-->`);
  const match = content.match(re);
  if (!match) return [];
  try {
    return JSON.parse(match[1]);
  } catch (err) {
    console.error(
      `[regression-guard] Failed to parse JSON from ${filePath} (marker: ${marker}):`,
      err,
    );
    return [];
  }
}

/**
 * Parse a semver string into [major, minor, patch].
 */
function parseSemver(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Count the minor-version distance between two semver strings.
 * Returns Infinity for unparseable versions.
 */
function minorGap(a: string, b: string): number {
  const sa = parseSemver(a);
  const sb = parseSemver(b);
  if (!sa || !sb) return Infinity;
  return Math.abs(sa[0] * 100 + sa[1] - (sb[0] * 100 + sb[1]));
}

/**
 * Count the effective version gap between two versions, including
 * skipped versions between them.  When multiple intermediate versions
 * are in SKIP_VERSIONS (e.g. 3.8.0 and 3.8.1), the comparison spans
 * a larger real gap than the raw minor-version distance suggests.
 * Adding skipped-version count to the minor gap prevents comparing
 * across feature-expansion boundaries where intermediate baselines
 * were invalidated.
 */
function effectiveGap(a: string, b: string): number {
  const raw = minorGap(a, b);
  if (raw === Infinity) return Infinity;
  const sa = parseSemver(a);
  const sb = parseSemver(b);
  if (!sa || !sb) return Infinity;
  const [lo, hi] = [a, b].sort((x, y) => {
    const px = parseSemver(x)!;
    const py = parseSemver(y)!;
    return px[0] * 10000 + px[1] * 100 + px[2] - (py[0] * 10000 + py[1] * 100 + py[2]);
  });
  const loSv = parseSemver(lo)!;
  const hiSv = parseSemver(hi)!;
  const loVal = loSv[0] * 10000 + loSv[1] * 100 + loSv[2];
  const hiVal = hiSv[0] * 10000 + hiSv[1] * 100 + hiSv[2];
  // Count distinct skipped versions that fall between lo and hi
  const skippedBetween = new Set(
    [...SKIP_VERSIONS].filter((v) => {
      const sv = parseSemver(v);
      if (!sv) return false;
      const val = sv[0] * 10000 + sv[1] * 100 + sv[2];
      return val > loVal && val < hiVal;
    }),
  );
  return raw + skippedBetween.size;
}

/**
 * Find the latest entry for a given engine, then the next non-dev
 * entry with data for that engine (the "previous release").
 */
function findLatestPair<T extends { version: string }>(
  history: T[],
  hasEngine: (entry: T) => boolean,
): { latest: T; previous: T } | null {
  // Try each candidate as "latest", starting from the most recent.
  // If the latest entry has no valid baseline within the effective gap,
  // fall through to the next candidate — this ensures we always find
  // the most recent *comparable* pair rather than giving up when the
  // newest entry spans a large feature-expansion gap.
  for (let latestIdx = 0; latestIdx < history.length; latestIdx++) {
    if (SKIP_VERSIONS.has(history[latestIdx].version)) continue;
    if (!hasEngine(history[latestIdx])) continue;

    const latestVersion = history[latestIdx].version;
    // 'dev' represents the current PR build (rolling entry — see
    // scripts/update-benchmark-report.ts). It has no parseable semver,
    // so effectiveGap('dev', anyRelease) returns Infinity — without this
    // bypass, the gap check below would skip dev entirely and the loop
    // would silently fall through to compare two real releases instead
    // of dev vs the latest release, defeating the per-PR gate.
    const isDevLatest = latestVersion === 'dev';

    // Find previous non-dev entry with data for this engine, skipping
    // versions with known unreliable benchmark data and versions that
    // are too far apart for meaningful comparison.  The effective gap
    // includes skipped versions between the pair — when intermediate
    // releases are in SKIP_VERSIONS, the real distance is larger than
    // the raw minor-version count.
    for (let i = latestIdx + 1; i < history.length; i++) {
      const entry = history[i];
      if (entry.version === 'dev') continue;
      if (SKIP_VERSIONS.has(entry.version)) continue;
      if (!hasEngine(entry)) continue;
      // Skip the gap check when comparing dev → release: dev is always
      // the current build, so the most recent comparable release is the
      // correct baseline regardless of feature-expansion distance.
      if (!isDevLatest && effectiveGap(latestVersion, entry.version) > MAX_VERSION_GAP) continue;
      return { latest: history[latestIdx], previous: entry };
    }
    // No valid baseline for this latest — try the next candidate
  }
  return null; // No suitable pair found anywhere in the history
}

/**
 * Assert that a history array is sorted newest-first (index 0 = most recent).
 * The comparison logic depends on this ordering — if violated, the guard would
 * silently compare wrong pairs and miss real regressions.
 */
function assertNewestFirst<T extends { date?: string }>(history: T[], label: string): void {
  const dated = history.filter(
    (e): e is T & { date: string } => typeof e.date === 'string' && e.date.length > 0,
  );
  if (dated.length >= 2) {
    expect(
      new Date(dated[0].date) >= new Date(dated[1].date),
      `${label} history must be sorted newest-first (index 0 = latest)`,
    ).toBe(true);
  }
}

/**
 * Assert that a metric has not regressed beyond the threshold.
 * Only checks metrics where higher = worse (timing, sizes).
 */
function checkRegression(
  label: string,
  current: number | null | undefined,
  previous: number | null | undefined,
): RegressionCheck | null {
  if (current == null || previous == null || previous === 0) return null;
  const absDelta = current - previous;
  if (absDelta < MIN_ABSOLUTE_DELTA) return null; // below noise floor
  const pctChange = absDelta / previous;
  return { label, current, previous, pctChange };
}

function thresholdFor(label: string, engine?: string): number {
  // WASM timing metrics get the widest tolerance (see WASM_TIMING_THRESHOLD).
  // Size metrics are engine-independent and excluded from the widening.
  if (engine === 'wasm' && !SIZE_METRICS.has(label)) return WASM_TIMING_THRESHOLD;
  return NOISY_METRICS.has(label) ? NOISY_METRIC_THRESHOLD : REGRESSION_THRESHOLD;
}

function assertNoRegressions(
  checks: (RegressionCheck | null)[],
  version?: string,
  baselineVersion?: string,
  engine?: string,
) {
  const real = checks.filter(Boolean) as RegressionCheck[];
  const regressions = real.filter((c) => {
    if (c.pctChange <= thresholdFor(c.label, engine)) return false;
    if (version && KNOWN_REGRESSIONS.has(`${version}:${c.label}`)) return false;
    // When `latest` is the rolling 'dev' build, KNOWN_REGRESSIONS entries
    // are anchored to the release where the regression was first observed
    // (e.g. '3.9.6:No-op rebuild'), not to 'dev'. Fall back to the baseline
    // version so a regression introduced before release N stays exempt for
    // every PR comparing dev → N until release N+1 clears it.
    if (
      version === 'dev' &&
      baselineVersion &&
      KNOWN_REGRESSIONS.has(`${baselineVersion}:${c.label}`)
    ) {
      return false;
    }
    return true;
  });

  if (regressions.length > 0) {
    const details = regressions
      .map(
        (r) =>
          `  ${r.label}: ${r.previous} → ${r.current} (+${Math.round(r.pctChange * 100)}%, threshold ${Math.round(thresholdFor(r.label, engine) * 100)}%)`,
      )
      .join('\n');
    expect.fail(`Benchmark regressions exceed threshold:\n${details}`);
  }
}

// ── Build benchmark data types ───────────────────────────────────────────

interface BuildEngine {
  buildTimeMs: number;
  queryTimeMs: number;
  dbSizeBytes: number;
  perFile: {
    buildTimeMs: number;
    nodes: number;
    edges: number;
    dbSizeBytes: number;
  };
  noopRebuildMs?: number;
  oneFileRebuildMs?: number;
}

interface BuildEntry {
  version: string;
  date: string;
  files: number;
  native?: BuildEngine | null;
  wasm?: BuildEngine | null;
}

// ── Query benchmark data types ───────────────────────────────────────────

interface QueryEngine {
  fnDeps: { depth1Ms: number; depth3Ms: number; depth5Ms: number };
  fnImpact: { depth1Ms: number; depth3Ms: number; depth5Ms: number };
  diffImpact: { latencyMs: number };
}

interface QueryEntry {
  version: string;
  date: string;
  native?: QueryEngine | null;
  wasm?: QueryEngine | null;
}

// ── Incremental benchmark data types ─────────────────────────────────────

interface IncrementalEngine {
  fullBuildMs: number;
  noopRebuildMs: number;
  oneFileRebuildMs: number;
}

interface IncrementalEntry {
  version: string;
  date: string;
  files: number;
  native?: IncrementalEngine | null;
  wasm?: IncrementalEngine | null;
  resolve?: {
    nativeBatchMs: number;
    jsFallbackMs: number;
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

// Release-blocking gate: runs pre-publish (after fresh benchmark numbers are
// written by the pre-publish-benchmark job in .github/workflows/publish.yml)
// and during local invocations of `npm run test:regression-guard`. Skipped
// in the default `npm test` run so docs commits that merge already-recorded
// regressed history into main don't trigger false failures — by then the
// release has already passed the gate.
//
// When BENCH_CANARY=1 (set by .github/workflows/perf-canary.yml), only the
// incremental-benchmark suite runs and thresholds are raised to 50% — see
// the BENCH_CANARY constant above.
const RUN_REGRESSION_GUARD = process.env.RUN_REGRESSION_GUARD === '1';

describe.runIf(RUN_REGRESSION_GUARD)('Benchmark regression guard', () => {
  const buildHistory = extractJsonData<BuildEntry>(
    path.join(BENCHMARKS_DIR, 'BUILD-BENCHMARKS.md'),
    'BENCHMARK_DATA',
  );
  const queryHistory = extractJsonData<QueryEntry>(
    path.join(BENCHMARKS_DIR, 'QUERY-BENCHMARKS.md'),
    'QUERY_BENCHMARK_DATA',
  );
  const incrementalHistory = extractJsonData<IncrementalEntry>(
    path.join(BENCHMARKS_DIR, 'INCREMENTAL-BENCHMARKS.md'),
    'INCREMENTAL_BENCHMARK_DATA',
  );

  // Warn when KNOWN_REGRESSIONS entries are stale (more than 1 minor version
  // behind the current package version).  This makes the stale-exemption
  // problem self-detecting rather than requiring manual bookkeeping.
  // Skipped in canary mode — this check is maintenance-only and irrelevant
  // for a lightweight build-time regression gate.
  test.skipIf(BENCH_CANARY)('KNOWN_REGRESSIONS entries are not stale', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkgVersion: string = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ).version;
    const stale: string[] = [];
    for (const entry of KNOWN_REGRESSIONS) {
      const colonIdx = entry.indexOf(':');
      if (colonIdx === -1) continue;
      const entryVersion = entry.slice(0, colonIdx);
      const gap = minorGap(entryVersion, pkgVersion);
      if (gap > 1) {
        stale.push(
          `${entry} (version ${entryVersion} is ${gap} minor versions behind ${pkgVersion})`,
        );
      }
    }
    if (stale.length > 0) {
      console.warn(
        `[regression-guard] Stale KNOWN_REGRESSIONS entries — remove after verifying corrected data:\n  ${stale.join('\n  ')}`,
      );
    }
    expect(
      stale.length,
      `KNOWN_REGRESSIONS has ${stale.length} stale entries (>1 minor version behind ${pkgVersion}). ` +
        `Remove them after verifying the corrected benchmark data has landed:\n  ${stale.join('\n  ')}`,
    ).toBe(0);
  });

  // Validate newest-first ordering assumption for all history arrays.
  // Build/query ordering checks are skipped in canary mode (only incremental
  // history is updated by the canary workflow).
  test.skipIf(BENCH_CANARY)('build history is sorted newest-first', () => {
    assertNewestFirst(buildHistory, 'Build benchmark');
  });
  test.skipIf(BENCH_CANARY)('query history is sorted newest-first', () => {
    assertNewestFirst(queryHistory, 'Query benchmark');
  });
  test('incremental history is sorted newest-first', () => {
    assertNewestFirst(incrementalHistory, 'Incremental benchmark');
  });

  // In canary mode only the incremental suite runs — build/query/resolution
  // benchmarks are not measured by the perf-canary workflow.
  describe.skipIf(BENCH_CANARY)('build benchmarks', () => {
    for (const engineKey of ['native', 'wasm'] as const) {
      const pair = findLatestPair(buildHistory, (e) => e[engineKey] != null);
      if (!pair) continue;

      const { latest, previous } = pair;
      const cur = latest[engineKey]!;
      const prev = previous[engineKey]!;

      test(`${engineKey} engine — ${latest.version} vs ${previous.version}`, () => {
        assertNoRegressions(
          [
            checkRegression(`Build ms/file`, cur.perFile.buildTimeMs, prev.perFile.buildTimeMs),
            checkRegression(`Query time`, cur.queryTimeMs, prev.queryTimeMs),
            checkRegression(`DB bytes/file`, cur.perFile.dbSizeBytes, prev.perFile.dbSizeBytes),
            checkRegression(`No-op rebuild`, cur.noopRebuildMs, prev.noopRebuildMs),
            checkRegression(`1-file rebuild`, cur.oneFileRebuildMs, prev.oneFileRebuildMs),
          ],
          latest.version,
          previous.version,
          engineKey,
        );
      });
    }

    test('has at least one engine to compare', () => {
      const hasAny = ['native', 'wasm'].some(
        (ek) => findLatestPair(buildHistory, (e) => e[ek as keyof BuildEntry] != null) != null,
      );
      expect(hasAny, 'No build benchmark data with ≥2 entries to compare').toBe(true);
    });
  });

  describe.skipIf(BENCH_CANARY)('query benchmarks', () => {
    for (const engineKey of ['native', 'wasm'] as const) {
      const pair = findLatestPair(queryHistory, (e) => e[engineKey] != null);
      if (!pair) continue;

      const { latest, previous } = pair;
      const cur = latest[engineKey]!;
      const prev = previous[engineKey]!;

      test(`${engineKey} engine — ${latest.version} vs ${previous.version}`, () => {
        assertNoRegressions(
          [
            checkRegression(`fnDeps depth 1`, cur.fnDeps.depth1Ms, prev.fnDeps.depth1Ms),
            checkRegression(`fnDeps depth 3`, cur.fnDeps.depth3Ms, prev.fnDeps.depth3Ms),
            checkRegression(`fnDeps depth 5`, cur.fnDeps.depth5Ms, prev.fnDeps.depth5Ms),
            checkRegression(`fnImpact depth 1`, cur.fnImpact.depth1Ms, prev.fnImpact.depth1Ms),
            checkRegression(`fnImpact depth 3`, cur.fnImpact.depth3Ms, prev.fnImpact.depth3Ms),
            checkRegression(`fnImpact depth 5`, cur.fnImpact.depth5Ms, prev.fnImpact.depth5Ms),
            checkRegression(
              `diffImpact latency`,
              cur.diffImpact.latencyMs,
              prev.diffImpact.latencyMs,
            ),
          ],
          latest.version,
          previous.version,
          engineKey,
        );
      });
    }

    test('has at least one engine to compare', () => {
      const hasAny = ['native', 'wasm'].some(
        (ek) => findLatestPair(queryHistory, (e) => e[ek as keyof QueryEntry] != null) != null,
      );
      expect(hasAny, 'No query benchmark data with ≥2 entries to compare').toBe(true);
    });
  });

  describe('incremental benchmarks', () => {
    for (const engineKey of ['native', 'wasm'] as const) {
      const pair = findLatestPair(incrementalHistory, (e) => e[engineKey] != null);
      if (!pair) continue;

      const { latest, previous } = pair;
      const cur = latest[engineKey]!;
      const prev = previous[engineKey]!;

      test(`${engineKey} engine — ${latest.version} vs ${previous.version}`, () => {
        assertNoRegressions(
          [
            checkRegression(`Full build`, cur.fullBuildMs, prev.fullBuildMs),
            checkRegression(`No-op rebuild`, cur.noopRebuildMs, prev.noopRebuildMs),
            checkRegression(`1-file rebuild`, cur.oneFileRebuildMs, prev.oneFileRebuildMs),
          ],
          latest.version,
          previous.version,
          engineKey,
        );
      });
    }

    // Resolve benchmarks (not engine-specific). Keep `dev` in the candidate
    // pool so the per-PR gate (which produces a `dev` resolve entry) covers
    // import resolution; previously the filter dropped dev outright, leaving
    // nativeBatchMs / jsFallbackMs blind to PR-introduced regressions.
    const resolvePair = findLatestPair(
      incrementalHistory.filter((e) => e.resolve != null),
      (e) => e.resolve != null,
    );
    if (resolvePair) {
      const { latest: latestRes, previous: previousRes } = resolvePair;
      test(`import resolution — ${latestRes.version} vs ${previousRes.version}`, () => {
        const cur = latestRes.resolve!;
        const prev = previousRes.resolve!;
        assertNoRegressions(
          [
            checkRegression(`Native batch resolve`, cur.nativeBatchMs, prev.nativeBatchMs),
            checkRegression(`JS fallback resolve`, cur.jsFallbackMs, prev.jsFallbackMs),
          ],
          latestRes.version,
          previousRes.version,
        );
      });
    }

    test('has at least one engine to compare', () => {
      const hasAny = ['native', 'wasm'].some(
        (ek) =>
          findLatestPair(incrementalHistory, (e) => e[ek as keyof IncrementalEntry] != null) !=
          null,
      );
      expect(hasAny, 'No incremental benchmark data with ≥2 entries to compare').toBe(true);
    });

    test('has resolve data to compare', () => {
      expect(
        resolvePair != null,
        'No import-resolution benchmark data with ≥2 comparable entries',
      ).toBe(true);
    });
  });

  describe.skipIf(BENCH_CANARY)('resolution benchmarks', () => {
    /**
     * Resolution precision/recall regression thresholds.
     * These are percentage-point drops (not relative %) because resolution
     * metrics are bounded [0, 1] and small absolute drops matter.
     *
     * Precision >5pp drop and recall >10pp drop are flagged.
     * Recall has a wider threshold because it's more volatile — adding new
     * expected edges to fixtures can temporarily lower recall.
     *
     * SYNC: These must match PRECISION_DROP_THRESHOLD / RECALL_DROP_THRESHOLD
     * in scripts/update-benchmark-report.ts (the ::warning annotation side).
     */
    const PRECISION_DROP_PP = 0.05;
    const RECALL_DROP_PP = 0.1;

    interface ResolutionLang {
      precision: number;
      recall: number;
      truePositives: number;
      falsePositives: number;
      falseNegatives: number;
      totalResolved: number;
      totalExpected: number;
    }

    interface BuildEntryWithResolution extends BuildEntry {
      resolution?: Record<string, ResolutionLang>;
    }

    // buildHistory already parsed BUILD-BENCHMARKS.md with the same marker;
    // widen the type instead of re-reading the file.
    const fullHistory = buildHistory as BuildEntryWithResolution[];

    const resolutionPair = findLatestPair(fullHistory, (e) => e.resolution != null);

    if (resolutionPair) {
      const { latest: latestRes, previous: previousRes } = resolutionPair;

      test(`resolution — ${latestRes.version} vs ${previousRes.version}`, () => {
        const curRes = latestRes.resolution!;
        const prevRes = previousRes.resolution!;
        const regressions: string[] = [];

        for (const lang of Object.keys(curRes)) {
          const cur = curRes[lang];
          const prv = prevRes[lang];
          if (!cur || !prv) continue;

          // When latest is 'dev' (per-PR build), KNOWN_REGRESSIONS keys
          // are anchored to the baseline release where the regression was
          // first observed, not to 'dev' — fall back to previousRes.version.
          const isDev = latestRes.version === 'dev';

          const precDrop = prv.precision - cur.precision;
          if (precDrop > PRECISION_DROP_PP) {
            const key = `${latestRes.version}:resolution ${lang} precision`;
            const fallbackKey = `${previousRes.version}:resolution ${lang} precision`;
            const isKnown =
              KNOWN_REGRESSIONS.has(key) || (isDev && KNOWN_REGRESSIONS.has(fallbackKey));
            if (!isKnown) {
              regressions.push(
                `  ${lang} precision: ${(prv.precision * 100).toFixed(1)}% → ${(cur.precision * 100).toFixed(1)}% (−${(precDrop * 100).toFixed(1)}pp, threshold ${(PRECISION_DROP_PP * 100).toFixed(0)}pp)`,
              );
            }
          }

          const recDrop = prv.recall - cur.recall;
          if (recDrop > RECALL_DROP_PP) {
            const key = `${latestRes.version}:resolution ${lang} recall`;
            const fallbackKey = `${previousRes.version}:resolution ${lang} recall`;
            const isKnown =
              KNOWN_REGRESSIONS.has(key) || (isDev && KNOWN_REGRESSIONS.has(fallbackKey));
            if (!isKnown) {
              regressions.push(
                `  ${lang} recall: ${(prv.recall * 100).toFixed(1)}% → ${(cur.recall * 100).toFixed(1)}% (−${(recDrop * 100).toFixed(1)}pp, threshold ${(RECALL_DROP_PP * 100).toFixed(0)}pp)`,
              );
            }
          }
        }

        if (regressions.length > 0) {
          expect.fail(`Resolution precision/recall regressions:\n${regressions.join('\n')}`);
        }
      });
    }

    test('has resolution data to compare', () => {
      expect(
        resolutionPair != null,
        'No resolution benchmark data with ≥2 non-dev entries to compare',
      ).toBe(true);
    });
  });
});
