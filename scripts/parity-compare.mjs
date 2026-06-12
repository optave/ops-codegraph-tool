#!/usr/bin/env node
// Correctness-parity gate between the WASM and native engines.
//
// CLAUDE.md mandates that both engines produce identical results; this script
// asserts it directly. For every resolution-benchmark fixture it builds the
// graph with each engine into an isolated temp dir and compares the full node
// and edge multisets — any difference is a bug in the less-accurate engine,
// never an acceptable gap. Complements scripts/benchmark-parity-gate.mjs,
// which gates performance parity (timings, DB size), not correctness.
//
// Build paths covered:
//   wasm    — JS pipeline + JS extractors + JS edge resolution
//   native  — full Rust orchestrator (pipeline.rs)
//   hybrid  — JS pipeline + napi buildCallEdges (--hybrid; forced by building
//             wasm-incremental then native-incremental in the same dir, which
//             promotes to a full rebuild that skips the orchestrator)
//
// Usage:
//   node scripts/parity-compare.mjs [--langs js,python] [--hybrid] [--json]
//
// Exit codes: 0 = parity, 1 = divergence or fixture build failure,
//             2 = pre-flight failure (missing dist, native unavailable).

import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function usage() {
  console.error(
    [
      'Usage: node scripts/parity-compare.mjs [options]',
      '',
      '  --langs a,b,c   Only run the named fixtures (fixture dir names,',
      '                  e.g. javascript,pts-javascript,python)',
      '  --hybrid        Also build via the hybrid path (JS pipeline + native',
      '                  buildCallEdges) and compare it against the wasm baseline',
      '  --json          Machine-readable report on stdout (logs stay on stderr)',
      '  -h, --help      Show this help',
    ].join('\n'),
  );
}

// ── Argument parsing ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
let langsFilter = null;
let hybrid = false;
let json = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--langs') {
    langsFilter = (args[++i] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (a.startsWith('--langs=')) {
    langsFilter = a
      .slice('--langs='.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (a === '--hybrid') {
    hybrid = true;
  } else if (a === '--json') {
    json = true;
  } else if (a === '-h' || a === '--help') {
    usage();
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${a}\n`);
    usage();
    process.exit(2);
  }
}

// ── Pre-flight ────────────────────────────────────────────────────────────

const distIndex = join(repoRoot, 'dist', 'index.js');
if (!existsSync(distIndex)) {
  console.error('parity-compare: dist/index.js not found — run `npm run build` first.');
  process.exit(2);
}

const { buildGraph } = await import(pathToFileURL(distIndex).href);
const { isNativeAvailable } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'infrastructure', 'native.js')).href
);

if (!isNativeAvailable()) {
  console.error(
    'parity-compare: native engine unavailable — install the platform package or build it locally:\n' +
      '  cd crates/codegraph-core && npx napi build --platform --release\n' +
      '  (macOS: codesign --sign - --force <built .node/.dylib>)\n' +
      'then place the binary where infrastructure/native.ts can load it.',
  );
  process.exit(2);
}

const Database = require('better-sqlite3');

const fixturesRoot = join(repoRoot, 'tests', 'benchmarks', 'resolution', 'fixtures');
const allFixtures = readdirSync(fixturesRoot)
  .filter((name) => statSync(join(fixturesRoot, name)).isDirectory())
  .sort();

let fixtures = allFixtures;
if (langsFilter) {
  if (langsFilter.length === 0) {
    console.error('parity-compare: --langs requires at least one fixture name.');
    process.exit(2);
  }
  const unknown = langsFilter.filter((l) => !allFixtures.includes(l));
  if (unknown.length > 0) {
    console.error(
      `parity-compare: unknown fixture(s): ${unknown.join(', ')}\n` +
        `Available: ${allFixtures.join(', ')}`,
    );
    process.exit(2);
  }
  fixtures = allFixtures.filter((f) => langsFilter.includes(f));
}

// ── Build + read helpers ──────────────────────────────────────────────────

// dataflow/cfg/ast are out of scope for the node+edge parity surface; the
// rest of the options stay at CLI defaults so the comparison reflects what a
// real `codegraph build` produces.
const BUILD_OPTS = {
  incremental: false,
  dataflow: false,
  cfg: false,
  ast: false,
  skipRegistry: true,
};

async function buildEngine(fixtureDir, engine, label, tempDirs) {
  const dir = mkdtempSync(join(tmpdir(), `parity-${label}-`));
  tempDirs.push(dir); // register before await so cleanup runs even if buildGraph throws
  cpSync(fixtureDir, dir, { recursive: true });
  await buildGraph(dir, { ...BUILD_OPTS, engine });
  return dir;
}

// Hybrid path: an incremental wasm build followed by an incremental native
// build on the same dir triggers "Engine changed (wasm -> native), promoting
// to full rebuild", which sets forceFullRebuild and skips the orchestrator —
// the JS pipeline then drives the napi buildCallEdges resolver.
async function buildHybrid(fixtureDir, label, tempDirs) {
  const dir = mkdtempSync(join(tmpdir(), `parity-${label}-`));
  tempDirs.push(dir); // register before await so cleanup runs even if buildGraph throws
  cpSync(fixtureDir, dir, { recursive: true });
  await buildGraph(dir, { ...BUILD_OPTS, incremental: true, engine: 'wasm' });
  await buildGraph(dir, { ...BUILD_OPTS, incremental: true, engine: 'native' });
  return dir;
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function readMultisets(dir) {
  const db = new Database(join(dir, '.codegraph', 'graph.db'), { readonly: true });
  try {
    const nodes = new Map();
    const nodeRows = db.prepare('SELECT kind, name, file, line FROM nodes').all();
    for (const r of nodeRows) bump(nodes, `${r.kind}|${r.name}|${r.file}|${r.line ?? ''}`);
    nodes.set('__TOTAL_ROWS__', nodeRows.length);

    const edges = new Map();
    const edgeRows = db
      .prepare(
        `SELECT e.kind AS kind,
                sn.name AS srcName, sn.kind AS srcKind, sn.file AS srcFile,
                tn.name AS tgtName, tn.kind AS tgtKind, tn.file AS tgtFile,
                e.confidence AS conf, e.dynamic AS dyn
         FROM edges e
         JOIN nodes sn ON sn.id = e.source_id
         JOIN nodes tn ON tn.id = e.target_id`,
      )
      .all();
    for (const r of edgeRows) {
      bump(
        edges,
        `[${r.kind}] ${r.srcFile}:${r.srcName}(${r.srcKind}) -> ${r.tgtFile}:${r.tgtName}(${r.tgtKind}) conf=${r.conf} dyn=${r.dyn}`,
      );
    }
    edges.set('__TOTAL_ROWS__', edgeRows.length);
    return { nodes, edges };
  } finally {
    db.close();
  }
}

function diffMultisets(base, other) {
  const diffs = [];
  const keys = new Set([...base.keys(), ...other.keys()]);
  keys.delete('__TOTAL_ROWS__');
  for (const key of keys) {
    const a = base.get(key) ?? 0;
    const b = other.get(key) ?? 0;
    if (a !== b) diffs.push({ key, base: a, other: b });
  }
  diffs.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return diffs;
}

// ── Main loop ─────────────────────────────────────────────────────────────

const report = { fixtures: [], ok: true };

for (const fixture of fixtures) {
  const fixtureDir = join(fixturesRoot, fixture);
  const entry = { name: fixture, comparisons: [], error: null };
  report.fixtures.push(entry);
  const tempDirs = [];

  try {
    const wasmDir = await buildEngine(fixtureDir, 'wasm', `${fixture}-wasm`, tempDirs);
    const base = readMultisets(wasmDir);

    const nativeDir = await buildEngine(fixtureDir, 'native', `${fixture}-native`, tempDirs);
    const variants = [['native', nativeDir]];
    if (hybrid) {
      const hybridDir = await buildHybrid(fixtureDir, `${fixture}-hybrid`, tempDirs);
      variants.push(['hybrid', hybridDir]);
    }

    for (const [variantName, dir] of variants) {
      const other = readMultisets(dir);
      const nodeDiffs = diffMultisets(base.nodes, other.nodes);
      const edgeDiffs = diffMultisets(base.edges, other.edges);
      const ok = nodeDiffs.length === 0 && edgeDiffs.length === 0;
      if (!ok) report.ok = false;
      entry.comparisons.push({
        baseline: 'wasm',
        variant: variantName,
        ok,
        nodeCount: base.nodes.get('__TOTAL_ROWS__'),
        edgeCount: base.edges.get('__TOTAL_ROWS__'),
        nodeDiffs,
        edgeDiffs,
      });

      if (!json) {
        if (ok) {
          console.log(
            `=== ${fixture}: wasm vs ${variantName} OK ` +
              `(${base.nodes.get('__TOTAL_ROWS__')} nodes, ${base.edges.get('__TOTAL_ROWS__')} edges)`,
          );
        } else {
          console.log(
            `=== ${fixture}: wasm vs ${variantName} DIVERGED ` +
              `(${nodeDiffs.length} node diffs, ${edgeDiffs.length} edge diffs)`,
          );
          for (const d of nodeDiffs) {
            console.log(`  [node] ${d.key}  wasm=${d.base} ${variantName}=${d.other}`);
          }
          for (const d of edgeDiffs) {
            console.log(`  [edge] ${d.key}  wasm=${d.base} ${variantName}=${d.other}`);
          }
        }
      }
    }
  } catch (err) {
    entry.error = err instanceof Error ? err.message : String(err);
    report.ok = false;
    if (!json) console.log(`=== ${fixture}: BUILD FAILED — ${entry.error}`);
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup of temp dirs
      }
    }
  }
}

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const failed = report.fixtures.filter(
    (f) => f.error || f.comparisons.some((c) => !c.ok),
  );
  console.log(
    report.ok
      ? `\nPARITY OK — ${report.fixtures.length} fixture(s), all engines identical`
      : `\nPARITY FAILED — ${failed.length}/${report.fixtures.length} fixture(s) diverged: ${failed.map((f) => f.name).join(', ')}`,
  );
}

// The WASM worker pool keeps the event loop alive; exit explicitly.
process.exit(report.ok ? 0 : 1);
