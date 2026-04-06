/**
 * Call Resolution Precision/Recall Benchmark Suite (Roadmap 4.4)
 *
 * Builds codegraph for each hand-annotated fixture project, then compares
 * the resolved call edges against the expected-edges.json manifest.
 *
 * Reports precision (correct / total resolved) and recall (correct / total expected)
 * per language and per resolution mode.
 *
 * CI gate: fails if precision or recall drops below per-language thresholds.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { openReadonlyOrFail } from '../../../src/db/index.js';
import { buildGraph } from '../../../src/domain/graph/builder.js';

// ── Types ─────────────────────────────────────────────────────────────────

interface ResolvedEdge {
  source_name: string;
  source_file: string;
  target_name: string;
  target_file: string;
  kind: string;
  confidence: number;
}

interface ExpectedEdge {
  source: { name: string; file: string };
  target: { name: string; file: string };
  mode?: string;
}

interface ModeMetrics {
  expected: number;
  resolved: number;
  recall?: number;
}

interface BenchmarkMetrics {
  precision: number;
  recall: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  totalResolved: number;
  totalExpected: number;
  byMode: Record<string, ModeMetrics>;
  falsePositiveEdges: string[];
  falseNegativeEdges: string[];
}

// ── Configuration ────────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');

/**
 * Per-language thresholds. Thresholds ratchet up as resolution improves.
 *
 * Languages with mature resolution (JS/TS) have higher bars.
 * Newer languages start with lower thresholds to avoid blocking CI
 * while still tracking regressions.
 */
const THRESHOLDS: Record<string, { precision: number; recall: number }> = {
  // Mature — high bars (100% precision, high recall)
  javascript: { precision: 0.85, recall: 0.5 },
  typescript: { precision: 0.85, recall: 0.5 },
  tsx: { precision: 0.85, recall: 0.8 },
  bash: { precision: 0.85, recall: 0.8 },
  ruby: { precision: 0.85, recall: 0.8 },
  c: { precision: 0.6, recall: 0.2 },
  // Established — medium bars
  python: { precision: 0.7, recall: 0.3 },
  go: { precision: 0.7, recall: 0.3 },
  java: { precision: 0.7, recall: 0.3 },
  csharp: { precision: 0.5, recall: 0.2 },
  kotlin: { precision: 0.6, recall: 0.2 },
  // Lower bars — resolution still maturing
  rust: { precision: 0.6, recall: 0.2 },
  cpp: { precision: 0.6, recall: 0.2 },
  swift: { precision: 0.5, recall: 0.15 },
  // TODO(#872): raise haskell thresholds once call resolution lands
  haskell: { precision: 0.0, recall: 0.0 },
  // TODO(#873): raise lua thresholds once call resolution lands
  lua: { precision: 0.0, recall: 0.0 },
  // TODO(#874): raise ocaml thresholds once call resolution lands
  ocaml: { precision: 0.0, recall: 0.0 },
  // Minimal — call resolution not yet implemented or grammar unavailable
  // TODO(#875): raise scala thresholds once call resolution lands
  scala: { precision: 0.0, recall: 0.0 },
  php: { precision: 0.6, recall: 0.2 },
  // TODO: raise thresholds below once call resolution is implemented for each language
  elixir: { precision: 0.0, recall: 0.0 },
  dart: { precision: 0.0, recall: 0.0 },
  zig: { precision: 0.0, recall: 0.0 },
  fsharp: { precision: 0.0, recall: 0.0 },
  gleam: { precision: 0.0, recall: 0.0 },
  clojure: { precision: 0.0, recall: 0.0 },
  julia: { precision: 0.0, recall: 0.0 },
  r: { precision: 0.0, recall: 0.0 },
  erlang: { precision: 0.0, recall: 0.0 },
  solidity: { precision: 0.0, recall: 0.0 },
};

/** Default thresholds for languages not explicitly listed. */
const DEFAULT_THRESHOLD = { precision: 0.5, recall: 0.15 };

// Files to skip when copying fixtures (not source code for codegraph)
const SKIP_FILES = new Set(['expected-edges.json', 'driver.mjs']);

// ── Helpers ──────────────────────────────────────────────────────────────

function copyFixture(lang: string): string {
  const src = path.join(FIXTURES_DIR, lang);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-resolution-${lang}-`));
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_FILES.has(entry.name)) continue;
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(src, entry.name), path.join(tmp, entry.name));
  }
  return tmp;
}

function buildFixtureGraph(fixtureDir: string): Promise<void> {
  return buildGraph(fixtureDir, {
    incremental: false,
    engine: 'wasm',
    dataflow: false,
    cfg: false,
    ast: false,
  });
}

function extractResolvedEdges(fixtureDir: string) {
  const dbPath = path.join(fixtureDir, '.codegraph', 'graph.db');
  const db = openReadonlyOrFail(dbPath);
  try {
    return db
      .prepare(`
      SELECT
        src.name  AS source_name,
        src.file  AS source_file,
        tgt.name  AS target_name,
        tgt.file  AS target_file,
        e.kind    AS kind,
        e.confidence AS confidence
      FROM edges e
      JOIN nodes src ON e.source_id = src.id
      JOIN nodes tgt ON e.target_id = tgt.id
      WHERE e.kind = 'calls'
        AND src.kind IN ('function', 'method')
    `)
      .all();
  } finally {
    db.close();
  }
}

function normalizeFile(filePath: string): string {
  return path.basename(filePath);
}

function edgeKey(
  sourceName: string,
  sourceFile: string,
  targetName: string,
  targetFile: string,
): string {
  return `${sourceName}@${normalizeFile(sourceFile)} -> ${targetName}@${normalizeFile(targetFile)}`;
}

function computeMetrics(
  resolvedEdges: ResolvedEdge[],
  expectedEdges: ExpectedEdge[],
): BenchmarkMetrics {
  const resolvedSet = new Set(
    resolvedEdges.map((e) => edgeKey(e.source_name, e.source_file, e.target_name, e.target_file)),
  );

  const expectedSet = new Set(
    expectedEdges.map((e) => edgeKey(e.source.name, e.source.file, e.target.name, e.target.file)),
  );

  const truePositives = new Set([...resolvedSet].filter((k) => expectedSet.has(k)));
  const falsePositives = new Set([...resolvedSet].filter((k) => !expectedSet.has(k)));
  const falseNegatives = new Set([...expectedSet].filter((k) => !resolvedSet.has(k)));

  const precision = resolvedSet.size > 0 ? truePositives.size / resolvedSet.size : 0;
  const recall = expectedSet.size > 0 ? truePositives.size / expectedSet.size : 0;

  const byMode: Record<string, ModeMetrics> = {};
  for (const edge of expectedEdges) {
    const mode = edge.mode || 'unknown';
    if (!byMode[mode]) byMode[mode] = { expected: 0, resolved: 0 };
    byMode[mode].expected++;
    const key = edgeKey(edge.source.name, edge.source.file, edge.target.name, edge.target.file);
    if (resolvedSet.has(key)) byMode[mode].resolved++;
  }

  for (const mode of Object.keys(byMode)) {
    const m = byMode[mode];
    m.recall = m.expected > 0 ? m.resolved / m.expected : 0;
  }

  return {
    precision,
    recall,
    truePositives: truePositives.size,
    falsePositives: falsePositives.size,
    falseNegatives: falseNegatives.size,
    totalResolved: resolvedSet.size,
    totalExpected: expectedSet.size,
    byMode,
    falsePositiveEdges: [...falsePositives],
    falseNegativeEdges: [...falseNegatives],
  };
}

function formatReport(lang: string, metrics: BenchmarkMetrics): string {
  const lines = [
    `\n  ── ${lang.toUpperCase()} Resolution Metrics ──`,
    `  Precision: ${(metrics.precision * 100).toFixed(1)}% (${metrics.truePositives} correct / ${metrics.totalResolved} resolved)`,
    `  Recall:    ${(metrics.recall * 100).toFixed(1)}% (${metrics.truePositives} correct / ${metrics.totalExpected} expected)`,
    '',
    '  By resolution mode:',
  ];

  for (const [mode, data] of Object.entries(metrics.byMode)) {
    lines.push(
      `    ${mode}: ${data.resolved}/${data.expected} (${((data.recall ?? 0) * 100).toFixed(1)}% recall)`,
    );
  }

  if (metrics.falseNegativeEdges.length > 0) {
    lines.push('', '  Missing edges (false negatives):');
    for (const e of metrics.falseNegativeEdges) {
      lines.push(`    - ${e}`);
    }
  }

  if (metrics.falsePositiveEdges.length > 0) {
    lines.push('', '  Unexpected edges (false positives):');
    for (const e of metrics.falsePositiveEdges.slice(0, 10)) {
      lines.push(`    + ${e}`);
    }
    if (metrics.falsePositiveEdges.length > 10) {
      lines.push(`    ... and ${metrics.falsePositiveEdges.length - 10} more`);
    }
  }

  return lines.join('\n');
}

// ── Tests ────────────────────────────────────────────────────────────────

function discoverFixtures(): string[] {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  const languages: string[] = [];
  for (const dir of fs.readdirSync(FIXTURES_DIR)) {
    const manifestPath = path.join(FIXTURES_DIR, dir, 'expected-edges.json');
    if (fs.existsSync(manifestPath)) {
      languages.push(dir);
    }
  }
  return languages;
}

const languages = discoverFixtures();

/** Stores all results for the final summary */
const allResults: Record<string, BenchmarkMetrics> = {};

describe('Call Resolution Precision/Recall', () => {
  afterAll(() => {
    // Print combined summary
    const summaryLines = [
      '\n╔══════════════════════════════════════════╗',
      '║  Resolution Benchmark Summary            ║',
      '╚══════════════════════════════════════════╝',
    ];
    for (const [lang, metrics] of Object.entries(allResults)) {
      summaryLines.push(formatReport(lang, metrics));
    }

    // Print a compact table for quick scanning
    summaryLines.push('\n  ── Summary Table ──');
    summaryLines.push('  Language     | Precision | Recall  | TP  | FP  | FN');
    summaryLines.push('  ------------|-----------|---------|-----|-----|----');
    for (const [lang, m] of Object.entries(allResults)) {
      summaryLines.push(
        `  ${lang.padEnd(12)} | ${(m.precision * 100).toFixed(1).padStart(7)}%  | ${(m.recall * 100).toFixed(1).padStart(5)}%  | ${String(m.truePositives).padStart(3)} | ${String(m.falsePositives).padStart(3)} | ${String(m.falseNegatives).padStart(3)}`,
      );
    }

    summaryLines.push('');
    console.log(summaryLines.join('\n'));
  });

  for (const lang of languages) {
    describe(lang, () => {
      let fixtureDir: string;
      let resolvedEdges: ResolvedEdge[];
      let expectedEdges: ExpectedEdge[];
      let metrics: BenchmarkMetrics;

      beforeAll(async () => {
        fixtureDir = copyFixture(lang);
        await buildFixtureGraph(fixtureDir);

        resolvedEdges = extractResolvedEdges(fixtureDir);

        const manifestPath = path.join(FIXTURES_DIR, lang, 'expected-edges.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        expectedEdges = manifest.edges;

        metrics = computeMetrics(resolvedEdges, expectedEdges);
        allResults[lang] = metrics;
      }, 60_000);

      afterAll(() => {
        if (fixtureDir) {
          fs.rmSync(fixtureDir, { recursive: true, force: true });
        }
      });

      test('builds graph successfully', () => {
        expect(resolvedEdges).toBeDefined();
        expect(Array.isArray(resolvedEdges)).toBe(true);
        // Some languages may have 0 resolved call edges if resolution isn't
        // implemented yet — that's okay, the precision/recall tests will
        // catch it at the appropriate threshold level.
      });

      test('expected edges manifest is non-empty', () => {
        expect(expectedEdges.length).toBeGreaterThan(0);
      });

      test('precision meets threshold', () => {
        const threshold = THRESHOLDS[lang]?.precision ?? DEFAULT_THRESHOLD.precision;
        expect(
          metrics.precision,
          `${lang} precision ${(metrics.precision * 100).toFixed(1)}% is below ${(threshold * 100).toFixed(0)}% threshold.\n` +
            `False positives:\n${metrics.falsePositiveEdges.map((e) => `  + ${e}`).join('\n')}`,
        ).toBeGreaterThanOrEqual(threshold);
      });

      test('recall meets threshold', () => {
        const threshold = THRESHOLDS[lang]?.recall ?? DEFAULT_THRESHOLD.recall;
        expect(
          metrics.recall,
          `${lang} recall ${(metrics.recall * 100).toFixed(1)}% is below ${(threshold * 100).toFixed(0)}% threshold.\n` +
            `Missing edges:\n${metrics.falseNegativeEdges.map((e) => `  - ${e}`).join('\n')}`,
        ).toBeGreaterThanOrEqual(threshold);
      });

      // Per-mode recall tests — run for every mode present in the manifest
      test('per-mode recall breakdown', () => {
        for (const [mode, data] of Object.entries(metrics.byMode)) {
          const modeRecall = data.recall ?? 0;
          // Log per-mode results for visibility (not a hard gate)
          console.log(
            `    [${lang}] ${mode}: ${data.resolved}/${data.expected} (${(modeRecall * 100).toFixed(1)}% recall)`,
          );
        }
        // At least verify that some mode data exists
        expect(Object.keys(metrics.byMode).length).toBeGreaterThan(0);
      });
    });
  }
});
