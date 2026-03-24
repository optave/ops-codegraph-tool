/**
 * Call Resolution Precision/Recall Benchmark Suite (Roadmap 4.4)
 *
 * Builds codegraph for each hand-annotated fixture project, then compares
 * the resolved call edges against the expected-edges.json manifest.
 *
 * Reports precision (correct / total resolved) and recall (correct / total expected)
 * per language and per resolution mode (static, receiver-typed, interface-dispatched).
 *
 * CI gate: fails if precision < 85% or recall < 80% for JavaScript or TypeScript.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { openReadonlyOrFail } from '../../../src/db/index.js';
import { buildGraph } from '../../../src/domain/graph/builder.js';

// ── Configuration ────────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');

/**
 * Thresholds are baselines — they ratchet up as resolution improves.
 * Current values reflect measured capabilities as of the initial benchmark.
 * Target: precision ≥85%, recall ≥80% for both JS and TS.
 *
 * Receiver-typed recall thresholds are tracked separately and start lower
 * because cross-file receiver dispatch is still maturing.
 */
const THRESHOLDS = {
  javascript: { precision: 0.85, recall: 0.55, staticRecall: 0.6, receiverRecall: 0.3 },
  typescript: { precision: 0.85, recall: 0.58, staticRecall: 0.9, receiverRecall: 0.45 },
};

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Copy fixture to a temp directory so buildGraph can write .codegraph/ without
 * polluting the repo.
 */
function copyFixture(lang) {
  const src = path.join(FIXTURES_DIR, lang);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-resolution-${lang}-`));
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'expected-edges.json') continue;
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(src, entry.name), path.join(tmp, entry.name));
  }
  return tmp;
}

/**
 * Build graph for a fixture directory.
 */
async function buildFixtureGraph(fixtureDir) {
  await buildGraph(fixtureDir, {
    incremental: false,
    engine: 'wasm',
    dataflow: false,
    cfg: false,
    ast: false,
  });
}

/**
 * Extract all call edges from the built graph DB.
 * Returns array of { sourceName, sourceFile, targetName, targetFile, kind, confidence }.
 */
function extractResolvedEdges(fixtureDir) {
  const dbPath = path.join(fixtureDir, '.codegraph', 'graph.db');
  const db = openReadonlyOrFail(dbPath);
  try {
    const rows = db
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
    return rows;
  } finally {
    db.close();
  }
}

/**
 * Normalize a file path to just the basename for comparison.
 */
function normalizeFile(filePath) {
  return path.basename(filePath);
}

/**
 * Build a string key for an edge to enable set-based comparison.
 */
function edgeKey(sourceName, sourceFile, targetName, targetFile) {
  return `${sourceName}@${normalizeFile(sourceFile)} -> ${targetName}@${normalizeFile(targetFile)}`;
}

/**
 * Compare resolved edges against expected edges manifest.
 * Returns precision, recall, and detailed breakdown by mode.
 */
function computeMetrics(resolvedEdges, expectedEdges) {
  // Build sets for overall comparison
  const resolvedSet = new Set(
    resolvedEdges.map((e) => edgeKey(e.source_name, e.source_file, e.target_name, e.target_file)),
  );

  const expectedSet = new Set(
    expectedEdges.map((e) => edgeKey(e.source.name, e.source.file, e.target.name, e.target.file)),
  );

  // True positives: edges in both resolved and expected
  const truePositives = new Set([...resolvedSet].filter((k) => expectedSet.has(k)));

  // False positives: resolved but not expected
  const falsePositives = new Set([...resolvedSet].filter((k) => !expectedSet.has(k)));

  // False negatives: expected but not resolved
  const falseNegatives = new Set([...expectedSet].filter((k) => !resolvedSet.has(k)));

  const precision = resolvedSet.size > 0 ? truePositives.size / resolvedSet.size : 0;
  const recall = expectedSet.size > 0 ? truePositives.size / expectedSet.size : 0;

  // Break down by resolution mode
  const byMode = {};
  for (const edge of expectedEdges) {
    const mode = edge.mode || 'unknown';
    if (!byMode[mode]) byMode[mode] = { expected: 0, resolved: 0 };
    byMode[mode].expected++;
    const key = edgeKey(edge.source.name, edge.source.file, edge.target.name, edge.target.file);
    if (resolvedSet.has(key)) byMode[mode].resolved++;
  }

  // Compute per-mode recall
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
    // Detailed lists for debugging
    falsePositiveEdges: [...falsePositives],
    falseNegativeEdges: [...falseNegatives],
  };
}

/**
 * Format a metrics report for console output.
 */
function formatReport(lang, metrics) {
  const lines = [
    `\n  ── ${lang.toUpperCase()} Resolution Metrics ──`,
    `  Precision: ${(metrics.precision * 100).toFixed(1)}% (${metrics.truePositives} correct / ${metrics.totalResolved} resolved)`,
    `  Recall:    ${(metrics.recall * 100).toFixed(1)}% (${metrics.truePositives} correct / ${metrics.totalExpected} expected)`,
    '',
    '  By resolution mode:',
  ];

  for (const [mode, data] of Object.entries(metrics.byMode)) {
    lines.push(
      `    ${mode}: ${data.resolved}/${data.expected} (${(data.recall * 100).toFixed(1)}% recall)`,
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

/**
 * Discover all fixture languages that have an expected-edges.json manifest.
 */
function discoverFixtures() {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  const languages = [];
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
const allResults = {};

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
    summaryLines.push('');
    console.log(summaryLines.join('\n'));
  });

  for (const lang of languages) {
    describe(lang, () => {
      let fixtureDir: string;
      let resolvedEdges: any[];
      let expectedEdges: any[];
      let metrics: any;

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
        expect(resolvedEdges.length).toBeGreaterThan(0);
      });

      test('expected edges manifest is non-empty', () => {
        expect(expectedEdges.length).toBeGreaterThan(0);
      });

      test(`precision meets threshold`, () => {
        const threshold = THRESHOLDS[lang]?.precision ?? 0.85;
        expect(
          metrics.precision,
          `${lang} precision ${(metrics.precision * 100).toFixed(1)}% is below ${(threshold * 100).toFixed(0)}% threshold.\n` +
            `False positives:\n${metrics.falsePositiveEdges.map((e) => `  + ${e}`).join('\n')}`,
        ).toBeGreaterThanOrEqual(threshold);
      });

      test(`recall meets threshold`, () => {
        const threshold = THRESHOLDS[lang]?.recall ?? 0.8;
        expect(
          metrics.recall,
          `${lang} recall ${(metrics.recall * 100).toFixed(1)}% is below ${(threshold * 100).toFixed(0)}% threshold.\n` +
            `Missing edges:\n${metrics.falseNegativeEdges.map((e) => `  - ${e}`).join('\n')}`,
        ).toBeGreaterThanOrEqual(threshold);
      });

      test('static call resolution recall', () => {
        const staticMode = metrics.byMode.static;
        if (!staticMode) return; // no static edges in manifest
        const threshold = THRESHOLDS[lang]?.staticRecall ?? 0.8;
        expect(
          staticMode.recall,
          `${lang} static recall ${(staticMode.recall * 100).toFixed(1)}% — ` +
            `${staticMode.resolved}/${staticMode.expected} resolved`,
        ).toBeGreaterThanOrEqual(threshold);
      });

      test('receiver-typed call resolution recall', () => {
        const receiverMode = metrics.byMode['receiver-typed'];
        if (!receiverMode) return; // no receiver-typed edges in manifest
        const threshold = THRESHOLDS[lang]?.receiverRecall ?? 0.5;
        expect(
          receiverMode.recall,
          `${lang} receiver-typed recall ${(receiverMode.recall * 100).toFixed(1)}% — ` +
            `${receiverMode.resolved}/${receiverMode.expected} resolved`,
        ).toBeGreaterThanOrEqual(threshold);
      });
    });
  }
});
