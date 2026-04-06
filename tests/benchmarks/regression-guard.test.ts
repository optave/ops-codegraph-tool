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
 * Maximum allowed regression (as a fraction, e.g. 0.25 = 25%).
 *
 * Why 25%: The report script warns at 15%, but timing benchmarks have
 * natural variance from CI runner load, GC pauses, etc.  25% filters
 * noise while still catching the catastrophic regressions we've seen
 * historically (100%–220%).  Tune this down as benchmarks stabilize.
 */
const REGRESSION_THRESHOLD = 0.25;

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
 * - 3.9.0:1-file rebuild — native incremental path re-runs graph-wide phases
 *   (structureMs, AST, CFG, dataflow) on single-file rebuilds. Documented in
 *   BUILD-BENCHMARKS.md Notes section with phase-level breakdown.
 *
 * - 3.9.0:fnDeps depth {1,3,5} — openRepo() always routed queries through the
 *   native NAPI path regardless of engine selection, so both "wasm" and "native"
 *   benchmark workers measured native rusqlite open/close overhead (~27ms vs
 *   ~10ms with direct better-sqlite3). Fixed by wiring CODEGRAPH_ENGINE through
 *   openRepo(); v3.10.0 benchmarks will reflect the corrected measurements.
 *
 * - 3.9.1:1-file rebuild — continuation of the 3.9.0 regression; native
 *   incremental path still re-runs graph-wide phases on single-file rebuilds.
 *   Benchmark data shows 562 → 767ms (+36%). Same root cause as 3.9.0 entry.
 */
const KNOWN_REGRESSIONS = new Set([
  '3.9.0:1-file rebuild',
  '3.9.0:fnDeps depth 1',
  '3.9.0:fnDeps depth 3',
  '3.9.0:fnDeps depth 5',
  '3.9.1:1-file rebuild',
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
      if (effectiveGap(latestVersion, entry.version) > MAX_VERSION_GAP) continue;
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

function assertNoRegressions(checks: (RegressionCheck | null)[], version?: string) {
  const real = checks.filter(Boolean) as RegressionCheck[];
  const regressions = real.filter((c) => {
    if (c.pctChange <= REGRESSION_THRESHOLD) return false;
    if (version && KNOWN_REGRESSIONS.has(`${version}:${c.label}`)) return false;
    return true;
  });

  if (regressions.length > 0) {
    const details = regressions
      .map(
        (r) =>
          `  ${r.label}: ${r.previous} → ${r.current} (+${Math.round(r.pctChange * 100)}%, threshold ${Math.round(REGRESSION_THRESHOLD * 100)}%)`,
      )
      .join('\n');
    expect.fail(
      `Benchmark regressions exceed ${Math.round(REGRESSION_THRESHOLD * 100)}% threshold:\n${details}`,
    );
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

describe('Benchmark regression guard', () => {
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
  test('KNOWN_REGRESSIONS entries are not stale', () => {
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

  // Validate newest-first ordering assumption for all history arrays
  test('build history is sorted newest-first', () => {
    assertNewestFirst(buildHistory, 'Build benchmark');
  });
  test('query history is sorted newest-first', () => {
    assertNewestFirst(queryHistory, 'Query benchmark');
  });
  test('incremental history is sorted newest-first', () => {
    assertNewestFirst(incrementalHistory, 'Incremental benchmark');
  });

  describe('build benchmarks', () => {
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

  describe('query benchmarks', () => {
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
        );
      });
    }

    // Resolve benchmarks (not engine-specific)
    const resolveEntries = incrementalHistory.filter(
      (e) => e.resolve != null && e.version !== 'dev' && !SKIP_VERSIONS.has(e.version),
    );
    if (resolveEntries.length >= 2) {
      test(`import resolution — ${resolveEntries[0].version} vs ${resolveEntries[1].version}`, () => {
        const cur = resolveEntries[0].resolve!;
        const prev = resolveEntries[1].resolve!;
        assertNoRegressions([
          checkRegression(`Native batch resolve`, cur.nativeBatchMs, prev.nativeBatchMs),
          checkRegression(`JS fallback resolve`, cur.jsFallbackMs, prev.jsFallbackMs),
        ]);
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
        resolveEntries.length >= 2,
        'No import-resolution benchmark data with ≥2 non-dev entries to compare',
      ).toBe(true);
    });
  });

  describe('resolution benchmarks', () => {
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

          const precDrop = prv.precision - cur.precision;
          if (precDrop > PRECISION_DROP_PP) {
            const key = `${latestRes.version}:resolution ${lang} precision`;
            if (!KNOWN_REGRESSIONS.has(key)) {
              regressions.push(
                `  ${lang} precision: ${(prv.precision * 100).toFixed(1)}% → ${(cur.precision * 100).toFixed(1)}% (−${(precDrop * 100).toFixed(1)}pp, threshold ${(PRECISION_DROP_PP * 100).toFixed(0)}pp)`,
              );
            }
          }

          const recDrop = prv.recall - cur.recall;
          if (recDrop > RECALL_DROP_PP) {
            const key = `${latestRes.version}:resolution ${lang} recall`;
            if (!KNOWN_REGRESSIONS.has(key)) {
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
