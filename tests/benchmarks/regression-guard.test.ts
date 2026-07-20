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
 * Short-latency timing metrics (no-op rebuild, 1-file rebuild, fnDeps depth 1)
 * that routinely jitter ±10–50ms from CI runner load, GC pauses, and OS
 * scheduling — translating to ±25–155%+ on sub-100ms baselines. The
 * MIN_ABSOLUTE_DELTA floor (10ms) filters trivial noise but cannot distinguish
 * a 10–14ms "real" jitter event from a regression on these specific metrics.
 *
 * Keeping the global threshold at 25% means a regression in the 100–500ms
 * range is still caught (e.g. 200ms→253ms = +26%, flagged), while the
 * high-jitter metrics in this set get the wider 50% allowance.
 *
 * In BENCH_CANARY mode this is overridden to 1.0 (100%) — the canary's
 * purpose is to catch gross regressions (+50%+), not short-latency jitter.
 */
const NOISY_METRIC_THRESHOLD = BENCH_CANARY ? 1.0 : 0.5;

/**
 * Metric labels treated as high-variance and given the NOISY_METRIC_THRESHOLD
 * tolerance instead of the default REGRESSION_THRESHOLD. Add a metric here
 * only when CI variance has been empirically shown to exceed 25% due to runner
 * jitter (±10–50ms absolute) that dominates the percentage on short-ish
 * sub-200ms baselines — document the evidence in the entry below.
 *
 * - `No-op rebuild`: native baselines across releases span 15–30ms
 *   (3.11.0: 15ms, 3.11.2: 19–25ms, 3.12.0: 23–30ms depending on suite).
 *   Shared-runner jitter of ±10ms routinely lands +60–109% on these numbers:
 *     - 3.11.0 baseline 18ms → 29ms (+61%) — run 26426483639
 *     - 3.11.2 baseline 25ms → 45ms (+80%) and 19ms → 37ms (+95%)
 *       — run 26792023287 (docs-only PR #1282, zero hot-path changes)
 *     - 3.12.0 baseline 30ms → 48ms (+60%) and 23ms → 48ms (+109%)
 *       — run 27457266151 (PR #1487 adds warmup runs, no-op path unchanged)
 *     - 3.12.0 baseline 23ms → 114ms (+396%) — run 27455727444 (canary,
 *       PR #1468 enclosing-caller fix; no-op exits before that code runs)
 *   MIN_ABSOLUTE_DELTA (10ms) filters truly trivial jitter (e.g. 15→19ms),
 *   but a runner under load can easily produce +20ms on a no-op, which is
 *   both above the floor and above the 25% threshold on a ~20ms baseline.
 *   The 50% tolerance absorbs this pattern while still blocking a genuine
 *   regression that adds real work to the no-op path (which would show up
 *   consistently across runs, not just on loaded runners).
 *
 * - `1-file rebuild`: native baselines span 64–115ms across 3.11.0–3.12.0.
 *   CI jitter of ±20–50ms translates to +25–155% on sub-100ms measurements:
 *     - 3.11.0 baseline 64ms → 109ms (+70%) — run 26706695868 (concurrent
 *       PRs on same runner measured 64→80ms (+25%), confirming runner noise)
 *     - 3.11.2 baseline 83ms → 212ms (+155%) — run 26793082961 (PR #1278
 *       TypeScript resolver PR; locally measures 86ms, within baseline noise)
 *     - 3.12.0 baseline 86ms → 131ms (+52%) — publish gate run (incremental
 *       suite's identical metric PASSED in the same run, confirming cold-start
 *       bias in the build suite rather than a structural regression)
 *   The 50% threshold catches a genuine regression that adds real work (e.g.
 *   an O(n) scan on every 1-file rebuild would consistently land +100ms+)
 *   while absorbing the runner-load spikes documented above. Tracked in #1440
 *   (add warmup runs to the build-benchmark 1-file tier to reduce this spread).
 *
 * - `No-op rebuild`: native baselines across releases span 15–30ms
 *   (3.11.0: 15ms, 3.11.2: 19–25ms, 3.12.0: 23–30ms depending on suite).
 *   Shared-runner jitter of ±10ms routinely lands +60–109% on these numbers:
 *     - 3.11.0 baseline 18ms → 29ms (+61%) — run 26426483639
 *     - 3.11.2 baseline 25ms → 45ms (+80%) and 19ms → 37ms (+95%)
 *       — run 26792023287 (docs-only PR #1282, zero hot-path changes)
 *     - 3.12.0 baseline 30ms → 48ms (+60%) and 23ms → 48ms (+109%)
 *       — run 27457266151 (PR #1487 adds warmup runs, no-op path unchanged)
 *     - 3.12.0 baseline 23ms → 114ms (+396%) — run 27455727444 (canary,
 *       PR #1468 enclosing-caller fix; no-op exits before that code runs)
 *   MIN_ABSOLUTE_DELTA (10ms) filters truly trivial jitter (e.g. 15→19ms),
 *   but a runner under load can easily produce +20ms on a no-op, which is
 *   both above the floor and above the 25% threshold on a ~20ms baseline.
 *   The 50% tolerance absorbs this pattern while still blocking a genuine
 *   regression that adds real work to the no-op path (which would show up
 *   consistently across runs, not just on loaded runners).
 *
 * - `1-file rebuild`: native baselines span 64–115ms across 3.11.0–3.12.0.
 *   CI jitter of ±20–50ms translates to +25–155% on sub-100ms measurements:
 *     - 3.11.0 baseline 64ms → 109ms (+70%) — run 26706695868 (concurrent
 *       PRs on same runner measured 64→80ms (+25%), confirming runner noise)
 *     - 3.11.2 baseline 83ms → 212ms (+155%) — run 26793082961 (PR #1278
 *       TypeScript resolver PR; locally measures 86ms, within baseline noise)
 *     - 3.12.0 baseline 86ms → 131ms (+52%) — publish gate run (incremental
 *       suite's identical metric PASSED in the same run, confirming cold-start
 *       bias in the build suite rather than a structural regression)
 *   The 50% threshold catches a genuine regression that adds real work (e.g.
 *   an O(n) scan on every 1-file rebuild would consistently land +100ms+)
 *   while absorbing the runner-load spikes documented above. Tracked in #1440
 *   (add warmup runs to the build-benchmark 1-file tier to reduce this spread).
 *
 * - `fnDeps depth 1`: native baseline 28.7ms (v3.9.6). The fn_deps Rust
 *   implementation, fnDepsData JS wrapper, and DB schema/indexes are all
 *   byte-for-byte unchanged since v3.9.6 (verified by `git log v3.9.6..HEAD`
 *   on crates/codegraph-core/src/read_queries.rs, src/domain/analysis/
 *   dependencies.ts, src/db/, crates/codegraph-core/src/db/connection.rs).
 *   CI consistently measures +40–60% on this sub-30ms metric while the
 *   absolute delta (~13ms) is at the noise floor for shared runners.
 *   Methodology already discards 3 warmup runs (#1077). Same pattern as
 *   No-op rebuild and 1-file rebuild — short-latency baseline amplified by
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
 * Any comparison whose baseline is that release gets the exemption via the
 * baseline-version fallback in assertNoRegressions (and the resolution
 * loop) — so a single `3.11.0:Foo` entry covers `3.11.0 vs 3.10.0`, every
 * subsequent `dev vs 3.11.0` per-PR comparison, AND the eventual `3.12.0 vs
 * 3.11.0` publish gate itself (the release that's supposed to fold the
 * drift into a fresh baseline) — until that release's own benchmark data
 * lands and the entry is pruned.
 *
 * Entries fire when `latest.version` matches the prefix directly, or when
 * `previous.version` (the baseline) matches via the baseline fallback —
 * regardless of whether `latest` is `dev` (per-PR gate) or a real version
 * (the publish gate for the next release). Once a version is no longer the
 * latest in committed history and no longer used as a baseline for any
 * comparison, its entries become dead weight and should be removed (last
 * pruned: 3.9.0/3.9.1/3.9.2/3.9.6/3.10.0/3.11.0/3.11.1/3.11.2; the 3.12.0 and
 * 3.13.0 entries — dataflow/no-op/full-build timing noise and the erlang 0%
 * drop — were pruned at the 3.15.0 release once the 3.15.0 benchmark
 * baseline landed in PR #1702, which folds those deltas into the baseline
 * so dev-vs-3.15.0 comparisons no longer flag them).
 *
 * NOTE: WASM *timing* noise no longer needs per-version entries here — it is
 * handled structurally by WASM_TIMING_THRESHOLD (see above); native keeps the
 * strict thresholds and is the canary for real algorithmic regressions.
 */
const KNOWN_REGRESSIONS = new Set<string>([
  // v3.15.0 was released 2026-06-21 and no stable release has landed since,
  // while 150+ PRs merged into main — including many new per-language
  // resolution-benchmark fixtures. The repo's own tracked source file count
  // (this is a self-benchmark: `root` in scripts/benchmark.ts is the repo
  // itself) grew from 629 files (3.15.0 baseline) to 1000+ files, a ~60%
  // increase. Full-build and 1-file-rebuild time both scale with file count
  // (the latter via the repo-wide change-detection scan), so every
  // dev-vs-3.15.0 comparison now measures a real, but growth-driven — not
  // algorithmic — increase that clears the 25%/50%/75% thresholds. This hit
  // every open PR regardless of content (chore/deps-only PRs included),
  // confirming it isn't PR-introduced. Tracked in #2081. Exemption clears
  // itself: prune both entries once the next stable release folds current
  // repo size into a fresh baseline (same pattern as the 3.12.0/3.13.0 prune
  // at 3.15.0 documented above).
  '3.15.0:Full build',
  '3.15.0:1-file rebuild',
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
 * Highest non-dev release version present in the committed benchmark history.
 *
 * KNOWN_REGRESSIONS staleness is measured against this — NOT against
 * package.json. An exemption only becomes dead weight once a *newer recorded
 * baseline* supersedes it. During the release window package.json is bumped
 * immediately, but the post-publish benchmark-recording PR lands later, so the
 * package version races ahead of the recorded baseline; anchoring staleness to
 * package.json then flags still-live exemptions as stale (issue #1703).
 *
 * `dev` entries (per-PR gate output) and SKIP_VERSIONS are ignored. Returns
 * null when no parseable release version is recorded in any history.
 */
function latestRecordedVersion(
  histories: ReadonlyArray<ReadonlyArray<{ version: string }>>,
): string | null {
  let bestVal = -1;
  let bestStr: string | null = null;
  for (const history of histories) {
    for (const entry of history) {
      if (!entry || entry.version === 'dev' || SKIP_VERSIONS.has(entry.version)) continue;
      const sv = parseSemver(entry.version);
      if (!sv) continue;
      const val = sv[0] * 1_000_000 + sv[1] * 1_000 + sv[2];
      if (val > bestVal) {
        bestVal = val;
        bestStr = entry.version;
      }
    }
  }
  return bestStr;
}

/**
 * KNOWN_REGRESSIONS entries whose pinned version is more than one minor
 * release behind `anchorVersion` (the latest recorded baseline). Returns a
 * human-readable description per stale entry; entries without a `version:`
 * prefix are ignored.
 */
function findStaleEntries(entries: Iterable<string>, anchorVersion: string): string[] {
  const stale: string[] = [];
  for (const entry of entries) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) continue;
    const entryVersion = entry.slice(0, colonIdx);
    const gap = minorGap(entryVersion, anchorVersion);
    if (gap > 1) {
      stale.push(
        `${entry} (version ${entryVersion} is ${gap} minor versions behind baseline ${anchorVersion})`,
      );
    }
  }
  return stale;
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
    // KNOWN_REGRESSIONS entries are anchored to the release where the
    // regression was first observed (e.g. '3.9.6:No-op rebuild'), not to
    // whatever `latest` happens to be. Fall back to the baseline version so
    // a regression introduced before release N stays exempt for every
    // comparison against N — both per-PR gates (latest = 'dev') and the
    // actual release N+1 publish gate itself (latest = the real N+1 version,
    // e.g. '3.16.0') — until release N+1's own benchmark data lands as the
    // new baseline and the entry goes stale (see the "KNOWN_REGRESSIONS
    // entries are not stale" test below).
    //
    // This used to be gated on `version === 'dev'`, which meant the one run
    // that most needs the exemption — the publish gate for the release that
    // is supposed to fold the known drift into a fresh baseline — never got
    // it, and failed on the exact regression it was meant to be exempt from
    // (v3.16.0 publish, #2127; entries added by #2107 for exactly this).
    if (baselineVersion && KNOWN_REGRESSIONS.has(`${baselineVersion}:${c.label}`)) {
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

// Pure-logic tests for the KNOWN_REGRESSIONS baseline fallback. Unlike the
// describe.runIf(RUN_REGRESSION_GUARD) suite below, these don't read real
// benchmark report files — they exercise assertNoRegressions directly, so
// they always run and don't need a recorded 'X.Y.Z vs baseline' pair to exist
// in committed history.
describe('assertNoRegressions — KNOWN_REGRESSIONS baseline fallback', () => {
  test('exempts a real-release latest (not just dev) when its baseline matches a KNOWN_REGRESSIONS entry', () => {
    // Reproduces the v3.16.0 publish-gate failure (#2127): KNOWN_REGRESSIONS
    // has '3.15.0:Full build' (added by #2107 for repo-growth drift), but the
    // publish gate labels `latest.version` with the real new version being
    // published, never 'dev' — this must still hit the baseline fallback.
    expect(() =>
      assertNoRegressions(
        [checkRegression('Full build', 5000, 3521)], // +42%, over the 25% threshold
        '3.16.0',
        '3.15.0',
        'native',
      ),
    ).not.toThrow();
  });

  test('still exempts the per-PR dev-vs-baseline comparison', () => {
    expect(() =>
      assertNoRegressions([checkRegression('Full build', 5000, 3521)], 'dev', '3.15.0', 'native'),
    ).not.toThrow();
  });

  test('does not exempt a regression against a baseline with no matching KNOWN_REGRESSIONS entry', () => {
    // This describe block runs unconditionally — including under
    // BENCH_CANARY=1 (.github/workflows/perf-canary.yml), which widens
    // REGRESSION_THRESHOLD from 0.25 to 0.5. The delta here must clear the
    // regression threshold in *every* mode this test can run under, or the
    // check gets filtered out as "not a regression" before the
    // KNOWN_REGRESSIONS fallback is even reached — making the test flip-flop
    // based on an ambient env var instead of the exemption logic it's meant
    // to exercise. +100% clears both the 25% default and the 50% canary
    // threshold with margin.
    expect(() =>
      assertNoRegressions(
        [checkRegression('Full build', 8000, 4000)],
        '3.16.0',
        '3.14.0', // not a KNOWN_REGRESSIONS-covered baseline
        'native',
      ),
    ).toThrow(/Full build/);
  });
});

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
  // behind the latest *recorded benchmark baseline*). Anchoring to the recorded
  // baseline rather than package.json keeps still-live exemptions from being
  // flagged during the release window, when package.json is bumped before the
  // post-publish benchmark-recording PR lands (issue #1703). This makes the
  // stale-exemption problem self-detecting rather than requiring manual
  // bookkeeping. Skipped in canary mode — this check is maintenance-only and
  // irrelevant for a lightweight build-time regression gate.
  test.skipIf(BENCH_CANARY)('KNOWN_REGRESSIONS entries are not stale', () => {
    const baselineVersion = latestRecordedVersion([buildHistory, queryHistory, incrementalHistory]);
    if (!baselineVersion) {
      // No recorded benchmark history (missing/malformed report files). The
      // 'has at least one engine to compare' tests cover that failure mode;
      // staleness is undefined without a baseline, so there is nothing to prune.
      return;
    }
    const stale = findStaleEntries(KNOWN_REGRESSIONS, baselineVersion);
    if (stale.length > 0) {
      console.warn(
        `[regression-guard] Stale KNOWN_REGRESSIONS entries — remove after verifying corrected data:\n  ${stale.join('\n  ')}`,
      );
    }
    expect(
      stale.length,
      `KNOWN_REGRESSIONS has ${stale.length} stale entries (>1 minor version behind the ` +
        `latest recorded benchmark baseline ${baselineVersion}). ` +
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

// Pure-logic unit tests for the KNOWN_REGRESSIONS staleness anchor (issue
// #1703). These run unconditionally (not gated behind RUN_REGRESSION_GUARD)
// because they exercise the anchoring functions with synthetic data and do not
// depend on the committed benchmark history.
describe('KNOWN_REGRESSIONS staleness anchor (#1703)', () => {
  describe('latestRecordedVersion', () => {
    test('returns the highest release across all histories', () => {
      expect(
        latestRecordedVersion([
          [{ version: '3.13.0' }, { version: '3.12.0' }],
          [{ version: '3.15.0' }, { version: '3.14.0' }],
        ]),
      ).toBe('3.15.0');
    });

    test('ignores the rolling `dev` entry', () => {
      expect(latestRecordedVersion([[{ version: 'dev' }, { version: '3.15.0' }]])).toBe('3.15.0');
    });

    test('ignores SKIP_VERSIONS entries', () => {
      // 3.8.0 is in SKIP_VERSIONS, so 3.7.0 wins even though 3.8.0 sorts higher.
      expect(latestRecordedVersion([[{ version: '3.8.0' }, { version: '3.7.0' }]])).toBe('3.7.0');
    });

    test('compares by full semver, not lexical order', () => {
      expect(latestRecordedVersion([[{ version: '3.9.0' }, { version: '3.10.0' }]])).toBe('3.10.0');
    });

    test('returns null when no parseable release version exists', () => {
      expect(latestRecordedVersion([[], [{ version: 'dev' }]])).toBeNull();
    });
  });

  describe('findStaleEntries', () => {
    test('flags entries more than one minor behind the baseline', () => {
      const stale = findStaleEntries(
        ['3.15.0:Full build', '3.14.0:Full build', '3.13.0:Full build', '3.12.0:Full build'],
        '3.15.0',
      );
      // gap 0 and gap 1 are kept; gap 2 and gap 3 are stale.
      expect(stale.map((s) => s.split(':')[0])).toEqual(['3.13.0', '3.12.0']);
    });

    test('ignores entries without a version prefix', () => {
      expect(findStaleEntries(['no-colon-entry'], '3.15.0')).toEqual([]);
    });

    test('keeps an entry pinned to the current baseline live (the #1703 case)', () => {
      // The exact failure shape: a 3.13.0 exemption is the live baseline. While
      // package.json had jumped to 3.15.0, anchoring to the recorded baseline
      // (3.13.0) keeps it live; anchoring to package.json wrongly flagged it.
      expect(findStaleEntries(['3.13.0:No-op rebuild'], '3.13.0')).toEqual([]);
      expect(findStaleEntries(['3.13.0:No-op rebuild'], '3.15.0')).toHaveLength(1);
    });
  });
});
