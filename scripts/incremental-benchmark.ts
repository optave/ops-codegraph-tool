#!/usr/bin/env node

/**
 * Incremental build benchmark — measures build tiers and import resolution.
 *
 * Each engine (native / WASM) runs in a forked subprocess so that a segfault
 * in the native addon only kills the child — the parent survives and collects
 * partial results from whichever engines succeeded.
 *
 * Usage: node scripts/incremental-benchmark.js > result.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { BENCHMARK_EXCLUDES, resolveBenchmarkSource, srcImport } from './lib/bench-config.js';
import { isWorker, workerEngine, forkEngines } from './lib/fork-engine.js';

// ── Parent process: fork one child per engine, assemble final output ─────
if (!isWorker()) {
	const { version, srcDir: parentSrcDir, cleanup: parentCleanup } = await resolveBenchmarkSource();
	let wasm, native;
	try {
		({ wasm, native } = await forkEngines(import.meta.url, process.argv.slice(2)));
	} catch (err) {
		console.error(`Error: ${err.message}`);
		parentCleanup();
		process.exit(1);
	}

	// Import resolution runs in the parent — it tests both native and JS
	// fallback in a single pass and doesn't need engine isolation.
	const __dirParent = path.dirname(fileURLToPath(import.meta.url));
	const rootParent = path.resolve(__dirParent, '..');
	const dbPathParent = path.join(rootParent, '.codegraph', 'graph.db');

	const { statsData: parentStats } = await import(srcImport(parentSrcDir, 'domain/queries.js'));
	const { resolveImportsBatch: parentBatch, resolveImportPathJS: parentJS } = await import(
		srcImport(parentSrcDir, 'domain/graph/resolve.js')
	);
	const { isNativeAvailable: parentNativeCheck } = await import(
		srcImport(parentSrcDir, 'infrastructure/native.js')
	);

	// Mirror the worker-side methodology (WARMUP_RUNS=2, RUNS=5) so the parent's
	// import-resolution timings are not exposed to the same cold-start outlier
	// dynamic this PR is fixing. nativeBatchMs / jsFallbackMs are sub-15ms on
	// codegraph itself today — exactly the sub-30ms band where a 3-sample
	// median without warmup picks up rusqlite statement-cache and NAPI init
	// jitter and produces CI-amplified false regressions.
	const RUNS = 5;
	const WARMUP_RUNS = 2;
	function median(arr) {
		const sorted = [...arr].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	}
	function round1(n) { return Math.round(n * 10) / 10; }

	function collectImportPairs() {
		const srcRoot = path.join(rootParent, 'src');
		const importRe = /(?:^|\n)\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
		const pairs = [];
		function walk(dir) {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) { walk(path.join(dir, entry.name)); continue; }
				if (!entry.name.endsWith('.js') && !entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
				const absFile = path.join(dir, entry.name);
				const content = fs.readFileSync(absFile, 'utf8');
				let match;
				while ((match = importRe.exec(content)) !== null) {
					pairs.push({ fromFile: absFile, importSource: match[1] });
				}
			}
		}
		walk(srcRoot);
		return pairs;
	}

	let stats = null;
	try { stats = parentStats(dbPathParent); } catch { /* DB may not exist if both engines failed */ }
	const files = stats?.files?.total ?? (wasm?.files || native?.files || 0);

	console.error('Benchmarking import resolution...');
	const inputs = collectImportPairs();
	console.error(`  ${inputs.length} import pairs collected`);

	let nativeBatchMs = null;
	let perImportNativeMs = null;
	if (parentNativeCheck()) {
		for (let i = 0; i < WARMUP_RUNS; i++) {
			parentBatch(inputs, rootParent, null);
		}
		const timings = [];
		for (let i = 0; i < RUNS; i++) {
			const start = performance.now();
			parentBatch(inputs, rootParent, null);
			timings.push(performance.now() - start);
		}
		nativeBatchMs = round1(median(timings));
		perImportNativeMs = inputs.length > 0 ? round1(nativeBatchMs / inputs.length) : 0;
	}
	for (let i = 0; i < WARMUP_RUNS; i++) {
		for (const { fromFile, importSource } of inputs) {
			parentJS(fromFile, importSource, rootParent, null);
		}
	}
	const jsTimings = [];
	for (let i = 0; i < RUNS; i++) {
		const start = performance.now();
		for (const { fromFile, importSource } of inputs) {
			parentJS(fromFile, importSource, rootParent, null);
		}
		jsTimings.push(performance.now() - start);
	}
	const jsFallbackMs = round1(median(jsTimings));
	const perImportJsMs = inputs.length > 0 ? round1(jsFallbackMs / inputs.length) : 0;

	const resolve = { imports: inputs.length, nativeBatchMs, jsFallbackMs, perImportNativeMs, perImportJsMs };
	console.error(`  native=${resolve.nativeBatchMs}ms js=${resolve.jsFallbackMs}ms`);

	const result = {
		version,
		date: new Date().toISOString().slice(0, 10),
		files,
		wasm: wasm
			? {
					fullBuildMs: wasm.fullBuildMs,
					noopRebuildMs: wasm.noopRebuildMs,
					oneFileRebuildMs: wasm.oneFileRebuildMs,
					oneFilePhases: wasm.oneFilePhases,
				}
			: null,
		native: native
			? {
					fullBuildMs: native.fullBuildMs,
					noopRebuildMs: native.noopRebuildMs,
					oneFileRebuildMs: native.oneFileRebuildMs,
					oneFilePhases: native.oneFilePhases,
				}
			: null,
		resolve,
	};

	console.log(JSON.stringify(result, null, 2));
	parentCleanup();
	process.exit(0);
}

// ── Worker process: benchmark build tiers for a single engine ────────────
const engine = workerEngine();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const { srcDir, cleanup } = await resolveBenchmarkSource();
const dbPath = path.join(root, '.codegraph', 'graph.db');

const { buildGraph } = await import(srcImport(srcDir, 'domain/graph/builder.js'));
// v3.9.5+ parses WASM in a worker_thread that keeps the event loop alive until
// disposed. Older releases don't export disposeParsers — fall back to a no-op.
let disposeParsers = async () => {};
try {
	const parser = await import(srcImport(srcDir, 'domain/parser.js'));
	if (typeof parser.disposeParsers === 'function') disposeParsers = parser.disposeParsers;
} catch { /* older release — no worker pool to dispose */ }

// Redirect console.log to stderr so only JSON goes to stdout
const origLog = console.log;
console.log = (...args) => console.error(...args);

const RUNS = 5;
const PROBE_FILE = path.join(root, 'src', 'domain', 'queries.ts');

// First 1–2 incremental rebuilds per process pay a cold-start cost (rusqlite
// statement-cache warmup, OS page cache for the DB file, NAPI-side static
// init from tree-sitter's transitive crates linked into the .node binary).
// Mirrors the WARMUP_RUNS used in scripts/query-benchmark.ts since #1077 —
// without this, a 3-sample median includes cold-start outliers and shows
// CI-amplified false regressions on sub-30ms metrics like No-op rebuild.
const WARMUP_RUNS = 2;

// Resolution-benchmark fixtures (`BENCHMARK_EXCLUDES` in scripts/lib/bench-config.ts)
// are excluded from every benchmark `buildGraph` call. See that constant for the
// full rationale — short version: hand-annotated fixtures aren't representative
// of real source, and heavyweight grammars (#1107) silently inflate timings.
const BUILD_OPTS = { engine, exclude: [...BENCHMARK_EXCLUDES] };

function median(arr) {
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

console.error(`Benchmarking ${engine} engine...`);

// Full build (delete DB first)
const fullTimings = [];
for (let i = 0; i < RUNS; i++) {
	if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
	const start = performance.now();
	await buildGraph(root, { ...BUILD_OPTS, incremental: false });
	fullTimings.push(performance.now() - start);
}
const fullBuildMs = Math.round(median(fullTimings));

// No-op rebuild (nothing changed)
let noopRebuildMs = null;
try {
	for (let i = 0; i < WARMUP_RUNS; i++) {
		await buildGraph(root, { ...BUILD_OPTS, incremental: true });
	}
	const noopTimings = [];
	for (let i = 0; i < RUNS; i++) {
		const start = performance.now();
		await buildGraph(root, { ...BUILD_OPTS, incremental: true });
		noopTimings.push(performance.now() - start);
	}
	noopRebuildMs = Math.round(median(noopTimings));
} catch (err) {
	console.error(`  [${engine}] No-op rebuild failed: ${(err as Error).message}`);
}

// 1-file change rebuild
const original = fs.readFileSync(PROBE_FILE, 'utf8');
let oneFileRebuildMs = null;
let oneFilePhases = null;
try {
	for (let i = 0; i < WARMUP_RUNS; i++) {
		fs.writeFileSync(PROBE_FILE, original + `\n// warmup-${i}\n`);
		await buildGraph(root, { ...BUILD_OPTS, incremental: true });
	}
	const oneFileRuns = [];
	for (let i = 0; i < RUNS; i++) {
		fs.writeFileSync(PROBE_FILE, original + `\n// probe-${i}\n`);
		const start = performance.now();
		const res = await buildGraph(root, { ...BUILD_OPTS, incremental: true });
		oneFileRuns.push({ ms: performance.now() - start, phases: res?.phases || null });
	}
	oneFileRuns.sort((a, b) => a.ms - b.ms);
	const medianRun = oneFileRuns[Math.floor(oneFileRuns.length / 2)];
	oneFileRebuildMs = Math.round(medianRun.ms);
	oneFilePhases = medianRun.phases;
} catch (err) {
	console.error(`  [${engine}] 1-file rebuild failed: ${(err as Error).message}`);
} finally {
	fs.writeFileSync(PROBE_FILE, original);
	try {
		await buildGraph(root, { ...BUILD_OPTS, incremental: true });
	} catch {
		// Cleanup rebuild failed — probe file is already restored, move on
	}
}

console.error(`  full=${fullBuildMs}ms noop=${noopRebuildMs ?? 'FAILED'}ms 1-file=${oneFileRebuildMs ?? 'FAILED'}ms`);

// Restore console.log for JSON output
console.log = origLog;

const workerResult = { fullBuildMs, noopRebuildMs, oneFileRebuildMs, oneFilePhases };
console.log(JSON.stringify(workerResult));

await disposeParsers();
cleanup();
process.exit(0);
