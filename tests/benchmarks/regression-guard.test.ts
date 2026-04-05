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
 *
 * - 3.9.0:1-file rebuild — native incremental path re-runs graph-wide phases
 *   (structureMs, AST, CFG, dataflow) on single-file rebuilds. Documented in
 *   BUILD-BENCHMARKS.md Notes section with phase-level breakdown.
 */
const KNOWN_REGRESSIONS = new Set(['3.9.0:1-file rebuild']);

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
 * Find the latest entry for a given engine, then the next non-dev
 * entry with data for that engine (the "previous release").
 */
function findLatestPair<T extends { version: string }>(
  history: T[],
  hasEngine: (entry: T) => boolean,
): { latest: T; previous: T } | null {
  // Find the latest entry, skipping versions with unreliable data
  let latestIdx = -1;
  for (let i = 0; i < history.length; i++) {
    if (SKIP_VERSIONS.has(history[i].version)) continue;
    if (hasEngine(history[i])) {
      latestIdx = i;
      break;
    }
  }
  if (latestIdx < 0) return null;

  const latestVersion = history[latestIdx].version;

  // Find previous non-dev entry with data for this engine, skipping
  // versions with known unreliable benchmark data and versions that
  // are too far apart for meaningful comparison.
  for (let i = latestIdx + 1; i < history.length; i++) {
    const entry = history[i];
    if (entry.version === 'dev') continue;
    if (SKIP_VERSIONS.has(entry.version)) continue;
    if (!hasEngine(entry)) continue;
    if (minorGap(latestVersion, entry.version) > MAX_VERSION_GAP) continue;
    return { latest: history[latestIdx], previous: entry };
  }
  return null; // No suitable baseline to compare against
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
});
