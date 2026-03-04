#!/usr/bin/env node

/**
 * Incremental build benchmark — measures build tiers and import resolution.
 *
 * Measures full build, no-op rebuild, and single-file rebuild for both
 * native and WASM engines. Also benchmarks import resolution throughput:
 * native batch vs JS fallback.
 *
 * Usage: node scripts/incremental-benchmark.js > result.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolveBenchmarkSource, srcImport } from './lib/bench-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const { version, srcDir, cleanup } = await resolveBenchmarkSource();
const dbPath = path.join(root, '.codegraph', 'graph.db');

const { buildGraph } = await import(srcImport(srcDir, 'builder.js'));
const { statsData } = await import(srcImport(srcDir, 'queries.js'));
const { resolveImportPath, resolveImportsBatch, resolveImportPathJS } = await import(
	srcImport(srcDir, 'resolve.js')
);
const { isNativeAvailable } = await import(
	srcImport(srcDir, 'native.js')
);
const { isWasmAvailable } = await import(
	srcImport(srcDir, 'parser.js')
);

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

function round1(n) {
	return Math.round(n * 10) / 10;
}

/**
 * Benchmark build tiers for a given engine.
 */
async function benchmarkBuildTiers(engine) {
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
	try {
		const oneFileTimings = [];
		for (let i = 0; i < RUNS; i++) {
			fs.writeFileSync(PROBE_FILE, original + `\n// probe-${i}\n`);
			const start = performance.now();
			await buildGraph(root, { engine, incremental: true });
			oneFileTimings.push(performance.now() - start);
		}
		oneFileRebuildMs = Math.round(median(oneFileTimings));
	} finally {
		fs.writeFileSync(PROBE_FILE, original);
		// One final incremental build to restore DB state
		await buildGraph(root, { engine, incremental: true });
	}

	return { fullBuildMs, noopRebuildMs, oneFileRebuildMs };
}

/**
 * Collect all import pairs by scanning source files for ES import statements.
 */
function collectImportPairs() {
	const srcDir = path.join(root, 'src');
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

/**
 * Benchmark import resolution: native batch vs JS fallback.
 */
function benchmarkResolve(inputs) {
	const aliases = null; // codegraph itself has no path aliases

	// Native batch
	let nativeBatchMs = null;
	let perImportNativeMs = null;
	if (isNativeAvailable()) {
		const timings = [];
		for (let i = 0; i < RUNS; i++) {
			const start = performance.now();
			resolveImportsBatch(inputs, root, aliases);
			timings.push(performance.now() - start);
		}
		nativeBatchMs = round1(median(timings));
		perImportNativeMs = inputs.length > 0 ? round1(nativeBatchMs / inputs.length) : 0;
	}

	// JS fallback (call the exported JS implementation)
	const jsTimings = [];
	for (let i = 0; i < RUNS; i++) {
		const start = performance.now();
		for (const { fromFile, importSource } of inputs) {
			resolveImportPathJS(fromFile, importSource, root, aliases);
		}
		jsTimings.push(performance.now() - start);
	}
	const jsFallbackMs = round1(median(jsTimings));
	const perImportJsMs = inputs.length > 0 ? round1(jsFallbackMs / inputs.length) : 0;

	return {
		imports: inputs.length,
		nativeBatchMs,
		jsFallbackMs,
		perImportNativeMs,
		perImportJsMs,
	};
}

// ── Run benchmarks ───────────────────────────────────────────────────────
const hasWasm = isWasmAvailable();
const hasNative = isNativeAvailable();

if (!hasWasm && !hasNative) {
	console.error('Error: Neither WASM grammars nor native engine are available.');
	console.error('Run "npm run build:wasm" to build WASM grammars, or install the native platform package.');
	process.exit(1);
}

let wasm = null;
if (hasWasm) {
	console.error('Benchmarking WASM engine...');
	wasm = await benchmarkBuildTiers('wasm');
	console.error(`  full=${wasm.fullBuildMs}ms noop=${wasm.noopRebuildMs}ms 1-file=${wasm.oneFileRebuildMs}ms`);
} else {
	console.error('WASM grammars not built — skipping WASM benchmark');
}

let native = null;
if (hasNative) {
	console.error('Benchmarking native engine...');
	native = await benchmarkBuildTiers('native');
	console.error(`  full=${native.fullBuildMs}ms noop=${native.noopRebuildMs}ms 1-file=${native.oneFileRebuildMs}ms`);
} else {
	console.error('Native engine not available — skipping native build benchmark');
}

// Get file count from whichever graph was built last
const stats = statsData(dbPath);
const files = stats.files.total;

// Import resolution benchmark (uses existing graph)
console.error('Benchmarking import resolution...');
const inputs = collectImportPairs();
console.error(`  ${inputs.length} import pairs collected`);
const resolve = benchmarkResolve(inputs);
console.error(`  native=${resolve.nativeBatchMs}ms js=${resolve.jsFallbackMs}ms`);

// Restore console.log for JSON output
console.log = origLog;

const result = {
	version,
	date: new Date().toISOString().slice(0, 10),
	files,
	wasm: wasm
		? {
				fullBuildMs: wasm.fullBuildMs,
				noopRebuildMs: wasm.noopRebuildMs,
				oneFileRebuildMs: wasm.oneFileRebuildMs,
			}
		: null,
	native: native
		? {
				fullBuildMs: native.fullBuildMs,
				noopRebuildMs: native.noopRebuildMs,
				oneFileRebuildMs: native.oneFileRebuildMs,
			}
		: null,
	resolve,
};

console.log(JSON.stringify(result, null, 2));

cleanup();
