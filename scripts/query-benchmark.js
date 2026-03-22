#!/usr/bin/env node

/**
 * Query benchmark runner — measures query depth scaling and diff-impact latency.
 *
 * Each engine (native / WASM) runs in a forked subprocess so that a segfault
 * in the native addon only kills the child — the parent survives and collects
 * partial results from whichever engines succeeded.
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
import { isWorker, workerEngine, forkEngines } from './lib/fork-engine.js';

// ── Parent process: fork one child per engine, assemble final output ─────
if (!isWorker()) {
	const { version } = await resolveBenchmarkSource();
	const { wasm, native } = await forkEngines(import.meta.url, process.argv.slice(2));

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
	process.exit(0);
}

// ── Worker process: benchmark a single engine, write JSON to stdout ──────
const engine = workerEngine();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const { srcDir, cleanup } = await resolveBenchmarkSource();
const dbPath = path.join(root, '.codegraph', 'graph.db');

const { buildGraph } = await import(srcImport(srcDir, 'builder.js'));
const { fnDepsData, fnImpactData, diffImpactData } = await import(
	srcImport(srcDir, 'queries.js')
);

// Redirect console.log to stderr so only JSON goes to stdout
const origLog = console.log;
console.log = (...args) => console.error(...args);

const RUNS = 5;

function median(arr) {
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round1(n) {
	return Math.round(n * 10) / 10;
}

// Pinned hub targets — stable function names that exist across versions.
// Auto-selecting the most-connected node makes version-to-version comparison
// meaningless when barrel/type files get added or removed.
const PINNED_HUB_CANDIDATES = ['buildGraph', 'openDb', 'loadConfig'];

function selectTargets() {
	const db = new Database(dbPath, { readonly: true });

	// Try pinned candidates first for a stable hub across versions
	let hub = null;
	for (const candidate of PINNED_HUB_CANDIDATES) {
		const row = db
			.prepare(
				`SELECT n.name FROM nodes n
         JOIN edges e ON e.source_id = n.id OR e.target_id = n.id
         WHERE n.name = ? AND n.file NOT LIKE '%test%' AND n.file NOT LIKE '%spec%'
         LIMIT 1`,
			)
			.get(candidate);
		if (row) {
			hub = row.name;
			break;
		}
	}

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

	// Fall back to most-connected if no pinned candidate found
	if (!hub) hub = rows[0].name;

	const mid = rows[Math.floor(rows.length / 2)].name;
	const leaf = rows[rows.length - 1].name;
	return { hub, mid, leaf };
}

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

function benchDiffImpact(hubName) {
	const db = new Database(dbPath, { readonly: true });
	const row = db
		.prepare(`SELECT file FROM nodes WHERE name = ? LIMIT 1`)
		.get(hubName);
	db.close();

	if (!row) return { latencyMs: 0, affectedFunctions: 0, affectedFiles: 0 };

	const hubFile = path.join(root, row.file);
	const original = fs.readFileSync(hubFile, 'utf8');

	try {
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
		execFileSync('git', ['restore', '--staged', hubFile], { cwd: root, stdio: 'pipe' });
		fs.writeFileSync(hubFile, original);
	}
}

// Build graph for this engine
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
await buildGraph(root, { engine, incremental: false });

const targets = selectTargets();
console.error(`Targets: hub=${targets.hub}, mid=${targets.mid}, leaf=${targets.leaf}`);

const fnDeps = {};
const fnImpact = {};

fnDeps.depth1Ms = benchDepths(fnDepsData, targets.hub, [1]).depth1Ms;
fnDeps.depth3Ms = benchDepths(fnDepsData, targets.hub, [3]).depth3Ms;
fnDeps.depth5Ms = benchDepths(fnDepsData, targets.hub, [5]).depth5Ms;

fnImpact.depth1Ms = benchDepths(fnImpactData, targets.hub, [1]).depth1Ms;
fnImpact.depth3Ms = benchDepths(fnImpactData, targets.hub, [3]).depth3Ms;
fnImpact.depth5Ms = benchDepths(fnImpactData, targets.hub, [5]).depth5Ms;

const diffImpact = benchDiffImpact(targets.hub);

// Restore console.log for JSON output
console.log = origLog;

const workerResult = { targets, fnDeps, fnImpact, diffImpact };
console.log(JSON.stringify(workerResult));

cleanup();
