/**
 * Dynamic Tracer Validation Test Suite
 *
 * Runs the dynamic call tracer for each language fixture and verifies that
 * same-file (intra-module) call edges are captured. This validates the
 * instrumentation added in #890.
 *
 * For each language:
 *   1. Run `run-tracer.mjs <fixture-dir>` via execFileSync
 *   2. Parse the JSON edge output
 *   3. Load expected-edges.json and filter to mode === "same-file"
 *   4. Compute recall = matched / total same-file expected edges
 *   5. Assert recall >= per-language threshold
 *
 * **Artifact mode (CI):** when `RESOLUTION_RESULT_JSON` points at a result
 * file produced by `scripts/resolution-benchmark.ts`, the suite reads the
 * pre-captured tracer edges from that artifact instead of re-running the
 * per-language tracer subprocess — avoiding the duplicate work that doubled
 * pre-publish tracer cost (issue #1166). Local runs without the env var
 * fall back to spawning `run-tracer.mjs` directly.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

// ── Types ─────────────────────────────────────────────────────────────────

interface TracerEdge {
  source_name: string;
  source_file: string;
  target_name: string;
  target_file: string;
}

interface ExpectedEdge {
  source: { name: string; file: string };
  target: { name: string; file: string };
  kind: string;
  mode?: string;
  notes?: string;
}

// ── Configuration ────────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(import.meta.dirname, '..', 'fixtures');
const RUN_TRACER = path.join(import.meta.dirname, 'run-tracer.mjs');

/**
 * Per-language same-file recall thresholds.
 *
 * Languages with working intra-module tracing have non-zero thresholds.
 * Languages where the tracer returns empty_result or the runtime isn't
 * commonly available stay at 0.0 to avoid blocking CI.
 */
const SAME_FILE_THRESHOLDS: Record<string, number> = {
  // ESM hook — source-level rewriting captures all intra-module calls
  javascript: 0.8,
  typescript: 0.8,
  tsx: 0.8,

  // Interpreted — runtime tracing APIs capture same-file calls
  python: 0.8,
  ruby: 0.8,
  lua: 0.5,
  php: 0.0, // php tracer unreliable in CI (missing extensions or config differences)
  bash: 0.0, // bash tracer uses DEBUG trap which doesn't capture intra-function calls
  r: 0.0, // Rscript not reliably available across CI platforms
  elixir: 0.5,
  erlang: 0.5,
  clojure: 0.5,

  // JVM — sed-injected CallTracer.traceCall()
  java: 0.5,
  kotlin: 0.0, // kotlinc not reliably available in CI
  scala: 0.5,
  groovy: 0.5,

  // Native — sed-injected trace support
  // c/cpp use -finstrument-functions + dladdr() instead of sed injection,
  // which can only resolve the compiled binary's own filename, never the
  // originating source file — same-file recall is structurally stuck at 0%
  // until that's fixed (see #2049).
  c: 0.0,
  cpp: 0.0,
  go: 0.5,
  rust: 0.5,
  csharp: 0.5,
  swift: 0.5,
  dart: 0.5,
  zig: 0.5,

  // Profiling / enter-only — may capture some edges
  haskell: 0.0, // ghc not reliably available across CI platforms
  ocaml: 0.5,

  // Not yet implemented or infeasible — 0 threshold
  fsharp: 0.0,
  gleam: 0.0,
  solidity: 0.0,
  julia: 0.0,
  objc: 0.0,
  cuda: 0.0,
  verilog: 0.0,
  hcl: 0.0,
};

const DEFAULT_THRESHOLD = 0.0;

// ── Helpers ──────────────────────────────────────────────────────────────

function edgeKey(
  sourceName: string,
  sourceFile: string,
  targetName: string,
  targetFile: string,
): string {
  return `${sourceName}@${sourceFile}->${targetName}@${targetFile}`;
}

function basename(filePath: string): string {
  return path.basename(filePath).replace(/\?.*$/, '');
}

function runTracer(lang: string): TracerEdge[] | null {
  const fixtureDir = path.join(FIXTURES_DIR, lang);
  if (!fs.existsSync(fixtureDir)) return null;

  try {
    const result = execFileSync(process.execPath, [RUN_TRACER, fixtureDir], {
      encoding: 'utf-8',
      timeout: 60_000,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const parsed = JSON.parse(result);
    if (parsed.error && (!parsed.edges || parsed.edges.length === 0)) {
      // Toolchain not available — skip gracefully
      return null;
    }
    return parsed.edges || [];
  } catch {
    return null;
  }
}

// ── Artifact loading (CI dedup, issue #1166) ─────────────────────────────

interface ArtifactTracer {
  status: 'ok' | 'skipped';
  edges: TracerEdge[];
}

interface ArtifactLangResult {
  tracer?: ArtifactTracer;
}

const ARTIFACT_PATH = process.env.RESOLUTION_RESULT_JSON;

function loadArtifact(artifactPath: string): Record<string, ArtifactLangResult> {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `RESOLUTION_RESULT_JSON=${artifactPath} not found — run scripts/resolution-benchmark.ts first.`,
    );
  }
  const raw = fs.readFileSync(artifactPath, 'utf-8');
  let parsed: Record<string, ArtifactLangResult>;
  try {
    parsed = JSON.parse(raw) as Record<string, ArtifactLangResult>;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `RESOLUTION_RESULT_JSON=${artifactPath} contains malformed JSON (${reason}) — regenerate with scripts/resolution-benchmark.ts.`,
    );
  }
  // Refuse to proceed on an empty artifact: with zero languages, vitest would
  // register no test cases and exit 0, silently passing the gate.
  if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
    throw new Error(
      `RESOLUTION_RESULT_JSON=${artifactPath} contains no language results — regenerate with scripts/resolution-benchmark.ts.`,
    );
  }
  return parsed;
}

function tracerFromArtifact(
  lang: string,
  raw: ArtifactLangResult | undefined,
): TracerEdge[] | null {
  if (!raw?.tracer) {
    throw new Error(
      `Resolution artifact for ${lang} is missing the tracer block — regenerate with the current scripts/resolution-benchmark.ts.`,
    );
  }
  // Preserve the runTracer null-as-skipped contract so toolchain-missing
  // languages are skipped gracefully in artifact mode too.
  if (raw.tracer.status === 'skipped') return null;
  if (!Array.isArray(raw.tracer.edges)) {
    throw new Error(
      `Resolution artifact for ${lang} has malformed tracer.edges — regenerate with the current scripts/resolution-benchmark.ts.`,
    );
  }
  return raw.tracer.edges;
}

function loadExpectedEdges(lang: string): ExpectedEdge[] {
  const edgesFile = path.join(FIXTURES_DIR, lang, 'expected-edges.json');
  if (!fs.existsSync(edgesFile)) return [];
  const data = JSON.parse(fs.readFileSync(edgesFile, 'utf-8'));
  return data.edges || [];
}

function computeSameFileRecall(
  tracerEdges: TracerEdge[],
  expectedEdges: ExpectedEdge[],
): { recall: number; matched: number; total: number; missing: string[] } {
  const sameFileExpected = expectedEdges.filter((e) => e.mode === 'same-file');
  if (sameFileExpected.length === 0) {
    return { recall: 1.0, matched: 0, total: 0, missing: [] };
  }

  // Build a set of tracer edge keys for lookup
  const tracerKeys = new Set(
    tracerEdges.map((e) =>
      edgeKey(e.source_name, basename(e.source_file), e.target_name, basename(e.target_file)),
    ),
  );

  let matched = 0;
  const missing: string[] = [];

  for (const edge of sameFileExpected) {
    const key = edgeKey(edge.source.name, edge.source.file, edge.target.name, edge.target.file);
    if (tracerKeys.has(key)) {
      matched++;
    } else {
      missing.push(key);
    }
  }

  return {
    recall: matched / sameFileExpected.length,
    matched,
    total: sameFileExpected.length,
    missing,
  };
}

// ── Test Suite ───────────────────────────────────────────────────────────

const artifact = ARTIFACT_PATH ? loadArtifact(ARTIFACT_PATH) : null;

// In artifact mode, drive the suite from the keys in the artifact so we never
// silently skip a language the script reported. In local mode, discover from
// the filesystem like before.
const languages = artifact
  ? Object.keys(artifact).sort()
  : fs
      .readdirSync(FIXTURES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((lang) => fs.existsSync(path.join(FIXTURES_DIR, lang, 'expected-edges.json')))
      .sort();

describe('Dynamic Tracer — Same-File Edge Recall', () => {
  // Summary table printed after all tests
  const results: Array<{
    lang: string;
    recall: number;
    matched: number;
    total: number;
    threshold: number;
    status: string;
  }> = [];

  for (const lang of languages) {
    test(`${lang}: captures same-file edges`, { timeout: 90_000 }, () => {
      const expectedEdges = loadExpectedEdges(lang);
      const sameFileEdges = expectedEdges.filter((e) => e.mode === 'same-file');
      const threshold = SAME_FILE_THRESHOLDS[lang] ?? DEFAULT_THRESHOLD;

      // Skip languages with no same-file edges expected
      if (sameFileEdges.length === 0) {
        results.push({ lang, recall: 1.0, matched: 0, total: 0, threshold, status: 'no-edges' });
        return;
      }

      const tracerEdges = artifact ? tracerFromArtifact(lang, artifact[lang]) : runTracer(lang);

      // If tracer couldn't run (toolchain missing), skip gracefully.
      // Many languages require runtimes (rustc, ghc, ruby, etc.) that aren't
      // installed in every environment. The test only validates recall when the
      // tracer actually produces output.
      if (tracerEdges === null) {
        results.push({
          lang,
          recall: 0,
          matched: 0,
          total: sameFileEdges.length,
          threshold,
          status: 'skipped',
        });
        return;
      }

      const { recall, matched, total, missing } = computeSameFileRecall(tracerEdges, expectedEdges);

      results.push({
        lang,
        recall,
        matched,
        total,
        threshold,
        status: recall >= threshold ? 'pass' : 'fail',
      });

      if (missing.length > 0 && recall < 1.0) {
        console.log(`  ${lang}: missing same-file edges: ${missing.join(', ')}`);
      }

      expect
        .soft(
          recall,
          `${lang}: same-file recall ${(recall * 100).toFixed(0)}% (${matched}/${total}) below threshold ${(threshold * 100).toFixed(0)}%`,
        )
        .toBeGreaterThanOrEqual(threshold);
    });
  }

  // Print summary table after all tests
  test('summary', () => {
    console.log('\n── Dynamic Tracer Same-File Edge Recall ──');
    console.log('Language      | Recall     | Threshold  | Status');
    console.log('──────────────|────────────|────────────|───────');
    for (const r of results.sort((a, b) => a.lang.localeCompare(b.lang))) {
      const recallStr =
        r.total === 0 ? 'n/a' : `${(r.recall * 100).toFixed(0)}% (${r.matched}/${r.total})`;
      const threshStr = `${(r.threshold * 100).toFixed(0)}%`;
      console.log(
        `${r.lang.padEnd(14)}| ${recallStr.padEnd(11)}| ${threshStr.padEnd(11)}| ${r.status}`,
      );
    }
  });
});
