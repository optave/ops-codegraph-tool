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
 * Minimum "previous" version for regression comparisons.
 *
 * The guard was introduced after v3.8.1 shipped, so historical data
 * contains pre-existing regressions (v3.8.0 build outlier, v3.8.1 query
 * regression vs v3.7.0) that predate the guard.  Setting a baseline
 * version ensures we only flag regressions in NEW entries — i.e. when
 * a future release regresses vs v3.8.1+.
 *
 * Bump this when a known regression ships intentionally (e.g. trading
 * query speed for correctness) so the guard watches for regressions
 * from the new accepted baseline, not from a stale one.
 */
const BASELINE_VERSION = '3.8.1';

// ── Helpers ──────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..', '..');
const BENCHMARKS_DIR = path.join(ROOT, 'generated', 'benchmarks');

/** True when `a` >= `b` by semver (major.minor.patch). */
function semverGte(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return true; // equal
}

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
 * Find the latest entry for a given engine, then the next non-dev
 * entry with data for that engine (the "previous release").
 *
 * Returns null when either side is missing, or when the previous
 * entry's version is below BASELINE_VERSION (pre-existing regression
 * that predates the guard).
 */
function findLatestPair<T extends { version: string }>(
  history: T[],
  hasEngine: (entry: T) => boolean,
): { latest: T; previous: T } | null {
  let latestIdx = -1;
  for (let i = 0; i < history.length; i++) {
    if (hasEngine(history[i])) {
      latestIdx = i;
      break;
    }
  }
  if (latestIdx < 0) return null;

  // Find previous non-dev entry with data for this engine
  for (let i = latestIdx + 1; i < history.length; i++) {
    if (history[i].version !== 'dev' && hasEngine(history[i])) {
      // Skip comparisons where the previous entry predates the baseline —
      // those regressions were already shipped before the guard existed.
      if (!semverGte(history[i].version, BASELINE_VERSION)) return null;
      return { latest: history[latestIdx], previous: history[i] };
    }
  }
  return null; // No previous release to compare against
}

/**
 * Check whether at least 2 non-dev entries exist for any engine
 * (ignoring baseline — used by sentinel tests to verify data exists).
 */
function hasRawPair<T extends { version: string }>(
  history: T[],
  hasEngine: (entry: T) => boolean,
): boolean {
  let count = 0;
  for (const e of history) {
    if (e.version !== 'dev' && hasEngine(e)) {
      count++;
      if (count >= 2) return true;
    }
  }
  return false;
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
  const pctChange = (current - previous) / previous;
  return { label, current, previous, pctChange };
}

function assertNoRegressions(checks: (RegressionCheck | null)[]) {
  const real = checks.filter(Boolean) as RegressionCheck[];
  const regressions = real.filter((c) => c.pctChange > REGRESSION_THRESHOLD);

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
        assertNoRegressions([
          checkRegression(`Build ms/file`, cur.perFile.buildTimeMs, prev.perFile.buildTimeMs),
          checkRegression(`Query time`, cur.queryTimeMs, prev.queryTimeMs),
          checkRegression(`DB bytes/file`, cur.perFile.dbSizeBytes, prev.perFile.dbSizeBytes),
          checkRegression(`No-op rebuild`, cur.noopRebuildMs, prev.noopRebuildMs),
          checkRegression(`1-file rebuild`, cur.oneFileRebuildMs, prev.oneFileRebuildMs),
        ]);
      });
    }

    test('has at least one engine with data', () => {
      const hasAny = ['native', 'wasm'].some((ek) =>
        hasRawPair(buildHistory, (e) => e[ek as keyof BuildEntry] != null),
      );
      expect(hasAny, 'No build benchmark data with ≥2 entries').toBe(true);
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
        assertNoRegressions([
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
        ]);
      });
    }

    test('has at least one engine with data', () => {
      const hasAny = ['native', 'wasm'].some((ek) =>
        hasRawPair(queryHistory, (e) => e[ek as keyof QueryEntry] != null),
      );
      expect(hasAny, 'No query benchmark data with ≥2 entries').toBe(true);
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
        assertNoRegressions([
          checkRegression(`Full build`, cur.fullBuildMs, prev.fullBuildMs),
          checkRegression(`No-op rebuild`, cur.noopRebuildMs, prev.noopRebuildMs),
          checkRegression(`1-file rebuild`, cur.oneFileRebuildMs, prev.oneFileRebuildMs),
        ]);
      });
    }

    // Resolve benchmarks (not engine-specific)
    const resolveEntries = incrementalHistory.filter(
      (e) => e.resolve != null && e.version !== 'dev',
    );
    const resolveHasBaselinePair =
      resolveEntries.length >= 2 && semverGte(resolveEntries[1].version, BASELINE_VERSION);
    if (resolveHasBaselinePair) {
      test(`import resolution — ${resolveEntries[0].version} vs ${resolveEntries[1].version}`, () => {
        const cur = resolveEntries[0].resolve!;
        const prev = resolveEntries[1].resolve!;
        assertNoRegressions([
          checkRegression(`Native batch resolve`, cur.nativeBatchMs, prev.nativeBatchMs),
          checkRegression(`JS fallback resolve`, cur.jsFallbackMs, prev.jsFallbackMs),
        ]);
      });
    }

    test('has at least one engine with data', () => {
      const hasAny = ['native', 'wasm'].some((ek) =>
        hasRawPair(incrementalHistory, (e) => e[ek as keyof IncrementalEntry] != null),
      );
      expect(hasAny, 'No incremental benchmark data with ≥2 entries').toBe(true);
    });

    test('has resolve data to compare', () => {
      // At least 2 non-dev entries exist (even if the pair doesn't meet the baseline)
      expect(
        resolveEntries.length >= 2,
        'No import-resolution benchmark data with ≥2 non-dev entries to compare',
      ).toBe(true);
    });
  });
});
