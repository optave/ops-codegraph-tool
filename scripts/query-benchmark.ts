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
import { resolveBenchmarkExcludes, resolveBenchmarkSource, srcImport } from './lib/bench-config.js';
import { isWorker, workerEngine, workerTargets, forkEngines } from './lib/fork-engine.js';
import { round1, timeMedian } from './lib/bench-timing.js';
import { selectHubTargets, type HubTargets } from './lib/hub-selection.js';

// ── Parent process: fork one child per engine, assemble final output ─────
if (!isWorker()) {
	const __parentDir = path.dirname(fileURLToPath(import.meta.url));
	const __parentRoot = path.resolve(__parentDir, '..');

	const { version, cleanup: versionCleanup } = await resolveBenchmarkSource();
	let wasm, native;
	try {
		({ wasm, native } = await forkEngines(import.meta.url, process.argv.slice(2)));
	} catch (err) {
		console.error(`Error: ${err.message}`);
		versionCleanup();
		process.exit(1);
	}

	// Safety net: if a worker was killed mid-benchDiffImpact, the git staging
	// area may be dirty.  Unstage any leftover changes so subsequent runs and
	// unrelated git operations aren't affected.
	try {
		const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
			cwd: __parentRoot, encoding: 'utf8',
		}).trim();
		if (staged) {
			console.error('[fork] Cleaning up leftover staged files from crashed worker');
			execFileSync('git', ['restore', '--staged', '.'], { cwd: __parentRoot, stdio: 'pipe' });
			execFileSync('git', ['checkout', '.'], { cwd: __parentRoot, stdio: 'pipe' });
		}
	} catch { /* git not available or no repo — safe to ignore */ }

	const primary = wasm || native;
	if (!primary) {
		console.error('Error: Both engines failed. No results to report.');
		versionCleanup();
		process.exit(1);
	}

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
	versionCleanup();
	process.exit(0);
}

// ── Worker process: benchmark a single engine, write JSON to stdout ──────
const engine = workerEngine();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const { srcDir, cleanup } = await resolveBenchmarkSource();
const dbPath = path.join(root, '.codegraph', 'graph.db');

const { buildGraph } = await import(srcImport(srcDir, 'domain/graph/builder.js'));
const { fnDepsData, fnImpactData, diffImpactData } = await import(
	srcImport(srcDir, 'domain/queries.js')
);
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

// First 2-3 native fnDeps calls per process pay a cold-start cost (rusqlite
// statement-cache warmup, OS page cache for the DB file, NAPI-side static
// init from tree-sitter's transitive crates linked into the .node binary).
// On Linux x86_64 CI, that pulled median(5) into cold-start territory once
// tree-sitter 0.25 grew the binary's init footprint (#1076), even though
// steady-state per-call latency is unchanged. Discard the first WARMUP_RUNS
// before timing so the metric reflects warm-call latency, not cold-start.
const WARMUP_RUNS = 3;

// Pinned hub targets — stable function names that exist across versions.
// Auto-selecting the most-connected node makes version-to-version comparison
// meaningless when barrel/type files get added or removed.
const PINNED_HUB_CANDIDATES = ['buildGraph', 'openDb', 'loadConfig'];

async function benchDepths(fn, name, depths) {
	const result = {};
	for (const depth of depths) {
		for (let i = 0; i < WARMUP_RUNS; i++) {
			fn(name, dbPath, { depth, noTests: true });
		}
		result[`depth${depth}Ms`] = round1(
			await timeMedian(() => fn(name, dbPath, { depth, noTests: true }), RUNS),
		);
	}
	return result;
}

/**
 * Resolve a file path from the DB to an absolute path.
 * Handles relative paths (normal) and absolute-like paths without leading '/'
 * (observed on CI when the npm-installed buildGraph stores full paths).
 */
function resolveDbFile(rootDir: string, dbFile: string): string | null {
	if (path.isAbsolute(dbFile)) return fs.existsSync(dbFile) ? dbFile : null;
	const joined = path.join(rootDir, dbFile);
	if (fs.existsSync(joined)) return joined;
	// DB may store an absolute path without the leading '/'
	const withSlash = '/' + dbFile;
	if (fs.existsSync(withSlash)) return withSlash;
	return null;
}

async function benchDiffImpact(targets: HubTargets) {
	// Reuse the exact physical node selectHubTargets already resolved for
	// `targets.hub` instead of re-querying `nodes` by name — a second,
	// independently unfiltered query can disagree with the first about which
	// same-named node "the hub" is (#1904).
	//
	// targets.hubFile is normally relative (e.g. 'src/domain/builder.ts'), but
	// some environments store absolute-like paths without the leading '/'.
	// Handle both cases so the benchmark works regardless of DB path format.
	const hubFile = resolveDbFile(root, targets.hubFile);
	if (!hubFile) {
		console.error(`[benchDiffImpact] Cannot find hub file for hubFile=${targets.hubFile}`);
		return { latencyMs: 0, affectedFunctions: 0, affectedFiles: 0 };
	}
	const original = fs.readFileSync(hubFile, 'utf8');

	try {
		fs.writeFileSync(hubFile, original + '\n// benchmark-probe\n');
		execFileSync('git', ['add', hubFile], { cwd: root, stdio: 'pipe' });

		let lastResult = null;
		const latencyMs = round1(
			await timeMedian(() => {
				lastResult = diffImpactData(dbPath, { staged: true, depth: 3, noTests: true });
			}, RUNS),
		);

		return {
			latencyMs,
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
await buildGraph(root, { engine, incremental: false, exclude: [...resolveBenchmarkExcludes()] });

const targets: HubTargets = workerTargets() || selectHubTargets(dbPath, PINNED_HUB_CANDIDATES);
console.error(`Targets: hub=${targets.hub}, mid=${targets.mid}, leaf=${targets.leaf}`);

const fnDeps = {};
const fnImpact = {};

fnDeps.depth1Ms = (await benchDepths(fnDepsData, targets.hub, [1])).depth1Ms;
fnDeps.depth3Ms = (await benchDepths(fnDepsData, targets.hub, [3])).depth3Ms;
fnDeps.depth5Ms = (await benchDepths(fnDepsData, targets.hub, [5])).depth5Ms;

fnImpact.depth1Ms = (await benchDepths(fnImpactData, targets.hub, [1])).depth1Ms;
fnImpact.depth3Ms = (await benchDepths(fnImpactData, targets.hub, [3])).depth3Ms;
fnImpact.depth5Ms = (await benchDepths(fnImpactData, targets.hub, [5])).depth5Ms;

const diffImpact = await benchDiffImpact(targets);

// Restore console.log for JSON output
console.log = origLog;

const workerResult = { targets, fnDeps, fnImpact, diffImpact };
console.log(JSON.stringify(workerResult));

await disposeParsers();
cleanup();
process.exit(0);
