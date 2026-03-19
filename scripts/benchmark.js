#!/usr/bin/env node

/**
 * Benchmark runner — measures codegraph performance on itself (dogfooding).
 *
 * Each engine (native / WASM) runs in a forked subprocess so that a segfault
 * in the native addon only kills the child — the parent survives and collects
 * partial results from whichever engines succeeded.
 *
 * Usage: node scripts/benchmark.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { resolveBenchmarkSource, srcImport } from './lib/bench-config.js';
import { isWorker, workerEngine, forkEngines } from './lib/fork-engine.js';

// ── Parent process: fork one child per engine, assemble final output ─────
if (!isWorker()) {
	const { version, cleanup: versionCleanup } = await resolveBenchmarkSource();
	const { wasm, native } = await forkEngines(import.meta.url, process.argv.slice(2));

	const primary = wasm || native;
	if (!primary) {
		console.error('Error: Both engines failed. No results to report.');
		versionCleanup();
		process.exit(1);
	}

	const result = {
		version,
		date: new Date().toISOString().slice(0, 10),
		files: primary.files,
		wasm: wasm
			? {
					buildTimeMs: wasm.buildTimeMs,
					queryTimeMs: wasm.queryTimeMs,
					nodes: wasm.nodes,
					edges: wasm.edges,
					dbSizeBytes: wasm.dbSizeBytes,
					perFile: wasm.perFile,
					noopRebuildMs: wasm.noopRebuildMs,
					oneFileRebuildMs: wasm.oneFileRebuildMs,
					oneFilePhases: wasm.oneFilePhases,
					queries: wasm.queries,
					phases: wasm.phases,
				}
			: null,
		native: native
			? {
					buildTimeMs: native.buildTimeMs,
					queryTimeMs: native.queryTimeMs,
					nodes: native.nodes,
					edges: native.edges,
					dbSizeBytes: native.dbSizeBytes,
					perFile: native.perFile,
					noopRebuildMs: native.noopRebuildMs,
					oneFileRebuildMs: native.oneFileRebuildMs,
					oneFilePhases: native.oneFilePhases,
					queries: native.queries,
					phases: native.phases,
				}
			: null,
	};

	console.log(JSON.stringify(result, null, 2));
	versionCleanup();
	process.exit(0);
}

// ── Worker process: benchmark a single engine, write JSON to stdout ──────
const engine = workerEngine();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const { srcDir, cleanup } = await resolveBenchmarkSource();

const dbPath = path.join(root, '.codegraph', 'graph.db');

const { buildGraph } = await import(srcImport(srcDir, 'builder.js'));
const { fnDepsData, fnImpactData, pathData, rolesData, statsData } = await import(
	srcImport(srcDir, 'queries.js')
);

const INCREMENTAL_RUNS = 3;
const QUERY_RUNS = 5;
const PROBE_FILE = path.join(root, 'src', 'queries.js');

function median(arr) {
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round1(n) {
	return Math.round(n * 10) / 10;
}

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

	if (rows.length === 0) return { hub: 'buildGraph', leaf: 'median' };
	return { hub: rows[0].name, leaf: rows[rows.length - 1].name };
}

// Redirect console.log to stderr so only JSON goes to stdout
const origLog = console.log;
console.log = (...args) => console.error(...args);

// Clean DB for a full build
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

const buildStart = performance.now();
const buildResult = await buildGraph(root, { engine, incremental: false });
const buildTimeMs = performance.now() - buildStart;

const queryStart = performance.now();
fnDepsData('buildGraph', dbPath);
const queryTimeMs = performance.now() - queryStart;

const stats = statsData(dbPath);
const totalFiles = stats.files.total;
const totalNodes = stats.nodes.total;
const totalEdges = stats.edges.total;
const dbSizeBytes = fs.statSync(dbPath).size;

// ── Incremental build tiers ─────────────────────────────────────────
console.error(`  [${engine}] Benchmarking no-op rebuild...`);
const noopTimings = [];
for (let i = 0; i < INCREMENTAL_RUNS; i++) {
	const start = performance.now();
	await buildGraph(root, { engine, incremental: true });
	noopTimings.push(performance.now() - start);
}
const noopRebuildMs = Math.round(median(noopTimings));

console.error(`  [${engine}] Benchmarking 1-file rebuild...`);
const original = fs.readFileSync(PROBE_FILE, 'utf8');
let oneFileRebuildMs;
let oneFilePhases = null;
try {
	const oneFileRuns = [];
	for (let i = 0; i < INCREMENTAL_RUNS; i++) {
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

// ── Query benchmarks ────────────────────────────────────────────────
console.error(`  [${engine}] Benchmarking queries...`);
const targets = selectTargets();
console.error(`    hub=${targets.hub}, leaf=${targets.leaf}`);

function benchQuery(fn, ...args) {
	const timings = [];
	for (let i = 0; i < QUERY_RUNS; i++) {
		const start = performance.now();
		fn(...args);
		timings.push(performance.now() - start);
	}
	return round1(median(timings));
}

const queries = {
	fnDepsMs: fnDepsData ? benchQuery(fnDepsData, targets.hub, dbPath, { depth: 3, noTests: true }) : null,
	fnImpactMs: fnImpactData ? benchQuery(fnImpactData, targets.hub, dbPath, { depth: 3, noTests: true }) : null,
	pathMs: pathData ? benchQuery(pathData, targets.hub, targets.leaf, dbPath, { noTests: true }) : null,
	rolesMs: rolesData ? benchQuery(rolesData, dbPath, { noTests: true }) : null,
};

// Restore console.log for JSON output
console.log = origLog;

const workerResult = {
	buildTimeMs: Math.round(buildTimeMs),
	queryTimeMs: Math.round(queryTimeMs * 10) / 10,
	nodes: totalNodes,
	edges: totalEdges,
	files: totalFiles,
	dbSizeBytes,
	perFile: {
		buildTimeMs: Math.round((buildTimeMs / totalFiles) * 10) / 10,
		nodes: Math.round((totalNodes / totalFiles) * 10) / 10,
		edges: Math.round((totalEdges / totalFiles) * 10) / 10,
		dbSizeBytes: Math.round(dbSizeBytes / totalFiles),
	},
	noopRebuildMs,
	oneFileRebuildMs,
	oneFilePhases,
	queries,
	phases: buildResult?.phases || null,
};

console.log(JSON.stringify(workerResult));

cleanup();
