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
import { resolveBenchmarkSource, srcImport } from './lib/bench-config.js';
import { isWorker, workerEngine, forkEngines } from './lib/fork-engine.js';

// ── Parent process: fork one child per engine, assemble final output ─────
if (!isWorker()) {
	const { version, srcDir: parentSrcDir, cleanup: parentCleanup } = await resolveBenchmarkSource();
	const { wasm, native } = await forkEngines(import.meta.url, process.argv.slice(2));

	// Import resolution runs in the parent — it tests both native and JS
	// fallback in a single pass and doesn't need engine isolation.
	const __dirParent = path.dirname(fileURLToPath(import.meta.url));
	const rootParent = path.resolve(__dirParent, '..');
	const dbPathParent = path.join(rootParent, '.codegraph', 'graph.db');

	const { statsData: parentStats } = await import(srcImport(parentSrcDir, 'queries.js'));
	const { resolveImportsBatch: parentBatch, resolveImportPathJS: parentJS } = await import(
		srcImport(parentSrcDir, 'resolve.js')
	);
	const { isNativeAvailable: parentNativeCheck } = await import(
		srcImport(parentSrcDir, 'native.js')
	);

	const RUNS = 3;
	function median(arr) {
		const sorted = [...arr].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	}
	function round1(n) { return Math.round(n * 10) / 10; }

	function collectImportPairs() {
		const srcDir = path.join(rootParent, 'src');
		const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js'));
		const importRe = /(?:^|\n)\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
		const pairs = [];
		for (const file of files) {
			const absFile = path.join(srcDir, file);
			const content = fs.readFileSync(absFile, 'utf8');
			let match;
			while ((match = importRe.exec(content)) !== null) {
				pairs.push({ fromFile: absFile, importSource: match[1] });
			}
		}
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
		const timings = [];
		for (let i = 0; i < RUNS; i++) {
			const start = performance.now();
			parentBatch(inputs, rootParent, null);
			timings.push(performance.now() - start);
		}
		nativeBatchMs = round1(median(timings));
		perImportNativeMs = inputs.length > 0 ? round1(nativeBatchMs / inputs.length) : 0;
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

const { buildGraph } = await import(srcImport(srcDir, 'builder.js'));

// Redirect console.log to stderr so only JSON goes to stdout
const origLog = console.log;
console.log = (...args) => console.error(...args);

const RUNS = 3;
const PROBE_FILE = path.join(root, 'src', 'queries.js');

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
	await buildGraph(root, { engine, incremental: false });
	fullTimings.push(performance.now() - start);
}
const fullBuildMs = Math.round(median(fullTimings));

// No-op rebuild (nothing changed)
const noopTimings = [];
for (let i = 0; i < RUNS; i++) {
	const start = performance.now();
	await buildGraph(root, { engine, incremental: true });
	noopTimings.push(performance.now() - start);
}
const noopRebuildMs = Math.round(median(noopTimings));

// 1-file change rebuild
const original = fs.readFileSync(PROBE_FILE, 'utf8');
let oneFileRebuildMs;
let oneFilePhases = null;
try {
	const oneFileRuns = [];
	for (let i = 0; i < RUNS; i++) {
		fs.writeFileSync(PROBE_FILE, original + `\n// probe-${i}\n`);
		const start = performance.now();
		const res = await buildGraph(root, { engine, incremental: true });
		oneFileRuns.push({ ms: performance.now() - start, phases: res?.phases || null });
	}
	oneFileRuns.sort((a, b) => a.ms - b.ms);
	const medianRun = oneFileRuns[Math.floor(oneFileRuns.length / 2)];
	oneFileRebuildMs = Math.round(medianRun.ms);
	oneFilePhases = medianRun.phases;
} finally {
	fs.writeFileSync(PROBE_FILE, original);
	await buildGraph(root, { engine, incremental: true });
}

console.error(`  full=${fullBuildMs}ms noop=${noopRebuildMs}ms 1-file=${oneFileRebuildMs}ms`);

// Restore console.log for JSON output
console.log = origLog;

const workerResult = { fullBuildMs, noopRebuildMs, oneFileRebuildMs, oneFilePhases };
console.log(JSON.stringify(workerResult));

cleanup();
