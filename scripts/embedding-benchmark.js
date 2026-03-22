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

import { fork } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { resolveBenchmarkSource, srcImport } from './lib/bench-config.js';

const MODEL_WORKER_KEY = '__BENCH_MODEL__';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// ── Worker process: benchmark a single model, write JSON to stdout ───────
if (process.env[MODEL_WORKER_KEY]) {
	const modelKey = process.env[MODEL_WORKER_KEY];

	const { srcDir, cleanup } = await resolveBenchmarkSource();
	const dbPath = path.join(root, '.codegraph', 'graph.db');

	const { buildEmbeddings, MODELS, searchData, disposeModel } = await import(
		srcImport(srcDir, 'embeddings/index.js')
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

	// Redirect console.log to stderr so only JSON goes to stdout
	const origLog = console.log;
	console.log = (...args) => console.error(...args);

	const symbols = loadSymbols();
	console.error(`  [${modelKey}] Loaded ${symbols.length} symbols`);

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
const dbPath = path.join(root, '.codegraph', 'graph.db');

const { MODELS } = await import(srcImport(srcDir, 'embeddings/index.js'));

const TIMEOUT_MS = 600_000;
const hasHfToken = !!process.env.HF_TOKEN;
const modelKeys = Object.keys(MODELS);
const results = {};
let symbolCount = 0;

const scriptPath = fileURLToPath(import.meta.url);

function forkModel(modelKey) {
	return new Promise((resolve) => {
		console.error(`\n[fork] Spawning ${modelKey} worker (pid isolation)...`);

		const child = fork(scriptPath, process.argv.slice(2), {
			env: { ...process.env, [MODEL_WORKER_KEY]: modelKey },
			stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
			timeout: TIMEOUT_MS,
		});

		let stdout = '';
		child.stdout.on('data', (chunk) => { stdout += chunk; });

		const timer = setTimeout(() => {
			console.error(`[fork] ${modelKey} worker timed out after ${TIMEOUT_MS / 1000}s — killing`);
			child.kill('SIGKILL');
		}, TIMEOUT_MS);

		child.on('close', (code, signal) => {
			clearTimeout(timer);

			if (signal) {
				console.error(`[fork] ${modelKey} worker killed by signal ${signal}`);
				resolve(null);
				return;
			}

			if (code !== 0) {
				console.error(`[fork] ${modelKey} worker exited with code ${code}`);
				try {
					const parsed = JSON.parse(stdout);
					console.error(`[fork] ${modelKey} worker produced partial results despite non-zero exit`);
					resolve(parsed);
				} catch {
					resolve(null);
				}
				return;
			}

			try {
				resolve(JSON.parse(stdout));
			} catch (err) {
				console.error(`[fork] ${modelKey} worker produced invalid JSON: ${err.message}`);
				resolve(null);
			}
		});

		child.on('error', (err) => {
			clearTimeout(timer);
			console.error(`[fork] ${modelKey} worker failed to start: ${err.message}`);
			resolve(null);
		});
	});
}

for (const key of modelKeys) {
	if (key === 'jina-code' && !hasHfToken) {
		console.error(`Skipping ${key} (HF_TOKEN not set)`);
		continue;
	}

	const data = await forkModel(key);
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

cleanup();
