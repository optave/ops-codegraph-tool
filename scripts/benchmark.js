#!/usr/bin/env node

/**
 * Benchmark runner — measures codegraph performance on itself (dogfooding).
 *
 * Runs both native (Rust) and WASM engines, outputs JSON to stdout
 * with raw and per-file normalized metrics for each.
 *
 * Usage: node scripts/benchmark.js
 */

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

// Import programmatic API (use file:// URLs for Windows compatibility)
const { buildGraph } = await import(srcImport(srcDir, 'builder.js'));
const { fnDepsData, fnImpactData, pathData, rolesData, statsData } = await import(
	srcImport(srcDir, 'queries.js')
);
const { isNativeAvailable } = await import(
	srcImport(srcDir, 'native.js')
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

/**
 * Pick hub (most-connected) and leaf (least-connected) non-test symbols from the DB.
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

	if (rows.length === 0) return { hub: 'buildGraph', leaf: 'median' };

	return { hub: rows[0].name, leaf: rows[rows.length - 1].name };
}

// Redirect console.log to stderr so only JSON goes to stdout
const origLog = console.log;
console.log = (...args) => console.error(...args);

async function benchmarkEngine(engine) {
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

	// ── Incremental build tiers (reuse existing DB from full build) ─────
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
	try {
		const oneFileTimings = [];
		for (let i = 0; i < INCREMENTAL_RUNS; i++) {
			fs.writeFileSync(PROBE_FILE, original + `\n// probe-${i}\n`);
			const start = performance.now();
			await buildGraph(root, { engine, incremental: true });
			oneFileTimings.push(performance.now() - start);
		}
		oneFileRebuildMs = Math.round(median(oneFileTimings));
	} finally {
		fs.writeFileSync(PROBE_FILE, original);
		await buildGraph(root, { engine, incremental: true });
	}

	// ── Query benchmarks (median of QUERY_RUNS each) ────────────────────
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

	return {
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
		queries,
		phases: buildResult?.phases || null,
	};
}

// ── Run benchmarks ───────────────────────────────────────────────────────
const wasm = await benchmarkEngine('wasm');

let native = null;
if (isNativeAvailable()) {
	native = await benchmarkEngine('native');
} else {
	console.error('Native engine not available — skipping native benchmark');
}

// Restore console.log for JSON output
console.log = origLog;

const result = {
	version,
	date: new Date().toISOString().slice(0, 10),
	files: wasm.files,
	wasm: {
		buildTimeMs: wasm.buildTimeMs,
		queryTimeMs: wasm.queryTimeMs,
		nodes: wasm.nodes,
		edges: wasm.edges,
		dbSizeBytes: wasm.dbSizeBytes,
		perFile: wasm.perFile,
		noopRebuildMs: wasm.noopRebuildMs,
		oneFileRebuildMs: wasm.oneFileRebuildMs,
		queries: wasm.queries,
		phases: wasm.phases,
	},
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
				queries: native.queries,
				phases: native.phases,
			}
		: null,
};

console.log(JSON.stringify(result, null, 2));

cleanup();
