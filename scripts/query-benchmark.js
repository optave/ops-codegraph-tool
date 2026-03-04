#!/usr/bin/env node

/**
 * Query benchmark runner — measures query depth scaling and diff-impact latency.
 *
 * Dynamically selects hub/mid/leaf targets from the graph, then benchmarks
 * fnDepsData and fnImpactData at depth 1, 3, 5 plus diffImpactData with a
 * synthetic staged change. Runs against both native and WASM engine-built
 * graphs to catch structural differences.
 *
 * Usage: node scripts/query-benchmark.js > result.json
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { resolveBenchmarkSource, srcImport } from './lib/bench-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const { version, srcDir, cleanup } = await resolveBenchmarkSource();
const dbPath = path.join(root, '.codegraph', 'graph.db');

const { buildGraph } = await import(srcImport(srcDir, 'builder.js'));
const { fnDepsData, fnImpactData, diffImpactData, statsData } = await import(
	srcImport(srcDir, 'queries.js')
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

const RUNS = 5;
const DEPTHS = [1, 3, 5];

function median(arr) {
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round1(n) {
	return Math.round(n * 10) / 10;
}

/**
 * Select hub / mid / leaf targets dynamically from the graph.
 */
function selectTargets() {
	const db = new Database(dbPath, { readonly: true });
	const rows = db
		.prepare(
			`SELECT n.name, COUNT(e.id) AS cnt
       FROM nodes n
       JOIN edges e ON e.source_id = n.id OR e.target_id = n.id
       WHERE n.file NOT LIKE '%test%' AND n.file NOT LIKE '%spec%'
       GROUP BY n.id
       ORDER BY cnt DESC`,
		)
		.all();
	db.close();

	if (rows.length === 0) throw new Error('No nodes with edges found in graph');

	const hub = rows[0].name;
	const mid = rows[Math.floor(rows.length / 2)].name;
	const leaf = rows[rows.length - 1].name;
	return { hub, mid, leaf };
}

/**
 * Benchmark a single query function at multiple depths.
 */
function benchDepths(fn, name, depths) {
	const result = {};
	for (const depth of depths) {
		const timings = [];
		for (let i = 0; i < RUNS; i++) {
			const start = performance.now();
			fn(name, dbPath, { depth, noTests: true });
			timings.push(performance.now() - start);
		}
		result[`depth${depth}Ms`] = round1(median(timings));
	}
	return result;
}

/**
 * Benchmark diff-impact with a synthetic staged change on the hub file.
 */
function benchDiffImpact(hubName) {
	// Find the file that contains the hub symbol
	const db = new Database(dbPath, { readonly: true });
	const row = db
		.prepare(`SELECT file FROM nodes WHERE name = ? LIMIT 1`)
		.get(hubName);
	db.close();

	if (!row) return { latencyMs: 0, affectedFunctions: 0, affectedFiles: 0 };

	const hubFile = path.join(root, row.file);
	const original = fs.readFileSync(hubFile, 'utf8');

	try {
		// Append a probe comment and stage it
		fs.writeFileSync(hubFile, original + '\n// benchmark-probe\n');
		execFileSync('git', ['add', hubFile], { cwd: root, stdio: 'pipe' });

		const timings = [];
		let lastResult = null;
		for (let i = 0; i < RUNS; i++) {
			const start = performance.now();
			lastResult = diffImpactData(dbPath, { staged: true, depth: 3, noTests: true });
			timings.push(performance.now() - start);
		}

		return {
			latencyMs: round1(median(timings)),
			affectedFunctions: lastResult?.affectedFunctions?.length || 0,
			affectedFiles: lastResult?.affectedFiles?.length || 0,
		};
	} finally {
		// Restore: unstage + revert content
		execFileSync('git', ['restore', '--staged', hubFile], { cwd: root, stdio: 'pipe' });
		fs.writeFileSync(hubFile, original);
	}
}

/**
 * Run all query benchmarks against the current graph.
 */
function benchmarkQueries(targets) {
	const fnDeps = {};
	const fnImpact = {};

	// Run depth benchmarks on hub target (most connected — worst case)
	fnDeps.depth1Ms = benchDepths(fnDepsData, targets.hub, [1]).depth1Ms;
	fnDeps.depth3Ms = benchDepths(fnDepsData, targets.hub, [3]).depth3Ms;
	fnDeps.depth5Ms = benchDepths(fnDepsData, targets.hub, [5]).depth5Ms;

	fnImpact.depth1Ms = benchDepths(fnImpactData, targets.hub, [1]).depth1Ms;
	fnImpact.depth3Ms = benchDepths(fnImpactData, targets.hub, [3]).depth3Ms;
	fnImpact.depth5Ms = benchDepths(fnImpactData, targets.hub, [5]).depth5Ms;

	const diffImpact = benchDiffImpact(targets.hub);

	return { targets, fnDeps, fnImpact, diffImpact };
}

// ── Run benchmarks ───────────────────────────────────────────────────────
const hasWasm = isWasmAvailable();
const hasNative = isNativeAvailable();

if (!hasWasm && !hasNative) {
	console.error('Error: Neither WASM grammars nor native engine are available.');
	console.error('Run "npm run build:wasm" to build WASM grammars, or install the native platform package.');
	process.exit(1);
}

// Build with first available engine to select targets, then reuse for both
let targets = null;
let wasm = null;
if (hasWasm) {
	if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
	await buildGraph(root, { engine: 'wasm', incremental: false });

	targets = selectTargets();
	console.error(`Targets: hub=${targets.hub}, mid=${targets.mid}, leaf=${targets.leaf}`);
	wasm = benchmarkQueries(targets);
} else {
	console.error('WASM grammars not built — skipping WASM benchmark');
}

let native = null;
if (hasNative) {
	if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
	await buildGraph(root, { engine: 'native', incremental: false });

	if (!targets) {
		targets = selectTargets();
		console.error(`Targets: hub=${targets.hub}, mid=${targets.mid}, leaf=${targets.leaf}`);
	}
	native = benchmarkQueries(targets);
} else {
	console.error('Native engine not available — skipping native benchmark');
}

// Restore console.log for JSON output
console.log = origLog;

const result = {
	version,
	date: new Date().toISOString().slice(0, 10),
	wasm: wasm
		? {
				targets: wasm.targets,
				fnDeps: wasm.fnDeps,
				fnImpact: wasm.fnImpact,
				diffImpact: wasm.diffImpact,
			}
		: null,
	native: native
		? {
				targets: native.targets,
				fnDeps: native.fnDeps,
				fnImpact: native.fnImpact,
				diffImpact: native.diffImpact,
			}
		: null,
};

console.log(JSON.stringify(result, null, 2));

cleanup();
