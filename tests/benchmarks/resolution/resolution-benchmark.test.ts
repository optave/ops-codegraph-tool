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
 *
 * **Artifact mode (CI):** when `RESOLUTION_RESULT_JSON` points at a result
 * file produced by `scripts/resolution-benchmark.ts`, the suite reads those
 * pre-computed metrics and skips the fixture rebuild — avoiding the duplicate
 * work that doubled pre-publish CI time (issue #1052). Local runs without
 * the env var fall back to the build-from-fixtures path.
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

interface TechniqueMetrics {
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
  byTechnique: Record<string, TechniqueMetrics>;
  falsePositiveEdges: string[];
  falseNegativeEdges: string[];
}

/**
 * Maps resolution modes from expected-edges.json to high-level technique categories:
 *   ts-native       — direct static calls, constructors, same-file calls
 *   type-propagation — receiver-typed via return-type or annotation inference
 *   cha-rta         — class hierarchy / interface dispatch
 *   barrel          — resolution through barrel re-export chains
 *   points-to       — dataflow-based (callbacks, closures, higher-order functions)
 */
const TECHNIQUE_MAP: Record<string, string> = {
  static: 'ts-native',
  'same-file': 'ts-native',
  constructor: 'ts-native',
  'module-function': 'ts-native',
  'package-function': 'ts-native',
  'receiver-typed': 'type-propagation',
  'interface-dispatched': 'cha-rta',
  'class-inheritance': 'cha-rta',
  'class-hierarchy': 'cha-rta',
  'trait-dispatch': 'cha-rta',
  'this-dispatch-func-prop': 'cha-rta',
  're-export': 'barrel',
  closure: 'points-to',
  'higher-order': 'points-to',
  callback: 'points-to',
  dynamic: 'points-to',
  'points-to': 'points-to',
  'pts-define-property': 'points-to',
  'pts-create-prototype': 'points-to',
  'pts-for-of': 'points-to',
  'pts-set': 'points-to',
  'pts-array-from': 'points-to',
  'pts-spread': 'points-to',
  'pts-param': 'points-to',
  'define-property': 'ts-native',
};

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
  // javascript precision 1.0: the JS fixture is designed to have no false-positive edges —
  // every resolved edge matches an expected edge. A precision floor of 1.0 acts as a
  // ratchet: any future code change that introduces a spurious JS edge will fail CI
  // immediately, which is intentional. If a new fixture addition causes a genuine FP
  // (i.e. the code resolves an edge that is arguably correct but not in expected-edges),
  // the correct fix is to add it to expected-edges — not to lower the threshold.
  // JS recall 0.9: Phase 8.3e adds Object.defineProperty/defineProperties/create composite pts keys
  //   (5 new edges in define-property.js) + Phase 8.5 adds class-inheritance and prototype edges
  //   (inheritance.js, prototypes.js, prototypes2.js), lifting total expected to 30. Phase 8.3f
  //   adds bind/call/apply resolution (3 new edges in bind-call-apply.js), total expected now 33.
  //   Phase 8.3f adds Object.defineProperty accessor this-dispatch (#1335): getter→baz in
  //   define-property.js and accessorGetter→accessorTarget.accessMethod in define-property-accessor.js,
  //   total expected now 35. multi-class.js adds 4 class-scoped typeMap edges (#1382) → 39.
  //   call/apply this-rebinding adds 2 edges (runCallThis→invoker, invoker→handler) and removes
  //   the false-positive from handler being extracted as a callback arg of .call() (#1405) → 41.
  //   #1422 adds class-scope.js (bare-call guard), +1 → total 42.
  javascript: { precision: 1.0, recall: 0.9 },
  // pts-javascript: hand-authored points-to JS fixture (for-of, Set, Array.from, spread) — patterns
  //   too broad for the main JS fixture. Patterns split per file to prevent intra-fixture FPs.
  //   Currently resolves all 13 expected edges (100% recall, 100% precision).
  'pts-javascript': { precision: 1.0, recall: 0.9 },
  // TS 0.72: Phase 8.3e adds this.method() same-class resolution (Shape.describe → Shape.area),
  //   lifting recall from 69.4% to 72.2%.  Remaining gap (interface-dispatch, CHA) is tracked
  //   in Phase 8.5 (TSC enrichment) and Phase 8.7 (CHA on JS/TS).
  typescript: { precision: 0.85, recall: 0.72 },
  tsx: { precision: 0.85, recall: 0.8 },
  // TODO: raise thresholds once bash call resolution is implemented
  bash: { precision: 0.0, recall: 0.0 },
  // TODO: raise thresholds once ruby call resolution is reliable
  ruby: { precision: 0.0, recall: 0.0 },
  c: { precision: 0.6, recall: 0.2 },
  // Established — medium bars
  python: { precision: 0.7, recall: 0.3 },
  go: { precision: 0.7, recall: 0.3 },
  java: { precision: 0.7, recall: 0.3 },
  // csharp 1.0/0.9: static receiver fix (#1395) ensures precision; var-declared instance typeMap
  //   (implicit_type) lifts receiver-typed recall from 0/4 → 4/4 (#1396).
  csharp: { precision: 1.0, recall: 0.9 },
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
  // elixir: cross-module qualified calls resolve at 100% precision, 81% recall.
  //   Expected-edges now use module-qualified names (Main.run, UserService.create_user, etc.)
  //   matching what the Elixir extractor emits. Same-module bare calls (display_user → get_user)
  //   are not yet resolved — tracked as FNs. Precision 1.0 acts as ratchet against future FPs.
  elixir: { precision: 1.0, recall: 0.8 },
  dart: { precision: 0.0, recall: 0.0 },
  zig: { precision: 0.0, recall: 0.0 },
  fsharp: { precision: 0.0, recall: 0.0 },
  gleam: { precision: 0.0, recall: 0.0 },
  clojure: { precision: 0.0, recall: 0.0 },
  // julia: cross-module qualified calls resolve at 100% precision, 73% recall.
  //   Expected-edges now use module-qualified names (App.main, Service.create_user, etc.)
  //   matching what the Julia extractor emits. Same-file calls (summary → format_summary, etc.)
  //   are not yet resolved — tracked as FNs. Precision 1.0 acts as ratchet against future FPs.
  julia: { precision: 1.0, recall: 0.7 },
  r: { precision: 0.0, recall: 0.0 },
  erlang: { precision: 0.0, recall: 0.0 },
  solidity: { precision: 0.0, recall: 0.0 },
  // New fixture languages — no parser or call resolution yet
  // objc: class-method static calls and same-class calls resolve at 100% precision, 46% recall.
  //   Expected-edges now use full ObjC selectors (createUserWithId:name:email:, isValidEmail:, etc.)
  //   matching what the ObjC extractor emits. Constructor message sends (initWithRepository:) and
  //   receiver-typed instance message sends are not yet resolved — tracked as FNs.
  //   Precision 1.0 acts as ratchet against future FPs.
  objc: { precision: 1.0, recall: 0.4 },
  cuda: { precision: 0.0, recall: 0.0 },
  groovy: { precision: 0.0, recall: 0.0 },
  verilog: { precision: 0.0, recall: 0.0 },
  hcl: { precision: 0.0, recall: 0.0 },
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

/** Aggregates per-mode metrics into technique buckets via TECHNIQUE_MAP. */
function rollupByTechnique(byMode: Record<string, ModeMetrics>): Record<string, TechniqueMetrics> {
  const byTechnique: Record<string, TechniqueMetrics> = {};
  for (const [mode, data] of Object.entries(byMode)) {
    const tech = TECHNIQUE_MAP[mode] ?? 'other';
    if (!byTechnique[tech]) byTechnique[tech] = { expected: 0, resolved: 0 };
    byTechnique[tech].expected += data.expected;
    byTechnique[tech].resolved += data.resolved;
  }
  for (const tech of Object.keys(byTechnique)) {
    const t = byTechnique[tech];
    t.recall = t.expected > 0 ? t.resolved / t.expected : 0;
  }
  return byTechnique;
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

  // Aggregate per-mode data into technique buckets using TECHNIQUE_MAP
  const byTechnique = rollupByTechnique(byMode);

  return {
    precision,
    recall,
    truePositives: truePositives.size,
    falsePositives: falsePositives.size,
    falseNegatives: falseNegatives.size,
    totalResolved: resolvedSet.size,
    totalExpected: expectedSet.size,
    byMode,
    byTechnique,
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

  if (Object.keys(metrics.byTechnique).length > 0) {
    lines.push('', '  By technique (edges contributed):');
    for (const [tech, data] of Object.entries(metrics.byTechnique).sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      lines.push(
        `    ${tech.padEnd(18)}: ${String(data.resolved).padStart(3)} resolved / ${String(data.expected).padStart(3)} expected  (${((data.recall ?? 0) * 100).toFixed(1)}% recall)`,
      );
    }
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

// ── Artifact loading (CI dedup, issue #1052) ─────────────────────────────

const ARTIFACT_PATH = process.env.RESOLUTION_RESULT_JSON;

interface ArtifactLangResult {
  precision: number;
  recall: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  totalResolved: number;
  totalExpected: number;
  byMode: Record<string, ModeMetrics>;
  byTechnique?: Record<string, TechniqueMetrics>;
  falsePositiveEdges?: string[];
  falseNegativeEdges?: string[];
}

function loadArtifact(artifactPath: string): Record<string, ArtifactLangResult> {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `RESOLUTION_RESULT_JSON=${artifactPath} not found — run scripts/resolution-benchmark.ts first.`,
    );
  }
  const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as Record<
    string,
    ArtifactLangResult
  >;
  // Refuse to proceed on an empty artifact: with zero languages, vitest would
  // register no describe blocks and exit 0, silently passing the gate without
  // evaluating a single threshold.
  if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
    throw new Error(
      `RESOLUTION_RESULT_JSON=${artifactPath} contains no language results — regenerate with scripts/resolution-benchmark.ts.`,
    );
  }
  return parsed;
}

function metricsFromArtifact(lang: string, raw: ArtifactLangResult): BenchmarkMetrics {
  if (
    typeof raw.precision !== 'number' ||
    typeof raw.recall !== 'number' ||
    typeof raw.truePositives !== 'number' ||
    typeof raw.falsePositives !== 'number' ||
    typeof raw.falseNegatives !== 'number' ||
    typeof raw.totalResolved !== 'number' ||
    typeof raw.totalExpected !== 'number' ||
    !raw.byMode ||
    typeof raw.byMode !== 'object'
  ) {
    throw new Error(
      `Resolution artifact for ${lang} is missing required numeric fields — regenerate with the current resolution-benchmark.ts.`,
    );
  }
  if (!Array.isArray(raw.falsePositiveEdges) || !Array.isArray(raw.falseNegativeEdges)) {
    throw new Error(
      `Resolution artifact for ${lang} is missing falsePositiveEdges/falseNegativeEdges — regenerate with the current resolution-benchmark.ts.`,
    );
  }
  // Derive byTechnique from byMode when absent (older artifacts)
  const byTechnique = raw.byTechnique ?? rollupByTechnique(raw.byMode);

  return {
    precision: raw.precision,
    recall: raw.recall,
    truePositives: raw.truePositives,
    falsePositives: raw.falsePositives,
    falseNegatives: raw.falseNegatives,
    totalResolved: raw.totalResolved,
    totalExpected: raw.totalExpected,
    byMode: raw.byMode,
    byTechnique,
    falsePositiveEdges: raw.falsePositiveEdges,
    falseNegativeEdges: raw.falseNegativeEdges,
  };
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

const artifact = ARTIFACT_PATH ? loadArtifact(ARTIFACT_PATH) : null;
// In artifact mode, drive the suite from the keys in the artifact so we never
// silently skip a language the script reported. In local mode, discover from
// the filesystem like before.
const languages = artifact ? Object.keys(artifact).sort() : discoverFixtures();

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

    // Print aggregate technique totals across all languages
    const aggregateTechnique: Record<string, TechniqueMetrics> = {};
    for (const m of Object.values(allResults)) {
      for (const [tech, data] of Object.entries(m.byTechnique)) {
        if (!aggregateTechnique[tech]) aggregateTechnique[tech] = { expected: 0, resolved: 0 };
        aggregateTechnique[tech].expected += data.expected;
        aggregateTechnique[tech].resolved += data.resolved;
      }
    }
    for (const t of Object.values(aggregateTechnique)) {
      t.recall = t.expected > 0 ? t.resolved / t.expected : 0;
    }

    summaryLines.push('\n  ── Technique Coverage (all languages) ──');
    summaryLines.push('  Technique          | Resolved | Expected | Recall');
    summaryLines.push('  -------------------|----------|----------|-------');
    for (const [tech, data] of Object.entries(aggregateTechnique).sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      summaryLines.push(
        `  ${tech.padEnd(19)}| ${String(data.resolved).padStart(8)} | ${String(data.expected).padStart(8)} | ${((data.recall ?? 0) * 100).toFixed(1).padStart(5)}%`,
      );
    }

    const totalExpected = Object.values(allResults).reduce((s, m) => s + m.totalExpected, 0);
    const totalTruePositives = Object.values(allResults).reduce((s, m) => s + m.truePositives, 0);
    const aggregateRecall = totalExpected > 0 ? totalTruePositives / totalExpected : 0;
    summaryLines.push(
      `\n  Aggregate recall: ${(aggregateRecall * 100).toFixed(1)}% (${totalTruePositives}/${totalExpected} edges)`,
    );

    summaryLines.push('');
    console.log(summaryLines.join('\n'));
  });

  for (const lang of languages) {
    describe(lang, () => {
      let fixtureDir: string | null = null;
      let metrics: BenchmarkMetrics;

      beforeAll(async () => {
        if (artifact) {
          metrics = metricsFromArtifact(lang, artifact[lang]);
        } else {
          fixtureDir = copyFixture(lang);
          await buildFixtureGraph(fixtureDir);

          const resolvedEdges = extractResolvedEdges(fixtureDir) as ResolvedEdge[];

          const manifestPath = path.join(FIXTURES_DIR, lang, 'expected-edges.json');
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          const expectedEdges: ExpectedEdge[] = manifest.edges;

          metrics = computeMetrics(resolvedEdges, expectedEdges);
        }
        allResults[lang] = metrics;
      }, 60_000);

      afterAll(() => {
        if (fixtureDir) {
          fs.rmSync(fixtureDir, { recursive: true, force: true });
        }
      });

      test('metrics are populated', () => {
        expect(metrics).toBeDefined();
        expect(metrics.totalResolved).toBeGreaterThanOrEqual(0);
      });

      test('expected edges manifest is non-empty', () => {
        expect(metrics.totalExpected).toBeGreaterThan(0);
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

  /**
   * CI gate: aggregate recall across all fixture languages must not drop below
   * the 29% baseline documented in the roadmap. This threshold ratchets upward
   * as each resolution sub-phase ships.
   *
   * Declared after the per-language loop so Vitest registers it last and runs
   * it after all language beforeAll hooks have populated allResults.
   */
  test('aggregate recall meets coverage baseline', () => {
    const COVERAGE_BASELINE = 0.29;
    // Guard: if a language's beforeAll threw, allResults won't have an entry for it.
    // The smaller denominator would inflate the apparent recall, making the gate
    // meaningless. Fail explicitly so the partial failure is visible.
    expect(
      Object.keys(allResults).length,
      `Only ${Object.keys(allResults).length}/${languages.length} languages populated results — ` +
        `one or more beforeAll hooks may have thrown. Expected: [${languages.join(', ')}], ` +
        `Got: [${Object.keys(allResults).join(', ')}]`,
    ).toBe(languages.length);
    const totalExpected = Object.values(allResults).reduce((s, m) => s + m.totalExpected, 0);
    // Guard: if fixtures are absent the gate would trivially pass and mask regressions.
    // Fail explicitly so a misconfigured CI environment is visible rather than silently green.
    expect(
      totalExpected,
      'No fixture data found — fixtures directory may be empty or missing',
    ).toBeGreaterThan(0);
    const totalTruePositives = Object.values(allResults).reduce((s, m) => s + m.truePositives, 0);
    const aggregateRecall = totalTruePositives / totalExpected;
    expect(
      aggregateRecall,
      `Aggregate resolution recall ${(aggregateRecall * 100).toFixed(1)}% is below the ` +
        `${(COVERAGE_BASELINE * 100).toFixed(0)}% coverage baseline. ` +
        `Resolved ${totalTruePositives}/${totalExpected} expected edges across all fixture languages.`,
    ).toBeGreaterThanOrEqual(COVERAGE_BASELINE);
  });
});
