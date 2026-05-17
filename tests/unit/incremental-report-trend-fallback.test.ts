import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'update-incremental-report.ts');

// --experimental-strip-types works in Node 22.6+ through current 24.x; the
// renamed --strip-types was added then removed again across 24.x minor
// versions, so prefer the experimental name for compatibility.
const stripFlag = '--experimental-strip-types';

let tmpDir: string;
let reportPath: string;
let entryPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-trend-fallback-'));
  reportPath = path.join(tmpDir, 'INCREMENTAL-BENCHMARKS.md');
  entryPath = path.join(tmpDir, 'entry.json');
});

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runScript() {
  execFileSync('node', [stripFlag, scriptPath, entryPath], {
    env: { ...process.env, CODEGRAPH_INCREMENTAL_REPORT_PATH: reportPath },
    stdio: 'pipe',
  });
}

function row(content: string, version: string, engine: string): string {
  const re = new RegExp(`^\\| ${version.replace(/\./g, '\\.')} \\| ${engine} \\|.*$`, 'm');
  const m = content.match(re);
  if (!m) throw new Error(`row not found for ${version}/${engine}`);
  return m[0];
}

describe('update-incremental-report trend fallback', () => {
  it('falls back to nearest non-null prior release when previous metrics are null', () => {
    // Seed: 9.9.4 has full data. 9.9.5 is the null release (workers crashed).
    const initial = `# Codegraph Incremental Build Benchmarks

<!-- INCREMENTAL_BENCHMARK_DATA
[
  {
    "version": "9.9.5",
    "date": "2026-05-01",
    "files": 100,
    "wasm": null,
    "native": null,
    "resolve": { "imports": 100, "nativeBatchMs": 5, "jsFallbackMs": 10, "perImportNativeMs": 0, "perImportJsMs": 0 }
  },
  {
    "version": "9.9.4",
    "date": "2026-04-18",
    "files": 100,
    "wasm": { "fullBuildMs": 1000, "noopRebuildMs": 10, "oneFileRebuildMs": 50 },
    "native": { "fullBuildMs": 500, "noopRebuildMs": 5, "oneFileRebuildMs": 25 },
    "resolve": { "imports": 100, "nativeBatchMs": 5, "jsFallbackMs": 10, "perImportNativeMs": 0, "perImportJsMs": 0 }
  }
]
-->
`;
    fs.writeFileSync(reportPath, initial);
    // New release 9.9.6 doubles wasm full-build and 13x's no-op rebuild — should
    // compare against 9.9.4 (skipping null 9.9.5) and show large regressions.
    fs.writeFileSync(
      entryPath,
      JSON.stringify({
        version: '9.9.6',
        date: '2026-04-30',
        files: 100,
        wasm: { fullBuildMs: 2000, noopRebuildMs: 130, oneFileRebuildMs: 60 },
        native: { fullBuildMs: 600, noopRebuildMs: 8, oneFileRebuildMs: 30 },
        resolve: {
          imports: 100,
          nativeBatchMs: 5,
          jsFallbackMs: 10,
          perImportNativeMs: 0,
          perImportJsMs: 0,
        },
      }),
    );

    runScript();
    const out = fs.readFileSync(reportPath, 'utf8');

    const wasmRow = row(out, '9.9.6', 'wasm');
    // Full build: 1000 → 2000 = +100%
    expect(wasmRow).toContain('↑100%');
    // No-op: 10 → 130 = +1200%
    expect(wasmRow).toContain('↑1200%');
    // 1-file: 50 → 60 = +20%
    expect(wasmRow).toContain('↑20%');

    // And the null 9.9.5 row still renders without a trend (no prior data
    // for it to compare against — it itself has no metrics).
    expect(out).not.toMatch(/^\| 9\.9\.5 \| wasm \|/m);
    expect(out).not.toMatch(/^\| 9\.9\.5 \| native \|/m);
  });

  it('leaves trend empty when no prior release has the metric at all', () => {
    const initial = `# Codegraph Incremental Build Benchmarks

<!-- INCREMENTAL_BENCHMARK_DATA
[]
-->
`;
    fs.writeFileSync(reportPath, initial);
    fs.writeFileSync(
      entryPath,
      JSON.stringify({
        version: '1.0.0',
        date: '2026-01-01',
        files: 50,
        wasm: { fullBuildMs: 1000, noopRebuildMs: 10, oneFileRebuildMs: 50 },
        native: { fullBuildMs: 500, noopRebuildMs: 5, oneFileRebuildMs: 25 },
        resolve: {
          imports: 50,
          nativeBatchMs: 1,
          jsFallbackMs: 2,
          perImportNativeMs: 0,
          perImportJsMs: 0,
        },
      }),
    );

    runScript();
    const out = fs.readFileSync(reportPath, 'utf8');
    const wasmRow = row(out, '1.0.0', 'wasm');
    // No prior history => no arrow annotations on any cell
    expect(wasmRow).not.toContain('↑');
    expect(wasmRow).not.toContain('↓');
    expect(wasmRow).not.toContain('~');
  });
});
