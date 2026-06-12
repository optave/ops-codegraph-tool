#!/usr/bin/env node

/**
 * Embedding benchmark runner — measures search recall across all models.
 *
 * Each model runs in a forked subprocess so that a crash (OOM, WASM segfault
 * in the ONNX runtime) only kills the child — the parent survives and collects
 * partial results from whichever models succeeded.
 *
 * Usage: node scripts/embedding-benchmark.js > result.json
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { resolveBenchmarkSource, srcImport } from './lib/bench-config.js';
import { forkWorker } from './lib/fork-engine.js';

const MODEL_WORKER_KEY = '__BENCH_MODEL__';
/**
 * Per-model isolated DB path, set by the parent before forking each worker.
 *
 * The host project's .codegraph/graph.db is shared with any concurrent CLI
 * activity (e.g. a manual `codegraph embed` run kicked off while the bench
 * is in flight). Both writers race on the same `embeddings` table, so the
 * search phase ends up reading either zero rows ("No embeddings found.")
 * or vectors from the wrong model, both of which silently invalidate Hit@k.
 *
 * Each worker now operates on a fresh `VACUUM INTO` copy in os.tmpdir(),
 * leaving the host DB untouched and immune to interleaved CLI writes.
 */
const BENCH_DB_ENV = '__BENCH_DB_PATH__';
/**
 * Cap symbol count so CI stays under the per-model timeout.
 * At ~1500 symbols on a CPU-only runner, search evaluation takes ~5 min;
 * embedding all DB symbols takes ~18 min — ~23 min total, within the 30-min timeout.
 */
const MAX_SYMBOLS = 1500;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// ── Worker process: benchmark a single model, write JSON to stdout ───────
if (process.env[MODEL_WORKER_KEY]) {
	const modelKey = process.env[MODEL_WORKER_KEY];

	const { srcDir, cleanup } = await resolveBenchmarkSource();
	const dbPath = process.env[BENCH_DB_ENV];
	if (!dbPath) {
		console.error(`[${modelKey}] worker missing ${BENCH_DB_ENV} — parent must provide an isolated DB path`);
		process.exit(2);
	}

	const { buildEmbeddings, MODELS, searchData, disposeModel } = await import(
		srcImport(srcDir, 'domain/search/index.js')
	);

	const TEST_PATTERN = /\.(test|spec)\.|__test__|__tests__|\.stories\./;

	function splitIdentifier(name) {
		return name
			.replace(/([a-z])([A-Z])/g, '$1 $2')
			.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
			.replace(/[_-]+/g, ' ')
			.trim();
	}

	function loadSymbols() {
		const db = new Database(dbPath, { readonly: true });
		let rows = db
			.prepare(
				`SELECT name, kind, file FROM nodes WHERE kind IN ('function', 'method', 'class') ORDER BY file, line`,
			)
			.all();
		db.close();

		rows = rows.filter((r) => !TEST_PATTERN.test(r.file));

		const seen = new Set();
		const symbols = [];
		for (const row of rows) {
			if (seen.has(row.name)) continue;
			seen.add(row.name);
			const query = splitIdentifier(row.name);
			if (query.length < 4) continue;
			symbols.push({ name: row.name, kind: row.kind, file: row.file, query });
		}
		return symbols;
	}

	/**
	 * Deterministic shuffle using a simple seeded PRNG (mulberry32).
	 * Keeps results reproducible across runs while sampling fairly.
	 */
	function seededShuffle<T>(arr: T[], seed: number): T[] {
		const out = arr.slice();
		let s = seed | 0;
		for (let i = out.length - 1; i > 0; i--) {
			s = (s + 0x6d2b79f5) | 0;
			let t = Math.imul(s ^ (s >>> 15), 1 | s);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			const j = Math.floor(r * (i + 1));
			[out[i], out[j]] = [out[j], out[i]];
		}
		return out;
	}

	// Redirect console.log to stderr so only JSON goes to stdout
	const origLog = console.log;
	console.log = (...args) => console.error(...args);

	let symbols = loadSymbols();
	if (symbols.length > MAX_SYMBOLS) {
		console.error(`  [${modelKey}] Sampling ${MAX_SYMBOLS} of ${symbols.length} symbols (deterministic seed=42)`);
		symbols = seededShuffle(symbols, 42).slice(0, MAX_SYMBOLS);
	}
	console.error(`  [${modelKey}] Benchmarking ${symbols.length} symbols`);

	const embedStart = performance.now();
	await buildEmbeddings(root, modelKey, dbPath, { strategy: 'structured' });
	const embedTimeMs = Math.round(performance.now() - embedStart);

	let hits1 = 0;
	let hits3 = 0;
	let hits5 = 0;
	let hits10 = 0;

	const searchStart = performance.now();
	for (const { name, query } of symbols) {
		const data = await searchData(query, dbPath, { minScore: 0.01, limit: 10 });
		if (!data) continue;

		const names = data.results.map((r) => r.name);
		const rank = names.indexOf(name) + 1;
		if (rank === 1) hits1++;
		if (rank >= 1 && rank <= 3) hits3++;
		if (rank >= 1 && rank <= 5) hits5++;
		if (rank >= 1 && rank <= 10) hits10++;
	}
	const searchTimeMs = Math.round(performance.now() - searchStart);

	try { await disposeModel(); } catch { /* best-effort */ }

	const total = symbols.length;
	const modelResult = {
		dim: MODELS[modelKey].dim,
		contextWindow: MODELS[modelKey].contextWindow,
		hits1,
		hits3,
		hits5,
		hits10,
		misses: total - hits10,
		total,
		embedTimeMs,
		searchTimeMs,
	};

	console.log = origLog;
	console.log(JSON.stringify({ symbols: symbols.length, result: modelResult }));

	cleanup();
	process.exit(0);
}

// ── Parent process: fork one child per model, assemble final output ──────
const { version, srcDir, cleanup } = await resolveBenchmarkSource();
const hostDbPath = path.join(root, '.codegraph', 'graph.db');
if (!fs.existsSync(hostDbPath)) {
	throw new Error(`Host graph DB not found at ${hostDbPath}. Run "codegraph build" first.`);
}

// Per-model isolated copies live under a single tmp dir. Each iteration
// removes its file after the worker returns; the dir is wiped on exit as a
// safety net so a crash mid-loop can't leak the in-flight copy.
const benchTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-embed-bench-'));
let cleanedUpTmpDir = false;
function cleanupBenchDbs() {
	if (cleanedUpTmpDir) return;
	cleanedUpTmpDir = true;
	try { fs.rmSync(benchTmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}
process.on('exit', cleanupBenchDbs);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
	// `once` so the re-raise below hits Node's default disposition instead of
	// re-entering this handler. Without it, `process.kill(pid, sig)` would
	// fire our listener again and loop forever.
	process.once(sig, () => {
		cleanupBenchDbs();
		process.kill(process.pid, sig);
	});
}

const { MODELS } = await import(srcImport(srcDir, 'domain/search/index.js'));

// Default: 30 min (warm, models cached). CI sets BENCHMARK_TIMEOUT_MS=5400000
// on a cache miss so cold-start downloads don't kill the worker prematurely.
const _envTimeout = Number(process.env.BENCHMARK_TIMEOUT_MS);
const TIMEOUT_MS = _envTimeout > 0 ? _envTimeout : 1_800_000;
const modelKeys = Object.keys(MODELS);
const results = {};
let symbolCount = 0;

const scriptPath = fileURLToPath(import.meta.url);

for (const key of modelKeys) {
	// VACUUM INTO produces a transactionally-consistent snapshot — safe even
	// if another process is writing the host DB. Fresh copy per model keeps a
	// crashed worker from leaking partial state into the next one.
	const modelDbPath = path.join(benchTmpDir, `${key}.db`);
	try {
		const srcDb = new Database(hostDbPath, { readonly: true });
		try {
			// SQLite does not support bound parameters in VACUUM INTO — the
			// destination must be a string literal. Single-quote doubling is the
			// correct and complete escape; no other characters are special in
			// SQLite string literals.
			srcDb.exec(`VACUUM INTO '${modelDbPath.replace(/'/g, "''")}'`);
		} finally {
			srcDb.close();
		}
	} catch (err) {
		console.error(`  ${key}: FAILED to snapshot host DB — ${(err as Error).message}`);
		continue;
	}

	process.env[BENCH_DB_ENV] = modelDbPath;
	const data = await forkWorker(scriptPath, MODEL_WORKER_KEY, key, process.argv.slice(2), TIMEOUT_MS);
	delete process.env[BENCH_DB_ENV];
	// `openDb` enables WAL mode, so the worker leaves `${key}.db-wal` and
	// `${key}.db-shm` sidecars next to the main snapshot. Remove all three so
	// disk usage doesn't accumulate across models — the directory-level
	// cleanup at exit is only a safety net.
	for (const suffix of ['', '-wal', '-shm']) {
		try { fs.rmSync(`${modelDbPath}${suffix}`, { force: true }); } catch { /* best-effort */ }
	}

	if (data) {
		results[key] = data.result;
		if (data.symbols) symbolCount = data.symbols;
		const r = data.result;
		console.error(
			`  Hit@1=${r.hits1}/${r.total} Hit@3=${r.hits3}/${r.total} Hit@5=${r.hits5}/${r.total} misses=${r.misses}`,
		);
	} else {
		console.error(`  ${key}: FAILED (worker crashed or timed out)`);
	}
}

const output = {
	version,
	date: new Date().toISOString().slice(0, 10),
	strategy: 'structured',
	symbols: symbolCount,
	models: results,
};

console.log(JSON.stringify(output, null, 2));

cleanupBenchDbs();
cleanup();
